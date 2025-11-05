// routes/spotlightRoutes.js
const express = require('express');
const router = express.Router();
const Spotlight = require('../models/Spotlight');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../utils/cloudinary'); // Use your existing cloudinary util

// Auth middleware
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Create Cloudinary storage for spotlight images
const spotlightStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: (req, file) => {
    return {
      folder: 'bothell-select/spotlight',
      allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp'],
      transformation: [{ width: 1200, height: 800, crop: 'limit' }], // Optimize for display
      public_id: `spotlight_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
    };
  },
});

const upload = multer({
  storage: spotlightStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Create new spotlight (admin only)
router.post(
  '/',
  requireAuth,
  requireAdmin,
  upload.array('images', 6),
  async (req, res) => {
    try {
      const {
        title,
        description,
        category,
        playerNames,
        badges,
        date,
        featured,
      } = req.body;

      console.log('Request body:', req.body);
      console.log('Uploaded files:', req.files);

      // Cloudinary returns file information in req.files
      const imageFiles = (req.files || []).map(
        (file) => file.path // Cloudinary provides the URL in file.path
      );

      console.log('Cloudinary image URLs:', imageFiles);

      const doc = new Spotlight({
        title,
        description,
        category,
        playerNames: playerNames ? JSON.parse(playerNames) : [],
        badges: badges ? JSON.parse(badges) : [],
        images: imageFiles,
        date: date ? new Date(date) : undefined,
        featured: featured === 'true' || featured === true,
        createdBy: req.user._id,
      });

      await doc.save();

      console.log('Spotlight item created successfully:', doc._id);
      res.status(201).json(doc);
    } catch (err) {
      console.error('Error creating spotlight:', err);
      res.status(500).json({
        message: 'Error creating spotlight',
        error: err.message,
      });
    }
  }
);

// Get list (public)
router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.featured) q.featured = req.query.featured === 'true';
    if (req.query.category) q.category = req.query.category;
    const items = await Spotlight.find(q).sort({ featured: -1, date: -1 });
    res.json(items);
  } catch (err) {
    console.error('Error fetching spotlight items:', err);
    res.status(500).json({ message: 'Error fetching items' });
  }
});

// Get single
router.get('/:id', async (req, res) => {
  try {
    const item = await Spotlight.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (err) {
    console.error('Error fetching spotlight item:', err);
    res.status(500).json({ message: 'Error fetching item' });
  }
});

// Update (admin)
router.put(
  '/:id',
  requireAuth,
  requireAdmin,
  upload.array('images', 6),
  async (req, res) => {
    try {
      const item = await Spotlight.findById(req.params.id);
      if (!item)
        return res.status(404).json({ message: 'Spotlight item not found' });

      const {
        title,
        description,
        category,
        playerNames,
        badges,
        date,
        featured,
        removeImages,
      } = req.body;

      console.log('Update request - removeImages:', removeImages);
      console.log('Update request - new files:', req.files);

      // Update fields
      if (title !== undefined) item.title = title;
      if (description !== undefined) item.description = description;
      if (category !== undefined) item.category = category;
      item.playerNames = playerNames
        ? JSON.parse(playerNames)
        : item.playerNames;
      item.badges = badges ? JSON.parse(badges) : item.badges;
      if (date) item.date = new Date(date);
      item.featured = featured === 'true' || featured === true;

      // Remove images requested
      if (removeImages) {
        const toRemove = JSON.parse(removeImages);
        console.log('Images to remove:', toRemove);

        // Delete from Cloudinary
        for (const imageUrl of toRemove) {
          try {
            // Extract public_id from Cloudinary URL
            const urlParts = imageUrl.split('/');
            const publicIdWithExtension = urlParts[urlParts.length - 1];
            const publicId = publicIdWithExtension.split('.')[0];

            // The public_id in Cloudinary includes the folder path
            const fullPublicId = `bothell-select/spotlight/${publicId}`;
            console.log('Deleting from Cloudinary:', fullPublicId);

            const result = await cloudinary.uploader.destroy(fullPublicId);
            console.log('Cloudinary deletion result:', result);
          } catch (cloudinaryErr) {
            console.error('Error deleting from Cloudinary:', cloudinaryErr);
          }
        }

        item.images = item.images.filter((img) => !toRemove.includes(img));
      }

      // Add new uploaded images
      if (req.files && req.files.length) {
        const newImgs = req.files.map((file) => file.path);
        console.log('Adding new images:', newImgs);
        item.images = [...item.images, ...newImgs];
      }

      await item.save();
      res.json(item);
    } catch (err) {
      console.error('Error updating spotlight item:', err);
      res.status(500).json({
        message: 'Error updating item',
        error: err.message,
      });
    }
  }
);

// Delete (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const item = await Spotlight.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });

    console.log('Deleting spotlight item:', item._id);
    console.log('Images to delete from Cloudinary:', item.images);

    // Delete images from Cloudinary
    if (item.images && item.images.length > 0) {
      for (const imageUrl of item.images) {
        try {
          // Extract public_id from Cloudinary URL
          const urlParts = imageUrl.split('/');
          const publicIdWithExtension = urlParts[urlParts.length - 1];
          const publicId = publicIdWithExtension.split('.')[0];

          const fullPublicId = `bothell-select/spotlight/${publicId}`;
          console.log('Deleting image from Cloudinary:', fullPublicId);

          const result = await cloudinary.uploader.destroy(fullPublicId);
          console.log('Cloudinary deletion result:', result);
        } catch (cloudinaryErr) {
          console.error('Error deleting from Cloudinary:', cloudinaryErr);
        }
      }
    }

    await Spotlight.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error('Error deleting spotlight item:', err);
    res.status(500).json({ message: 'Error deleting' });
  }
});

module.exports = router;
