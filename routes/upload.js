const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../utils/cloudinary');

const router = express.Router();

const storage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    return {
      folder: 'avatars',
      allowed_formats: ['jpg', 'png', 'jpeg', 'gif'],
      transformation: [{ width: 500, height: 500, crop: 'limit' }],
      public_id: `avatar_${req.params.id}_${Date.now()}`,
    };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Upload avatar endpoint
router.put('/parent/:id/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Return the Cloudinary URL and other details
    res.json({
      success: true,
      message: 'Avatar uploaded successfully',
      avatarUrl: req.file.path,
      publicId: req.file.filename,
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({
      error: 'Failed to upload avatar',
      details: error.message,
    });
  }
});

// Delete avatar endpoint
router.delete('/parent/:id/avatar', async (req, res) => {
  try {
    const { publicId } = req.body;

    if (!publicId) {
      return res.status(400).json({ error: 'Public ID is required' });
    }

    // Destroy the image on Cloudinary
    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result !== 'ok') {
      return res.status(404).json({ error: 'Avatar not found on Cloudinary' });
    }

    res.json({
      success: true,
      message: 'Avatar deleted successfully',
    });
  } catch (error) {
    console.error('Avatar deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete avatar',
      details: error.message,
    });
  }
});

module.exports = router;
