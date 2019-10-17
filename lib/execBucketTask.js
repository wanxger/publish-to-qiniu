const fs = require('fs');
const path = require('path');
const upath= require('upath');
const glob = require('glob');
const qiniu = require('qiniu');
const ora = require('ora');

const getEtag = require('./getEtag');

const resolvePath = require('./resolvePath');

module.exports = function execBucketTask({ accessKey, secretKey, bucket, hosts, tasks }, { refresh }) {
  let spinner = null;

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);

  let zone = null;

  const fileMap = new Map();

  return Promise
    .resolve()
    .then(
      () => {
        spinner = ora('Determining zone')
          .start();
        return new Promise(
          (resolve, reject) => {
            qiniu.zone.getZoneInfo(
              accessKey,
              bucket,
              (err, zoneInfo) => {
                if (err) {
                  reject({
                    message: 'Determine zone failed',
                    error: err
                  });
                  return;
                }

                zone = zoneInfo;

                spinner
                  .succeed('Determine zone successed');

                resolve();
              }
            );
          }
        );
      }
    )
    .then(
      // 读取所有文件
      () => {
        spinner = ora('Loading files')
          .start();

        return Promise.all(
          tasks.map(
            ({ from, to }) => {
              return new Promise(
                (resolve, reject) => {

                  const srcFolderPath = resolvePath(from);
                  const startPos = srcFolderPath.length + 1;

                  glob(
                    path.join(srcFolderPath, '**/*'),
                    {
                      nodir: true
                    },
                    (err, srcFilePaths) => {
                      if (err) {
                        reject({
                          message: 'Load files failed',
                          error: err
                        });
                        return;
                      }

                      srcFilePaths
                        .forEach(
                          srcFilePath => {
                            const filePath = srcFilePath.slice(startPos);
                            const distFilePath = path.join(to, filePath);

                            fileMap.set(
                              filePath,
                              {
                                srcPath: srcFilePath,
                                distPath: upath.toUnix(distFilePath)
                              }
                            );
                          }
                        );

                      resolve();
                    }
                  );
                }
              );
            }
          )
        )
        .then(
          () => {
            spinner
              .succeed(`Load files successed, ${fileMap.size} founded`);
          }
        );
      }
    )
    .then(
      // 计算所有文件的hash
      () => {
        spinner = ora('Checking files status')
          .start();
        return Promise.all(
          [...fileMap.keys()].map(
            filePath => {
              return new Promise(
                (resolve, reject) => {
                  const file = fileMap.get(filePath);
                  const srcFilePath = file.srcPath;

                  getEtag(
                    fs.readFileSync(srcFilePath),
                    hash => {
                      file.hash = hash;
                      resolve();
                    }
                  );
                }
              );
            }
          )
        );
      }
    )
    .then(
      // 比对所有文件的hash
      () => {
        const filePaths = [...fileMap.keys()];

        const resFilePaths = [];

        let overrideFileCount = 0;

        return new Promise(
          (resolve, reject) => {

            function compareHash() {
              const curFilePaths = filePaths.splice(0, 1000);

              if (curFilePaths.length === 0) {
                resolve();
                return;
              }

              const config = new qiniu.conf.Config();
              const bucketManager = new qiniu.rs.BucketManager(mac, config);

              bucketManager
                .batch(
                  curFilePaths.map(
                    curFilePath => {
                      return qiniu.rs.statOp(
                        bucket,
                        fileMap.get(curFilePath).distPath
                      );
                    }
                  ),
                  (err, respBody, respInfo) => {
                    if (err) {
                      reject({
                        message: 'Check files status failed',
                        error: err
                      });
                      return;
                    }

                    if (
                      parseInt(respInfo.statusCode / 100) !== 2
                    ) {
                      reject({
                        message: `Check files status failed, code ${respInfo.statusCode}`,
                        error: respBody
                      });
                      return;
                    }

                    respBody
                      .forEach(
                        (resp, i) => {
                          const curFilePath = curFilePaths[i];
                          const file = fileMap.get(curFilePath);
                          if (resp.code !== 200 || resp.data.hash !== file.hash) {
                            if (resp.code === 200 && resp.data.hash !== file.hash) {
                              // 是覆盖
                              file.isOverride = true;
                              overrideFileCount++;
                            }
                            resFilePaths.push(curFilePath);
                          }
                        }
                      );

                    compareHash();
                  }
                );
            }

            compareHash();
          }
        )
        .then(
          () => {
            spinner.succeed(`Check files status successed, ${resFilePaths.length - overrideFileCount} created, ${overrideFileCount} modified, ${fileMap.size - resFilePaths.length} unmodifed`);

            return resFilePaths;
          }
        );
      }
    )
    .then(
      // 上传文件
      filePaths => {
        spinner = ora('Uploading files')
          .start();

        if (filePaths.length === 0) {
          spinner.info('Upload files skipped');
          return [];
        }

        const resFilePaths = [];

        return new Promise(
          (resolve, reject) => {

            function upload() {
              const filePath = filePaths.pop();

              if (!filePath) {
                resolve();
                return;
              }

              const file = fileMap.get(filePath);

              if (file.isOverride) {
                // 只有需要覆盖的文件需要refreshUrl
                resFilePaths.push(filePath);
              }

              const uploadToken = new qiniu.rs.PutPolicy(
                {
                  scope: file.isNew ? bucket : bucket + ':' + file.distPath
                }
              )
                .uploadToken(mac);

              const config = new qiniu.conf.Config();
              config.zone = zone;

              const formUploader = new qiniu.form_up.FormUploader(config);

              formUploader.putFile(
                uploadToken,
                file.distPath,
                file.srcPath,
                new qiniu.form_up.PutExtra(),
                (err, respBody, respInfo) => {
                  if (err) {
                    reject({
                      message: 'Upload files failed',
                      error: err
                    });
                    return;
                  }

                  if (respInfo.statusCode === 200) {
                    upload();
                  } else {
                    reject({
                      message: `Upload files failed, code ${respInfo.statusCode}`,
                      error: respBody
                    });
                  }
                }
              );
            }

            upload();

          }
        )
        .then(
          () => {
            spinner.succeed('Upload files successed');
            return resFilePaths;
          }
        );
      }
    )
    .then(
      // 更新发生变更的文件的url
      filePaths => {
        spinner = ora('Refreshing urls')
          .start();
        
        if (filePaths.length === 0) {
          spinner.info('Refresh urls skipped');
          return;
        }

        if (!refresh) {
          spinner.info('Refresh urls skipped by command');
          return;
        }

        const urls = [];

        hosts.forEach(host => {
          urls.push(host + "/");
        });

        filePaths
          .forEach(
            filePath => {
              hosts
                .forEach(
                  host => {
                    urls.push(
                      host + '/' + fileMap.get(filePath).distPath
                    );
                  }
                );
            }
          );

        return new Promise(
          (resolve, reject) => {
            function refreshUrl() {
              const curUrls = urls.splice(0, 100);

              if (curUrls.length === 0) {
                resolve();
                return;
              }

              const cdnManager = new qiniu.cdn.CdnManager(mac);

              console.log('待刷新链接组如下');

              console.log('----------');

              for (const curUrl of curUrls) {
                console.log(curUrl);
              }

              console.log('----------');
              
              cdnManager.refreshUrls(
                curUrls,
                (err, respBody, respInfo) => {
                  if (err) {
                    reject({
                      message: 'Refresh urls failed',
                      error: err
                    });
                    return;
                  }

                  if (respInfo.statusCode === 200) {
                    refreshUrl();
                  } else {
                    reject({
                      message: `Refresh urls failed, code ${respInfo.statusCode}`,
                      error: JSON.parse(respBody)
                    });
                  }
                }
              );
            }

            refreshUrl();
          }
        )
        .then(
          () => {
            spinner.succeed('Refresh urls successed');
          }
        );
      }
    )
    .catch(
      e => {
        spinner.fail(e.message);

        throw e.error;
      }
    );
};