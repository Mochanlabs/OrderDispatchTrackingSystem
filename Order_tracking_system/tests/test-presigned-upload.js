/**
 * Test script: Presigned URL direct-to-S3 upload flow
 * Tests the new architecture: request presigned URL → upload directly to S3
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadParameters } = require('../config/parameterStore');
const { initializeS3, generatePresignedUploadUrl } = require('../services/s3Service');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function createTestImage(sizeKB) {
  const buffer = Buffer.alloc(sizeKB * 1024);
  buffer.write('\xFF\xD8\xFF\xE0', 0);
  for (let i = 4; i < buffer.length; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

function uploadToS3(presignedUrl, fileBuffer, fileType) {
  return new Promise((resolve, reject) => {
    const url = new URL(presignedUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': fileType,
        'Content-Length': fileBuffer.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ status: res.statusCode, headers: res.headers });
        } else {
          reject(new Error(`S3 returned ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function runTest() {
  console.log('\n' + '='.repeat(70));
  console.log('PRESIGNED URL UPLOAD TEST (Direct-to-S3)');
  console.log('='.repeat(70) + '\n');

  try {
    // Step 1: Load parameters and initialize S3
    console.log('[1/6] Loading AWS parameters and initializing S3...');
    await loadParameters();
    const s3Config = {
      bucket: process.env.S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || 'odts-dev-s3-receipt',
      region: process.env.AWS_REGION || process.env.AWS_S3_REGION || 'ap-south-1',
    };
    initializeS3(s3Config);
    console.log('✅ Parameters loaded and S3 initialized\n');

    // Step 2: Create test image
    console.log('[2/6] Creating test image (2 MB)...');
    const originalImage = createTestImage(2048);
    console.log(`✅ Test image created: ${formatBytes(originalImage.length)}\n`);

    // Step 3: Simulate compression
    console.log('[3/6] Simulating compression (500KB target)...');
    const compressionRatio = 0.25;
    const compressedImage = originalImage.slice(0, Math.ceil(originalImage.length * compressionRatio));
    console.log(`  Original: ${formatBytes(originalImage.length)}`);
    console.log(`  Compressed: ${formatBytes(compressedImage.length)}`);
    console.log(`  Compression: ${(100 - Math.round(compressedImage.length / originalImage.length * 100))}%`);
    console.log('✅ Compression simulated\n');

    // Step 4: Request presigned URL from backend
    console.log('[4/6] Requesting presigned URL from backend...');
    const dealerId = 4;
    const orderId = 25;
    const fileName = 'test-presigned-upload.jpg';
    const fileType = 'image/jpeg';

    const presignedResult = await generatePresignedUploadUrl(dealerId, orderId, fileName, fileType);
    console.log(`  Presigned URL expires in: ${presignedResult.expiresIn} seconds`);
    console.log(`  S3 Key: ${presignedResult.s3Key}`);
    console.log(`  URL length: ${presignedResult.url.length} chars`);
    console.log('✅ Presigned URL received\n');

    // Step 5: Upload directly to S3
    console.log('[5/6] Uploading file directly to S3 (bypassing backend)...');
    const s3Result = await uploadToS3(presignedResult.url, compressedImage, fileType);
    console.log(`  S3 response: ${s3Result.status}`);
    console.log(`  ETag: ${s3Result.headers.etag || 'N/A'}`);
    console.log('✅ File uploaded to S3 successfully\n');

    // Step 6: Construct final S3 URL
    console.log('[6/6] Constructing final S3 URL...');
    const s3Url = presignedResult.url.split('?')[0];
    console.log(`  Final S3 URL: ${s3Url}`);
    console.log(`  (This URL is what gets stored in order_dispatch table)\n`);

    console.log('='.repeat(70));
    console.log('✅ TEST PASSED');
    console.log('='.repeat(70));
    console.log('\nKey Benefits of This Architecture:');
    console.log('  ✓ No 413 errors — file bypasses Express entirely');
    console.log('  ✓ No base64 encoding — direct binary upload');
    console.log('  ✓ Faster upload — direct to S3, no backend bottleneck');
    console.log('  ✓ Scalable — backend handles only metadata');
    console.log('  ✓ Request payload: ~200 bytes (only JSON metadata)');
    console.log('  ✓ File size: no limit (S3 limit is 5TB)\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

runTest().then(() => process.exit(0));
