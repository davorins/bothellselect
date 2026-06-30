// routes/videoGallery.js
const express = require('express');
const multer = require('multer');
const VideoGallery = require('../models/VideoGallery');
const { uploadToR2, deleteFromR2, isR2Url } = require('../utils/r2');
const { authenticate } = require('../utils/auth');

const router = express.Router();

// ─── Multer: video upload, 500 MB ceiling ────────────────────────────────────
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4',
      'video/webm',
      'video/ogg',
      'video/quicktime',
      'video/x-msvideo',
      'video/mpeg',
    ];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(
          new Error(
            'Only video files are allowed (MP4, WebM, OGG, MOV, AVI, MPEG)',
          ),
          false,
        );
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20; // max videos per page for pagination

/**
 * Extract an 11-char YouTube video ID from any common URL shape, or a bare ID.
 *   - https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   - https://youtu.be/XXXXXXXXXXX
 *   - https://www.youtube.com/embed/XXXXXXXXXXX
 *   - https://www.youtube.com/shorts/XXXXXXXXXXX
 *   - XXXXXXXXXXX (bare ID, 11 chars)
 */
function extractYouTubeId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Bare 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/watch\?.*&v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /video-gallery
 * Returns paginated list of active videos, newest first.
 * Query params: page (default 1), limit (default 20, max 50)
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit) || PAGE_SIZE),
    );
    const skip = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      VideoGallery.find({ isActive: true })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-__v')
        .lean(),
      VideoGallery.countDocuments({ isActive: true }),
    ]);

    res.json({
      success: true,
      data: videos,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: skip + videos.length < total,
      },
    });
  } catch (error) {
    console.error('Error fetching video gallery:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
});

/**
 * GET /video-gallery/:id
 * Single video by ID.
 */
router.get('/:id', async (req, res) => {
  try {
    const video = await VideoGallery.findOne({
      _id: req.params.id,
      isActive: true,
    })
      .select('-__v')
      .lean();

    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    res.json({ success: true, data: video });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch video' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (require authentication + admin role)
// ─────────────────────────────────────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * POST /video-gallery
 * Upload a new native video file. Accepts multipart/form-data with:
 *   - video (file, required)
 *   - title, description, date, grade (optional text fields)
 */
router.post(
  '/',
  authenticate,
  requireAdmin,
  videoUpload.single('video'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      const {
        title = '',
        description = '',
        date = null,
        grade = '',
      } = req.body;

      console.log(
        `📹 Uploading gallery video: ${req.file.originalname} (${req.file.size} bytes)`,
      );

      const { url, key } = await uploadToR2(
        req.file.buffer,
        'gallery/videos',
        req.file.originalname,
      );

      const video = await VideoGallery.create({
        title: title.trim(),
        description: description.trim(),
        date: date ? new Date(date) : null,
        grade: grade.trim(),
        sourceType: 'upload',
        videoUrl: url,
        videoKey: key,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedBy: req.user.id,
      });

      console.log(`✅ Gallery video uploaded: ${url}`);

      res.status(201).json({ success: true, data: video });
    } catch (error) {
      console.error('Gallery video upload error:', error);
      res.status(500).json({
        error: 'Failed to upload video',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

/**
 * POST /video-gallery/youtube
 * Add a YouTube video by URL or bare video ID. No file upload — JSON body:
 *   - url (required) — full YouTube URL or 11-char video ID
 *   - title, description, date, grade (optional text fields)
 */
router.post('/youtube', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      url,
      title = '',
      description = '',
      date = null,
      grade = '',
    } = req.body;

    if (!url) {
      return res
        .status(400)
        .json({ error: 'YouTube URL or video ID is required' });
    }

    const youtubeId = extractYouTubeId(url);
    if (!youtubeId) {
      return res.status(400).json({
        error: 'Could not parse a valid YouTube video ID from that URL',
      });
    }

    const video = await VideoGallery.create({
      title: title.trim(),
      description: description.trim(),
      date: date ? new Date(date) : null,
      grade: grade.trim(),
      sourceType: 'youtube',
      youtubeId,
      youtubeUrl: url.trim(),
      thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`,
      uploadedBy: req.user.id,
    });

    console.log(`✅ YouTube video added: ${youtubeId}`);

    res.status(201).json({ success: true, data: video });
  } catch (error) {
    console.error('YouTube video add error:', error);
    res.status(500).json({
      error: 'Failed to add YouTube video',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * PATCH /video-gallery/:id
 * Update metadata (title, description, date, grade, isActive, duration).
 * Does NOT handle video file replacement — delete + re-add for that.
 */
router.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { title, description, date, grade, isActive, duration } = req.body;

    const update = {};
    if (title !== undefined) update.title = title.trim();
    if (description !== undefined) update.description = description.trim();
    if (date !== undefined) update.date = date ? new Date(date) : null;
    if (grade !== undefined) update.grade = grade.trim();
    if (isActive !== undefined) update.isActive = Boolean(isActive);
    if (duration !== undefined) update.duration = Number(duration) || 0;

    const video = await VideoGallery.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true },
    ).select('-__v');

    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    res.json({ success: true, data: video });
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({ success: false, error: 'Failed to update video' });
  }
});

/**
 * DELETE /video-gallery/:id
 * Soft or hard delete. Pass ?hard=true to actually remove from R2 + DB.
 * YouTube videos have nothing to delete from R2 — hard delete just removes the DB row.
 * Default is soft-delete (isActive = false).
 */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const hard = req.query.hard === 'true';
    const video = await VideoGallery.findById(req.params.id);

    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    if (hard) {
      if (video.sourceType === 'upload') {
        if (video.videoKey || (video.videoUrl && isR2Url(video.videoUrl))) {
          try {
            await deleteFromR2(video.videoKey || video.videoUrl);
            console.log(`Deleted gallery video from R2: ${video.videoKey}`);
          } catch (r2Err) {
            console.warn('Could not delete video from R2:', r2Err.message);
          }
        }
      }
      if (
        video.thumbnailKey ||
        (video.thumbnailUrl && isR2Url(video.thumbnailUrl))
      ) {
        try {
          await deleteFromR2(video.thumbnailKey || video.thumbnailUrl);
        } catch (_) {
          /* thumbnail deletion is best-effort */
        }
      }
      await VideoGallery.findByIdAndDelete(req.params.id);
      return res.json({ success: true, message: 'Video permanently deleted' });
    }

    // Soft delete
    video.isActive = false;
    await video.save();
    res.json({ success: true, message: 'Video hidden from gallery' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ success: false, error: 'Failed to delete video' });
  }
});

/**
 * GET /video-gallery/admin/all
 * Admin view — returns all videos including inactive, newest first.
 */
router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const videos = await VideoGallery.find()
      .sort({ createdAt: -1 })
      .select('-__v')
      .lean();
    res.json({ success: true, data: videos });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
});

module.exports = router;
