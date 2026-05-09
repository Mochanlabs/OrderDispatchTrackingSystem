const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

let s3Client;
let s3Config = {};

function initializeS3(config) {
  s3Config = {
    bucket: config.bucket,
    region: config.region,
  };

  s3Client = new S3Client({
    region: config.region,
    credentials: config.credentials ? {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
    } : undefined,
  });

  console.log(`✓ S3 Service initialized (bucket: ${s3Config.bucket}, region: ${s3Config.region})`);
}

// Generate pre-signed URL for uploading file to S3
async function generatePresignedUploadUrl(dealerId, orderId, fileName, fileType) {
  if (!s3Client) throw new Error('S3 service not initialized');

  // S3 path: receipts/YYYY/MM/DD/dealer_id/order_id_timestamp.ext
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timestamp = Math.floor(now.getTime() / 1000);

  // Extract extension safely, default to jpg if no extension
  let ext = 'jpg';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex > 0) {
    ext = fileName.substring(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Fallback if ext is empty or invalid
  if (!ext || ext.length === 0) {
    ext = 'jpg';
  }

  // S3 key: sanitize dealer_id to remove special chars
  const sanitizedDealerId = String(dealerId).replace(/[^a-zA-Z0-9_-]/g, '');
  const sanitizedOrderId = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  const s3Key = `receipts/${year}/${month}/${day}/${sanitizedDealerId}/O${sanitizedOrderId}_${timestamp}.${ext}`;

  console.log(`[S3] Generating presigned URL: bucket=${s3Config.bucket}, key=${s3Key}, type=${fileType}`);

  try {
    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: s3Key,
      ContentType: fileType || 'image/jpeg',
    });

    // Pre-signed URL expires in 15 minutes
    const url = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    console.log(`[S3] Presigned URL generated successfully`);
    return {
      url,
      s3Key,
      expiresIn: 900,
    };
  } catch (error) {
    console.error('[S3] Error generating presigned URL:', error.message);
    console.error('[S3] Error code:', error.code);
    console.error('[S3] Error details:', error);
    throw new Error(`S3 Error: ${error.message}`);
  }
}

// Generate pre-signed URL for reading/viewing file from S3
async function generatePresignedReadUrl(s3Key) {
  if (!s3Client) throw new Error('S3 service not initialized');

  try {
    console.log(`[S3] Generating presigned read URL: bucket=${s3Config.bucket}, key=${s3Key}`);

    const command = new GetObjectCommand({
      Bucket: s3Config.bucket,
      Key: s3Key,
    });

    // Pre-signed URL expires in 24 hours
    const url = await getSignedUrl(s3Client, command, { expiresIn: 86400 });
    console.log(`[S3] Presigned URL generated successfully (length: ${url.length} chars)`);
    return url;
  } catch (error) {
    console.error('[S3] Error generating presigned read URL:', error.message);
    console.error('[S3] Error code:', error.code);
    console.error('[S3] Error name:', error.name);
    console.error('[S3] Full error:', error);
    throw error;
  }
}

// Upload file directly from backend to S3
async function uploadFileToS3(dealerId, orderId, fileBuffer, fileName, fileType) {
  if (!s3Client) throw new Error('S3 service not initialized');

  // S3 path: receipts/YYYY/MM/DD/dealer_id/order_id_timestamp.ext
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timestamp = Math.floor(now.getTime() / 1000);

  // Extract extension safely, default to jpg if no extension
  let ext = 'jpg';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex > 0) {
    ext = fileName.substring(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  if (!ext || ext.length === 0) {
    ext = 'jpg';
  }

  // S3 key: sanitize dealer_id and order_id
  const sanitizedDealerId = String(dealerId).replace(/[^a-zA-Z0-9_-]/g, '');
  const sanitizedOrderId = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '');
  const s3Key = `receipts/${year}/${month}/${day}/${sanitizedDealerId}/O${sanitizedOrderId}_${timestamp}.${ext}`;

  console.log(`[S3] Uploading file: bucket=${s3Config.bucket}, key=${s3Key}, size=${fileBuffer.length} bytes, type=${fileType}`);

  try {
    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: fileType || 'image/jpeg',
    });

    await s3Client.send(command);

    const s3Url = `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${s3Key}`;
    console.log(`[S3] File uploaded successfully: ${s3Url}`);

    return {
      s3Key,
      s3Url,
      fileSize: fileBuffer.length,
    };
  } catch (error) {
    console.error('[S3] Error uploading file:', error.message);
    console.error('[S3] Error code:', error.code);
    throw new Error(`S3 Upload Error: ${error.message}`);
  }
}

module.exports = {
  initializeS3,
  generatePresignedUploadUrl,
  generatePresignedReadUrl,
  uploadFileToS3,
};
