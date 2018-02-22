const S3rver = require('s3rver');
const fs = require('fs-extra'); // Using fs-extra to ensure destination directory exist
const AWS = require('aws-sdk');
const shell = require('shelljs');
const defaultOptions = {
  port: 4569,
  host: 'localhost',
  cors: false,
  create: true
}

class ServerlessS3Local {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.provider = 'aws';
    this.client = null;

    this.commands = {
      s3: {
        commands: {
          start: {
            usage: 'Start S3 local server.',
            lifecycleEvents: ['startHandler'],
            options: {
              port: {
                shortcut: 'p',
                usage:
                  'The port number that S3 will use to communicate with your application. If you do not specify this option, the default port is 4569',
              },
              directory: {
                shortcut: 'd',
                usage:
                  'The directory where S3 will store its objects. If you do not specify this option, the file will be written to the current directory.',
              },
              buckets: {
                shortcut: 'b',
                usage: 'After starting S3 local, create specified buckets',
              },
              cors: {
                shortcut: 'c',
                usage: 'Enable CORS',
              },
              noStart: {
                shortcut: 'n',
                default: false,
                usage: 'Do not start S3 local (in case it is already running)',
              },
              create: {
                shortcut: 'x',
                default: true,
                usage: 'Don\'t create buckets'
              }
            },
          },
          create: {
            usage: 'Create local S3 buckets.',
            lifecycleEvents: ['createHandler'],
            options: {
              port: {
                shortcut: 'p',
                usage:
                  'The port number that S3 will use to communicate with your application. If you do not specify this option, the default port is 4569',
              },
              buckets: {
                shortcut: 'b',
                usage: 'After starting S3 local, create specified buckets',
              },
            }
          },
          remove: {
            usage: 'Remove local S3 buckets.',
            lifecycleEvents: ['createHandler'],
            options: {
              port: {
                shortcut: 'p',
                usage:
                  'The port number that S3 will use to communicate with your application. If you do not specify this option, the default port is 4569',
              },
              buckets: {
                shortcut: 'b',
                usage: 'After starting S3 local, create specified buckets',
              },
            }
          }
        },
      },
    };

    this.hooks = {
      's3:start:startHandler': this.startHandler.bind(this),
      's3:create:createHandler': this.createHandler.bind(this),
      's3:remove:createHandler': this.removeHandler.bind(this),
      'before:offline:start:init': this.startHandler.bind(this),
      'before:offline:start': this.startHandler.bind(this),
      'before:offline:start:end': this.endHandler.bind(this),
    };
  }

  startHandler() {
    return new Promise((resolve, reject) => {
      this._setOptions();
      const { noStart, create, port, host, cors } = this.options;
      if (noStart) {
        if (create) {
          return this.createBuckets().then(resolve, reject);
        }

        return resolve();
      }

      const dirPath = this.options.directory || './buckets';
      fs.ensureDirSync(dirPath); // Create destination directory if not exist
      const directory = fs.realpathSync(dirPath);

      this.client = new S3rver({
        port,
        hostname: host,
        silent: false,
        directory,
        cors,
      }).run((err, s3Host, s3Port) => {
        if (err) {
          console.error('Error occurred while starting S3 local.');
          reject(err);
          return;
        }

        this.options.port = s3Port
        console.log(`S3 local started ( port:${s3Port} )`);

        if (create) {
          this.createBuckets().then(resolve, reject);
        }
      });
    });
  }

  endHandler() {
    if (!this.options.noStart) {
      this.client.close();
      console.log('S3 local closed');
    }
  }

  createHandler() {
    this._setOptions();
    return this.createBuckets();
  }

  removeHandler() {
    this._setOptions();
    return this.removeBuckets();
  }

  createBuckets() {
    return Promise.resolve().then(() => {
      const buckets = this.buckets();
      if (!buckets.length) return;

      const s3Client = this.getClient();
      return Promise.all(buckets.map(Bucket => {
        this.serverless.cli.log(`creating bucket: ${Bucket}`);
        return s3Client.createBucket({ Bucket }).promise();
      }));
    })
    .catch(x => {});
  }

  removeBuckets() {
    return Promise.resolve().then(() => {
      const { port } = this.options;
      const buckets = this.buckets();
      if (!buckets.length) return;

      return Promise.all(buckets.map(bucket => {
        this.serverless.cli.log(`removing bucket: ${bucket}`);
        return removeBucket({ port, bucket });
      }));
    });
  }

  getClient() {
    return new AWS.S3({
      s3ForcePathStyle: true,
      endpoint: new AWS.Endpoint(`http://localhost:${this.options.port}`),
    });
  }

  getAdditionalStacks() {
    const serviceAdditionalStacks = this.service.custom.additionalStacks || {};
    const additionalStacks = [];
    Object.keys(serviceAdditionalStacks).forEach((stack) => {
      additionalStacks.push(serviceAdditionalStacks[stack]);
    });
    return additionalStacks;
  }

  hasAdditionalStacksPlugin() {
    return (
      this.service &&
      this.service.plugins &&
      this.service.plugins.indexOf('serverless-plugin-additional-stacks') >= 0
    );
  }

  /**
   * Get bucket list from serverless.yml resources and additional stacks
   *
   * @return {object} Array of bucket name
   */
  buckets() {
    const resources = (this.service.resources && this.service.resources.Resources) || {};
    if (this.hasAdditionalStacksPlugin()) {
      let additionalStacks = [];
      additionalStacks = additionalStacks.concat(this.getAdditionalStacks());
      additionalStacks.forEach((stack) => {
        if (stack.Resources) {
          Object.keys(stack.Resources).forEach((key) => {
            if (stack.Resources[key].Type === 'AWS::S3::Bucket') {
              resources[key] = stack.Resources[key];
            }
          });
        }
      });
    }
    return Object.keys(resources)
      .map((key) => {
        if (resources[key].Type === 'AWS::S3::Bucket' && resources[key].Properties && resources[key].Properties.BucketName) {
          return resources[key].Properties.BucketName;
        }
        return null;
      })
      .concat(this.options.buckets)
      .filter(n => n);
  }

  _setOptions() {
    const config = (this.serverless.service.custom && this.serverless.service.custom.s3) || {};
    this.options = Object.assign({}, defaultOptions, this.options, config);
  }
}

const removeBucket = ({ bucket, port }) => new Promise((resolve, reject) => {
  shell.exec(
    `aws --endpoint http://localhost:${port} s3 rb "s3://${bucket}" --force`,
    { silent: true },
    function (code, stdout, stderr) {
      if (code === 0) return resolve();
      if (stderr && stderr.indexOf('NoSuchBucket') !== -1) return resolve();

      reject(new Error(`failed to delete bucket ${bucket}: ${stderr || stdout}`));
    }
  );
});

module.exports = ServerlessS3Local;
