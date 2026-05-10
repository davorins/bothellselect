const express = require('express');
const multer = require('multer');
const {
  uploadToR2,
  deleteFromR2,
  getKeyFromUrl,
  isR2Url,
} = require('../utils/r2');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const { authenticate } = require('../utils/auth');

const router = express.Router();

// Configure multer for memory storage (since we're uploading to R2 directly)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error('Only image files are allowed! (JPEG, JPG, PNG, GIF, WEBP)'),
        false,
      );
    }
  },
});

/**
 * Upload parent avatar endpoint
 */
router.put(
  '/parent/:id/avatar',
  authenticate,
  upload.single('avatar'),
  async (req, res) => {
    console.log('🔍 ===== AVATAR UPLOAD DEBUG =====');
    console.log('1. Headers:', {
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length'],
      origin: req.headers.origin,
      authorization: req.headers.authorization
        ? 'Bearer [PRESENT]'
        : 'Bearer [MISSING]',
    });

    console.log(
      '2. File received:',
      req.file
        ? {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            bufferExists: !!req.file.buffer,
            bufferLength: req.file.buffer?.length,
          }
        : '❌ NO FILE',
    );

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const parentId = req.params.id;
      console.log('3. Looking up parent:', parentId);

      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res.status(404).json({ error: 'Parent not found' });
      }
      console.log('4. Parent found:', parent._id);

      if (req.user.role !== 'admin' && req.user.id !== parentId) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      console.log('5. Authorization check passed');

      if (parent.avatar && isR2Url(parent.avatar)) {
        console.log('6. Deleting old avatar:', parent.avatar);
        try {
          await deleteFromR2(parent.avatar);
          console.log('   ✅ Old avatar deleted');
        } catch (deleteError) {
          console.error(
            '   ⚠️ Error deleting old avatar:',
            deleteError.message,
          );
        }
      }

      console.log('7. Starting R2 upload...');
      const startTime = Date.now();
      const { url, key } = await uploadToR2(
        req.file.buffer,
        'avatars/parents',
        req.file.originalname,
      );
      const uploadTime = Date.now() - startTime;

      console.log('8. ✅ R2 upload completed in', uploadTime, 'ms');
      console.log('   URL:', url);

      parent.avatar = url;
      await parent.save();
      console.log('9. ✅ Parent record updated');

      res.json({
        success: true,
        message: 'Avatar uploaded successfully',
        avatarUrl: url,
        key: key,
      });
    } catch (error) {
      console.error('❌ ===== UPLOAD ERROR =====');
      console.error('Error:', error);
      res.status(500).json({
        error: 'Failed to upload avatar',
        details: error.message,
      });
    }
  },
);

/**
 * Delete parent avatar endpoint
 */
