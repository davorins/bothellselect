// backend/utils/r2.js
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET || 'bothellselect';
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

/**
 * Upload a file to R2
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} folder - Folder path (e.g., 'avatars', 'players')
 * @param {string} filename - Original filename
 * @returns {Promise<{url: string, key: string}>}
 */
const uploadToR2 = async (fileBuffer, folder, filename) => {
  try {
    // CRITICAL: Validate buffer
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error('File buffer is empty');
    }

    // Ensure we're working with a proper Buffer
    const buffer = Buffer.isBuffer(fileBuffer)
      ? fileBuffer
      : Buffer.from(fileBuffer);

    // Log actual size for debugging
    console.log(`📦 Uploading ${filename}: ${buffer.length} bytes`);

    const fileExtension = filename.split('.').pop();
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const key = `${folder}/${uniqueId}-${Date.now()}.${fileExtension}`;

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer, // Use validated buffer
      ContentType: `image/${fileExtension}`,
    };

    const command = new PutObjectCommand(uploadParams);
    const result = await r2Client.send(command);

    const url = `${PUBLIC_URL}/${key}`;
    console.log(`✅ Upload complete: ${buffer.length} bytes -> ${url}`);

    return { url, key };
  } catch (error) {
    console.error('❌ Upload error:', error);
    throw error;
  }
};

/**
 * Delete a file from R2
 * @param {string} key - The file key (path)
 * @returns {Promise<boolean>}
 */
const deleteFromR2 = async (key) => {
  try {
    // Extract key from URL if full URL is provided
    const fileKey = key.includes(PUBLIC_URL)
      ? key.replace(`${PUBLIC_URL}/`, '')
      : key;

    const deleteParams = {
      Bucket: BUCKET_NAME,
      Key: fileKey,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await r2Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting from R2:', error);
    throw new Error('Failed to delete file from R2');
  }
};

/**
 * Generate a signed URL for temporary access to private files
 * @param {string} key - The file key
 * @param {number} expiresIn - Expiration time in seconds (default: 3600)
 * @returns {Promise<string>}
 */
const getSignedR2Url = async (key, expiresIn = 3600) => {
  try {
    const fileKey = key.includes(PUBLIC_URL)
      ? key.replace(`${PUBLIC_URL}/`, '')
      : key;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
    });

    const signedUrl = await getSignedUrl(r2Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw new Error('Failed to generate signed URL');
  }
};

/**
 * Extract key from R2 URL
 * @param {string} url - Full R2 URL
 * @returns {string} - The file key
 */
const getKeyFromUrl = (url) => {
  if (!url) return null;

  // Remove any protocol issues
  let cleanUrl = url;
  if (cleanUrl.includes('https//')) {
    cleanUrl = cleanUrl.replace('https//', 'https://');
  }

  // Handle double domain issue
  if (cleanUrl.includes('bothell-select.onrender.comhttps://')) {
    cleanUrl = cleanUrl.split('bothell-select.onrender.com')[1];
  }

  // Extract key after public URL
  if (cleanUrl.includes(PUBLIC_URL)) {
    return cleanUrl.replace(`${PUBLIC_URL}/`, '');
  }

  return cleanUrl;
};

/**
 * Check if URL is from R2
 * @param {string} url - The URL to check
 * @returns {boolean}
 */
const isR2Url = (url) => {
  if (!url) return false;

  // Check for R2 patterns
  const r2Patterns = [
    PUBLIC_URL,
    'r2.cloudflarestorage.com',
    '.r2.dev', // Add this pattern
  ];

  return r2Patterns.some((pattern) => url.includes(pattern));
};

module.exports = {
  uploadToR2,
  deleteFromR2,
  getSignedR2Url,
  getKeyFromUrl,
  isR2Url,
  r2Client,
  BUCKET_NAME,
  PUBLIC_URL,
};
