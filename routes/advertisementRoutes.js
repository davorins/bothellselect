const express = require('express');
const router = express.Router();
const multer = require('multer');
const advertisementController = require('../controllers/advertisementController');
const {
  requireAuth,
  requireAdmin,
  optionalAuth,
} = require('../middleware/auth');

// Configure multer for advertisement images (same pattern as your upload.js)
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
      'image/svg+xml',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Only image files are allowed! (JPEG, JPG, PNG, GIF, WEBP, SVG)',
        ),
        false,
      );
    }
  },
});

// Public routes - use optionalAuth (doesn't require login)
router.get('/active', optionalAuth, advertisementController.getActiveAds);
router.post('/click/:adId', optionalAuth, advertisementController.recordClick);

// Admin routes - require authentication AND admin role
router.get(
  '/admin',
  requireAuth,
  requireAdmin,
  advertisementController.getAllAds,
);
router.get(
  '/admin/stats',
  requireAuth,
  requireAdmin,
  advertisementController.getAdStats,
);
router.get(
  '/admin/:id',
  requireAuth,
  requireAdmin,
  advertisementController.getAdById,
);

// Admin routes with file upload support
router.post(
  '/admin',
  requireAuth,
  requireAdmin,
  upload.fields([
    { name: 'desktopImage', maxCount: 1 },
    { name: 'mobileImage', maxCount: 1 },
  ]),
  advertisementController.createAd,
);

router.put(
  '/admin/:id',
  requireAuth,
  requireAdmin,
  upload.fields([
    { name: 'desktopImage', maxCount: 1 },
    { name: 'mobileImage', maxCount: 1 },
  ]),
  advertisementController.updateAd,
);

router.delete(
  '/admin/:id',
  requireAuth,
  requireAdmin,
  advertisementController.deleteAd,
);

module.exports = router;
