#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const program = require('commander');
const glob = require('glob');
const qiniu = require('qiniu');

const getEtag = require('../lib/getEtag');

const workspacePath = process.cwd();

program
  .version(require('../package').version)
  .usage('[options]')
  .parse(process.argv);

const { accessKey, secretKey, bucket, hosts, tasks } = require(path.join(workspacePath, 'package.json')).publishToQiniu;

var mac = new qiniu.auth.digest.Mac(accessKey, secretKey);

const fileMap = new Map();

Promise.all(
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
                reject(err);
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
)
  .then(
    () => {
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
    () => {
      const config = new qiniu.conf.Config();
      const bucketManager = new qiniu.rs.BucketManager(mac, config);

      const tasks = [];
      const filePaths = [...fileMap.keys()];
      const resFilePaths = [];
      while (filePaths.length) {
        const curFilePaths = filePaths.splice(0, 1000);
        tasks.push(
          new Promise((resolve, reject) => {
            bucketManager
              .batch(
                curFilePaths.map(curFilePath => {
                  return qiniu.rs.statOp(bucket, fileMap.get(curFilePath).distPath);
                }),
                (err, respBody, respInfo) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  if (parseInt(respInfo.statusCode / 100) !== 2) {
                    reject('stat part failed');
                    return;
                  }
                  respBody
                    .forEach(
                      (resp, i) => {
                        const curFilePath = curFilePaths[i];
                        const file = fileMap.get(curFilePath);
                        if (resp.code !== 200 || resp.data.hash !== file.hash) {
                          resFilePaths.push(curFilePath);
                        }
                      }
                    );
                  resolve();
                }
              );
          })
        );
      }

      return Promise.all(tasks)
        .then(
          () => resFilePaths
        );
    }
  )
  .then(
    filePaths => {
      const config = new qiniu.conf.Config();
      const formUploader = new qiniu.form_up.FormUploader(config);
      const putExtra = new qiniu.form_up.PutExtra();

      return Promise.all(
        filePaths
          .map(
            filePath => {
              const file = fileMap.get(filePath);

              var uploadToken = new qiniu.rs.PutPolicy(
                {
                  scope: bucket + ':' + file.distPath
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
                    (respErr, respBody, respInfo) => {
                      if (respErr) {
                        reject(respErr);
                      }
                      if (respInfo.statusCode == 200) {
                        resolve();
                      } else {
                        console.log(respInfo.statusCode);
                        console.log(respBody);
                        reject();
                      }
                    }
                  );
                }
              );
            }
          )
      )
      .then(
        () => filePaths
      );
    }
  )
  .then(
    filePaths => {
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
                (respErr, respBody, respInfo) => {
                  if (respErr) {
                    reject(respErr);
                    return;
                  }
                  if (respInfo.statusCode === 200) {
                    resolve();
                  } else {
                    console.log(respInfo.statusCode);
                    console.log(JSON.parse(respBody));
                    reject();
                  }
                }
              )
            }
          )
        )
      }

      return tasks;
    }
  )
  .catch(
    err => {
      console.log(err);
    }
  );