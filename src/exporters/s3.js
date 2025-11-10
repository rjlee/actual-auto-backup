const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function createClient(config) {
  const { region, endpoint, accessKeyId, secretAccessKey, forcePathStyle } =
    config;
  const s3Config = {
    region: region || "us-east-1",
    forcePathStyle,
  };
  if (endpoint) {
    s3Config.endpoint = endpoint;
  }
  if (accessKeyId && secretAccessKey) {
    s3Config.credentials = { accessKeyId, secretAccessKey };
  }
  return new S3Client(s3Config);
}

async function uploadToS3(buffer, config, logger) {
  const { bucket, prefix = "", budgetId, timestamp } = config;
  if (!bucket) {
    throw new Error("S3_BUCKET must be provided when ENABLE_S3=true");
  }
  const client = createClient(config);
  const key = `${prefix}${budgetId}-${timestamp || new Date().toISOString().replace(/[:]/g, "-")}.zip`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "application/zip",
    }),
  );
  logger.info({ bucket, key }, "uploaded backup to S3");
}

module.exports = { uploadToS3 };
