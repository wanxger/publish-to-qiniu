const path = require('path');

const workspacePath = process.cwd();

module.exports = function resolvePath(relativeCwdPath) {
  return path.join(
    workspacePath,
    relativeCwdPath
  );
};