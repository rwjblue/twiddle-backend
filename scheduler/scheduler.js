/*jshint node:true */
var config = require('./config');

var AWS = require('aws-sdk');
var http = require('http');
var s3 = new AWS.S3();
var ecs = new AWS.ECS();
var sqs = new AWS.SQS();
var sts = new AWS.STS();

exports.handler = function scheduleBuild(event, context) {

  console.log('Running in env: ' + config.env);
  console.log('Starting based on event: ' + JSON.stringify(event));

  pushBuildToSQS(event)
    .then(getNextBuildFromSQS)
    .then(createSTSTokenForBuild)
    .then(runBuild)
    .then(deQueue)
    .then(function(buildData) {
      console.log('Build started', buildData.task);
    })
    .catch(function(err) {
      console.error('An error ocurred');
      console.log(arguments);
    });
};

function pushBuildToSQS(event) {
  return new Promise(function(resolve, reject) {
    var addon;
    var addonVersion;
    var emberVersion;
    var pushPromise;

    if ( 'addon' in event ) {
      console.log('Pushing build to SQS');

      addon = event.addon;
      addonVersion = event.addon_version;
      emberVersion = event.ember_version;

      var params = {
        QueueUrl: config.schedulerSqsQueueUrl,
        MessageBody: JSON.stringify({
          addon: addon,
          addon_version: addonVersion,
          ember_version: emberVersion
        })
      };

      sqs.sendMessage(params, function(err, data) {
        if (err) {
          return reject(err);
        }
        return resolve();
      });
    }
    else {
      resolve();
    }
  });
}

function getNextBuildFromSQS() {
  return new Promise(function(resolve, reject) {
    console.log('Loading build from SQS');

    var params = {
      QueueUrl: config.schedulerSqsQueueUrl,
      MaxNumberOfMessages: 1,
      VisibilityTimeout: 5
    };

    sqs.receiveMessage(params, function(err, data) {
      if(err) {
        reject(err);
      }

      if (data && data.Messages && data.Messages.length) {
        var build = JSON.parse(data.Messages[0].Body);
        resolve({build: build, message_receipt: data.Messages[0].ReceiptHandle});
      }
    });
  });
}

function createSTSTokenForBuild(buildData) {
  return new Promise(function(resolve, reject) {
    console.log('Creating STS token');

    var addon = buildData.build.addon;
    var addonVersion = buildData.build.addon_version;
    var emberVersion = buildData.build.ember_version;

    var buildAddonPolicy = {
      "Version": "2012-10-17",
      "Statement": [
          {
              "Effect": "Allow",
              "Action": [
                  "lambda:InvokeAsync",
                  "lambda:InvokeFunction"
              ],
              "Resource": [
                  config.schedulerRole
              ]
          },
          {
              "Effect": "Allow",
              "Action": [
                  "s3:GetBucketCORS",
                  "s3:GetBucketLocation",
                  "s3:GetBucketLogging",
                  "s3:GetBucketNotification",
                  "s3:GetBucketPolicy",
                  "s3:GetBucketRequestPayment",
                  "s3:GetBucketTagging",
                  "s3:GetBucketVersioning",
                  "s3:GetBucketWebsite",
                  "s3:GetLifecycleConfiguration",
                  "s3:ListBucket"
              ],
              "Resource": [
                  "arn:aws:s3:::" + config.addonBucketName
              ]
          },
          {
              "Effect": "Allow",
              "Action": [
                  "s3:PutObject",
                  "s3:PutObjectAcl",
                  "s3:GetObject",
                  "s3:GetObjectAcl",
                  "s3:GetObjectTorrent",
                  "s3:GetObjectVersion",
                  "s3:GetObjectVersionAcl",
                  "s3:GetObjectVersionTorrent"
              ],
              "Resource": [
                  "arn:aws:s3:::" + config.addonBucketName + "/ember-" + emberVersion + "/" + addon + "/" + addonVersion + "/*"
              ]
          }
      ]
    };

    var stsParams = {
      RoleArn: config.builderRole,
      RoleSessionName: 'build-addon',
      DurationSeconds: 900,
      Policy: JSON.stringify(buildAddonPolicy)
    };

    sts.assumeRole(stsParams, function (err, data) {
      if (err) {
        return reject(err);
      }

      buildData.credentials = data.Credentials;
      return resolve(buildData);
    });
  });
}

function runBuild(buildData) {
  return new Promise(function(resolve, reject) {
    var emberVersion = buildData.build.ember_version;
    console.log('Running build ' + config.builderTaskDefinition + '-' + emberVersion.replace(/\./gi,'-'));

    var params = {
      taskDefinition: config.builderTaskDefinition + '-' + emberVersion.replace(/\./gi,'-'), /* required */
      cluster: 'ember-twiddle',
      count: 1,
      overrides: {
        containerOverrides: [
          {
            name: 'addon-builder',
            environment: [
              {
                name: 'AWS_ACCESS_KEY_ID',
                value: buildData.credentials.AccessKeyId
              },
              {
                name: 'AWS_SECRET_ACCESS_KEY',
                value: buildData.credentials.SecretAccessKey
              },
              {
                name: 'AWS_SESSION_TOKEN',
                value: buildData.credentials.SessionToken
              },
              {
                name: 'ADDON_NAME',
                value: buildData.build.addon
              },
              {
                name: 'ADDON_VERSION',
                value: buildData.build.addon_version
              },
            ]
          }
        ]
      },
      startedBy: 'ember-twiddle-scheduler'
    };
    ecs.runTask(params, function(err, data) {
      if (err)  {
        return reject(err);
      }
      if (!data.tasks.length && data.failures.length) {
        return reject(Error('Starting task failed: ' + JSON.stringify(data.failures[0])));
      }
      buildData.task = data.tasks[0];
      return resolve(buildData);
    });
  });
}

function deQueue(buildData) {
  return new Promise(function(resolve, reject) {
      console.log('Deleting message from queue');

      var params = {
        QueueUrl: config.schedulerSqsQueueUrl,
        ReceiptHandle: buildData.message_receipt
      };

      sqs.deleteMessage(params, function(err,data) {
        if(err) {
          return reject(err);
        }
        return resolve(buildData);
      });
  });
}

