#!/usr/bin/env node

const colors = require('colors/safe');
const program = require('commander');

const resolvePath = require('../lib/resolvePath');

const execBucketTask = require('../lib/execBucketTask');

program
  .version(require('../package').version)
  .usage('[options]')
  .option('--no-refresh', 'Skip refresh urls step')
  .parse(process.argv);

let bucketTasks = require(
  resolvePath('package.json')
).publishToQiniu;
if (!Array.isArray(bucketTasks)) {
  bucketTasks = [bucketTasks];
}

async function execBucketTasks(bucketTasks) {
  for (const bucketTask of bucketTasks) {
    const bucketTaskName = colors.bold(
      `[${bucketTask.bucket}]`
    );
    try {
      console.log(`Start execute bucket task ${bucketTaskName}`);
      await execBucketTask(bucketTask, program);
      console.log(
        `Execute bucket task ${bucketTaskName} ` + colors.green('successed')
      );
      console.log('');
    } catch (e) {
      console.log(`Execute bucket task ${bucketTaskName} ` + colors.red('failed'));

      throw e;
    }
  }
}

Promise
  .resolve()
  .then(
    () => {
      console.log('');
    }
  )
  .then(
    () => {
      return execBucketTasks(bucketTasks);
    }
  )
  .then(
    () => {
      console.log(
        colors.green(
          'Execute bucket tasks successed'
        )
      );
    },
    e => {
      console.log('');
      console.log(
        colors.red(
          'Execute bucket tasks failed'
        )
      );

      console.log('');
      console.log(e);
    }
  );