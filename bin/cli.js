#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const program = require('commander');
const glob = require('glob');
const qiniu = require('qiniu');
const ora = require('ora');

const getEtag = require('../lib/getEtag');

const workspacePath = process.cwd();

program
  .version(require('../package').version)
  .usage('[options]')
  .parse(process.argv);

const { accessKey, secretKey, bucket, hosts, tasks } = require(path.join(workspacePath, 'package.json')).publishToQiniu;

var mac = new qiniu.auth.digest.Mac(accessKey, secretKey);

const fileMap = new Map();

let spinner;

Promise
  .resolve()
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

                const srcFolderPath = path.join(workspacePath, from);
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
                              distPath: distFilePath
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
      );
    }
  )
  .then(
    // 计算所有文件的hash
    () => {
      spinner
        .succeed(`Load files successed, ${fileMap.size} founded`);

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
      const config = new qiniu.conf.Config();
      const bucketManager = new qiniu.rs.BucketManager(mac, config);

      let overrideFileCount = 0;

      const tasks = [];
      const filePaths = [...fileMap.keys()];
      const resFilePaths = [];
      while (filePaths.length) {
        const curFilePaths = filePaths.splice(0, 1000);
        tasks.push(
          new Promise(
            (resolve, reject) => {
              bucketManager
                .batch(
                  curFilePaths.map(curFilePath => {
                    return qiniu.rs.statOp(bucket, fileMap.get(curFilePath).distPath);
                  }),
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
                    resolve();
                  }
                );
            }
          )
        );
      }

      return Promise.all(tasks)
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

      const config = new qiniu.conf.Config();
      const formUploader = new qiniu.form_up.FormUploader(config);
      const putExtra = new qiniu.form_up.PutExtra();

      const resFilePaths = [];

      return Promise.all(
        filePaths
          .map(
            filePath => {
              const file = fileMap.get(filePath);

              if (file.isOverride) {
                // 只有需要覆盖的文件需要refreshUrl
                resFilePaths.push(filePath);
              }

              var uploadToken = new qiniu.rs.PutPolicy(
                {
                  scope: file.isNew ? bucket : bucket + ':' + file.distPath
                }
              )
                .uploadToken(mac);

              return new Promise(
                (resolve, reject) => {
                  formUploader.putFile(
                    uploadToken,
                    file.distPath,
                    file.srcPath,
                    putExtra,
                    (err, respBody, respInfo) => {
                      if (err) {
                        reject({
                          message: 'Upload files failed',
                          error: err
                        });
                        return;
                      }
                      if (respInfo.statusCode === 200) {
                        resolve();
                      } else {
                        reject({
                          message: `Upload files failed, code ${respInfo.statusCode}`,
                          error: respBody
                        });
                      }
                    }
                  );
                }
              );
            }
          )
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

      const urls = [];
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

      const cdnManager = new qiniu.cdn.CdnManager(mac);

      const tasks = [];

      while (urls.length) {
        const curUrls = urls.splice(0, 100);
        tasks.push(
          new Promise(
            (resolve, reject) => {
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
                    resolve();
                  } else {
                    reject({
                      message: `Refresh urls failed, code ${respInfo.statusCode}`,
                      error: JSON.parse(respBody)
                    });
                  }
                }
              )
            }
          )
        )
      }

      return Promise.all(
        tasks
      )
      .then(
        () => {
          spinner.succeed('Refresh urls successed');
        }
      );
    }
  )
  .catch(
    ({ message, error }) => {
      spinner.fail(message);

      console.log('');
      console.log(error);

      process.exit();
    }
  );