router.delete('/parent/:id/avatar', authenticate, async (req, res) => {
  try {
    const parentId = req.params.id;
    const { avatarUrl } = req.body;

    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    if (req.user.role !== 'admin' && req.user.id !== parentId) {
      return res
        .status(403)
        .json({ error: 'Not authorized to delete this avatar' });
    }

    const urlToDelete = avatarUrl || parent.avatar;

    if (!urlToDelete) {
      return res.status(400).json({ error: 'No avatar URL or key provided' });
    }

    if (isR2Url(urlToDelete)) {
      const deleteResult = await deleteFromR2(urlToDelete);
      if (deleteResult) {
        parent.avatar = null;
        await parent.save();
        res.json({
          success: true,
          message: 'Avatar deleted successfully from R2',
        });
      } else {
        res.status(500).json({ error: 'Failed to delete avatar from R2' });
      }
    } else {
      parent.avatar = null;
      await parent.save();
      res.json({
        success: true,
        message: 'Avatar reference removed from database',
      });
    }
  } catch (error) {
    console.error('Parent avatar deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete avatar',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ---------------------------------------------------------------------------
// Guardian avatar endpoints
// Route: /upload/guardian/:parentId/:guardianId/avatar
// Guardians are embedded subdocuments inside the Parent model, so we look up
// the parent and find the matching guardian by _id within additionalGuardians.
// ---------------------------------------------------------------------------

/**
 * Upload guardian avatar endpoint
 */
router.put(
  '/guardian/:parentId/:guardianId/avatar',
  authenticate,
  upload.single('avatar'),
  async (req, res) => {
    console.log('🔍 ===== GUARDIAN AVATAR UPLOAD =====');

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const { parentId, guardianId } = req.params;

      // Only admins can upload guardian avatars on behalf of families
      if (req.user.role !== 'admin' && req.user.id !== parentId) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res.status(404).json({ error: 'Parent not found' });
      }

      // Find the guardian subdocument
      const guardian = parent.additionalGuardians?.id
        ? parent.additionalGuardians.id(guardianId) // Mongoose subdoc helper
        : parent.additionalGuardians?.find(
            (g) => g._id?.toString() === guardianId,
          );

      if (!guardian) {
        return res.status(404).json({ error: 'Guardian not found' });
      }

      // Delete old guardian avatar from R2 if it exists
      if (guardian.avatar && isR2Url(guardian.avatar)) {
        try {
          await deleteFromR2(guardian.avatar);
          console.log('Old guardian avatar deleted:', guardian.avatar);
        } catch (deleteError) {
          console.warn(
            'Could not delete old guardian avatar:',
            deleteError.message,
          );
        }
      }

      // Upload new avatar to R2
      const { url, key } = await uploadToR2(
        req.file.buffer,
        'avatars/guardians',
        req.file.originalname,
      );

      // Update the guardian subdocument and save the parent
      guardian.avatar = url;
      await parent.save();

      console.log('✅ Guardian avatar uploaded:', url);

      res.json({
        success: true,
        message: 'Guardian avatar uploaded successfully',
        avatarUrl: url,
        key,
      });
    } catch (error) {
      console.error('Guardian avatar upload error:', error);
      res.status(500).json({
        error: 'Failed to upload guardian avatar',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * Delete guardian avatar endpoint
 */
router.delete(
  '/guardian/:parentId/:guardianId/avatar',
  authenticate,
  async (req, res) => {
    try {
      const { parentId, guardianId } = req.params;

      if (req.user.role !== 'admin' && req.user.id !== parentId) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res.status(404).json({ error: 'Parent not found' });
      }

      const guardian = parent.additionalGuardians?.id
        ? parent.additionalGuardians.id(guardianId)
        : parent.additionalGuardians?.find(
            (g) => g._id?.toString() === guardianId,
          );

      if (!guardian) {
        return res.status(404).json({ error: 'Guardian not found' });
      }

      if (guardian.avatar && isR2Url(guardian.avatar)) {
        try {
          await deleteFromR2(guardian.avatar);
        } catch (deleteError) {
          console.warn(
            'Could not delete guardian avatar from R2:',
            deleteError.message,
          );
        }
      }

      guardian.avatar = null;
      await parent.save();

      res.json({
        success: true,
        message: 'Guardian avatar deleted successfully',
      });
    } catch (error) {
      console.error('Guardian avatar deletion error:', error);
      res.status(500).json({
        error: 'Failed to delete guardian avatar',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * Upload player avatar endpoint
 */
router.put(
  '/player/:id/avatar',
  authenticate,
  upload.single('avatar'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const playerId = req.params.id;

      const player = await Player.findById(playerId);
      if (!player) {
        return res.status(404).json({ error: 'Player not found' });
      }

      if (
        req.user.role !== 'admin' &&
        req.user.id !== player.parentId.toString()
      ) {
        return res
          .status(403)
          .json({ error: 'Not authorized to update this player avatar' });
      }

      if (
        player.avatar &&
        isR2Url(player.avatar) &&
        !player.avatar.includes('default') &&
        !player.avatar.includes('girl.png') &&
        !player.avatar.includes('boy.png')
      ) {
        try {
          await deleteFromR2(player.avatar);
          console.log('Old player avatar deleted from R2:', player.avatar);
        } catch (deleteError) {
          console.error(
            'Error deleting old avatar (continuing anyway):',
            deleteError,
          );
        }
      }

      const { url, key } = await uploadToR2(
        req.file.buffer,
        'avatars/players',
        req.file.originalname,
      );

      player.avatar = url;
      await player.save();

      res.json({
        success: true,
        message: 'Player avatar uploaded successfully',
        avatarUrl: url,
        key: key,
      });
    } catch (error) {
      console.error('Player avatar upload error:', error);
      res.status(500).json({
        error: 'Failed to upload player avatar',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * Delete player avatar endpoint
 */
router.delete('/player/:id/avatar', authenticate, async (req, res) => {
  try {
    const playerId = req.params.id;
    const { avatarUrl } = req.body;

    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    if (
      req.user.role !== 'admin' &&
      req.user.id !== player.parentId.toString()
    ) {
      return res
        .status(403)
        .json({ error: 'Not authorized to delete this avatar' });
    }

    const urlToDelete = avatarUrl || player.avatar;

    if (!urlToDelete) {
      return res.status(400).json({ error: 'No avatar URL or key provided' });
    }

    const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
    const defaultAvatar =
      player.gender === 'Female'
        ? `${R2_PUBLIC_URL}/avatars/girl.png`
        : `${R2_PUBLIC_URL}/avatars/boy.png`;

    if (
      isR2Url(urlToDelete) &&
      !urlToDelete.includes('default') &&
      !urlToDelete.includes('girl.png') &&
      !urlToDelete.includes('boy.png')
    ) {
      const deleteResult = await deleteFromR2(urlToDelete);
      if (deleteResult) {
        player.avatar = null;
        await player.save();
        res.json({
          success: true,
          message: 'Player avatar deleted from R2',
          avatarUrl: defaultAvatar,
        });
      } else {
        res.status(500).json({ error: 'Failed to delete avatar from R2' });
      }
    } else {
      player.avatar = null;
      await player.save();
      res.json({
        success: true,
        message: 'Avatar reset to default',
        avatarUrl: defaultAvatar,
      });
    }
  } catch (error) {
    console.error('Player avatar deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete player avatar',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * Batch upload multiple avatars (admin only)
 */
router.post(
  '/batch-upload',
  authenticate,
  upload.array('avatars', 10),
  async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const uploadResults = [];

      for (const file of req.files) {
        try {
          const { url, key } = await uploadToR2(
            file.buffer,
            'uploads/batch',
            file.originalname,
          );
          uploadResults.push({
            originalName: file.originalname,
            url,
            key,
            size: file.size,
            mimetype: file.mimetype,
            success: true,
          });
        } catch (uploadError) {
          uploadResults.push({
            originalName: file.originalname,
            error: uploadError.message,
            success: false,
          });
        }
      }

      res.json({
        success: true,
        message: `Uploaded ${uploadResults.filter((r) => r.success).length} of ${req.files.length} files`,
        results: uploadResults,
      });
    } catch (error) {
      console.error('Batch upload error:', error);
      res.status(500).json({
        error: 'Failed to process batch upload',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * Get signed URL for temporary access to private files
 */
router.post('/signed-url', authenticate, async (req, res) => {
  try {
    const { key, expiresIn = 3600 } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'File key is required' });
    }

    const { getSignedR2Url } = require('../utils/r2');
    const signedUrl = await getSignedR2Url(key, expiresIn);

    res.json({ success: true, signedUrl, expiresIn });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).json({
      error: 'Failed to generate signed URL',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * Test direct R2 upload (bypasses multer)
 */
router.post('/test-direct-r2-upload', authenticate, async (req, res) => {
  try {
    console.log('🧪 Testing direct R2 upload...');

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { r2Client, BUCKET_NAME, PUBLIC_URL } = require('../utils/r2');

    const testContent = `R2 direct upload test at ${new Date().toISOString()}`;
    const testKey = `test/direct-upload-${Date.now()}.txt`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: testKey,
      Body: Buffer.from(testContent),
      ContentType: 'text/plain',
    });

    const result = await r2Client.send(command);
    const publicUrl = `${PUBLIC_URL}/${testKey}`;

    res.json({
      success: true,
      message: 'Direct R2 upload successful',
      key: testKey,
      etag: result.ETag,
      publicUrl,
    });
  } catch (error) {
    console.error('❌ Direct R2 upload failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
});

/**
 * List bucket contents
 */
router.get('/list-bucket-contents', authenticate, async (req, res) => {
  try {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const { r2Client, BUCKET_NAME, PUBLIC_URL } = require('../utils/r2');

    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      MaxKeys: 100,
    });
    const response = await r2Client.send(command);

    const objects =
      response.Contents?.map((obj) => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
        url: `${PUBLIC_URL}/${obj.Key}`,
      })) || [];

    res.json({ success: true, count: objects.length, objects });
  } catch (error) {
    console.error('❌ List failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Test R2 connection
 */
router.get('/test-r2-connection', authenticate, async (req, res) => {
  try {
    const {
      ListBucketsCommand,
      PutObjectCommand,
    } = require('@aws-sdk/client-s3');
    const { r2Client, BUCKET_NAME, PUBLIC_URL } = require('../utils/r2');

    const listCommand = new ListBucketsCommand({});
    const buckets = await r2Client.send(listCommand);

    const testBuffer = Buffer.from('Test file from Bothell Select app');
    const testKey = `test-connection-${Date.now()}.txt`;

    const uploadCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: testKey,
      Body: testBuffer,
      ContentType: 'text/plain',
    });

    const uploadResult = await r2Client.send(uploadCommand);
    const publicUrl = `${PUBLIC_URL}/${testKey}`;

    res.json({
      success: true,
      message: 'R2 connection test successful',
      configuredBucket: BUCKET_NAME,
      availableBuckets: buckets.Buckets?.map((b) => b.Name) || [],
      testUpload: { key: testKey, etag: uploadResult.ETag, url: publicUrl },
    });
  } catch (error) {
    console.error('❌ R2 test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      statusCode: error.$metadata?.httpStatusCode,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMO VIDEO ROUTES
// These sit alongside the existing avatar routes in upload.js
// ─────────────────────────────────────────────────────────────────────────────

const Setting = require('../models/Setting');

// Multer config for video uploads (80 MB limit, mp4/webm/ogg)
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4',
      'video/webm',
      'video/ogg',
      'video/quicktime',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error('Only video files are allowed! (MP4, WebM, OGG, MOV)'),
        false,
      );
    }
  },
});

/**
 * GET /upload/promo-video
 * Returns the current promo video URL (public — used by HomePage on mount)
 */
router.get('/promo-video', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'promoVideoUrl' });
    res.json({ success: true, videoUrl: setting?.value || null });
  } catch (error) {
    console.error('Error fetching promo video URL:', error);
    res.status(500).json({ error: 'Failed to fetch promo video URL' });
  }
});

/**
 * PUT /upload/promo-video
 * Admin only — uploads new promo video to R2 and saves URL to Settings
 */
router.put(
  '/promo-video',
  authenticate,
  videoUpload.single('video'),
  async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
      }

      // Delete old video from R2 if one exists
      const existing = await Setting.findOne({ key: 'promoVideoUrl' });
      if (existing?.value && isR2Url(existing.value)) {
        try {
          await deleteFromR2(existing.value);
          console.log('Old promo video deleted from R2:', existing.value);
        } catch (deleteError) {
          console.warn(
            'Could not delete old promo video:',
            deleteError.message,
          );
        }
      }

      // Upload new video to R2
      const { url, key } = await uploadToR2(
        req.file.buffer,
        'videos',
        req.file.originalname,
      );

      // Upsert the setting
      await Setting.findOneAndUpdate(
        { key: 'promoVideoUrl' },
        { value: url, updatedBy: req.user.id },
        { upsert: true, new: true },
      );

      console.log('✅ Promo video uploaded:', url);

      res.json({
        success: true,
        message: 'Promo video uploaded successfully',
        videoUrl: url,
        key,
      });
    } catch (error) {
      console.error('Promo video upload error:', error);
      res.status(500).json({
        error: 'Failed to upload promo video',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * DELETE /upload/promo-video
 * Admin only — removes promo video from R2 and clears the setting
 */
router.delete('/promo-video', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const setting = await Setting.findOne({ key: 'promoVideoUrl' });

    if (setting?.value && isR2Url(setting.value)) {
      try {
        await deleteFromR2(setting.value);
        console.log('Promo video deleted from R2:', setting.value);
      } catch (deleteError) {
        console.warn(
          'Could not delete promo video from R2:',
          deleteError.message,
        );
      }
    }

    await Setting.findOneAndUpdate(
      { key: 'promoVideoUrl' },
      { value: null },
      { upsert: true },
    );

    res.json({ success: true, message: 'Promo video removed' });
  } catch (error) {
    console.error('Promo video delete error:', error);
    res.status(500).json({
      error: 'Failed to delete promo video',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
