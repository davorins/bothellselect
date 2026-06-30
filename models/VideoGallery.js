// models/VideoGallery.js
const mongoose = require('mongoose');

const VideoGallerySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    date: {
      type: Date,
      default: null,
    },
    grade: {
      type: String,
      trim: true,
      default: '',
    },

    // 'upload' = native file stored on R2. 'youtube' = embedded YouTube video.
    sourceType: {
      type: String,
      enum: ['upload', 'youtube'],
      default: 'upload',
      required: true,
    },

    // ── Native upload fields (sourceType === 'upload') ─────────────────────
    videoUrl: {
      type: String,
      trim: true,
      default: '',
    },
    videoKey: {
      type: String, // R2 key for deletion
      trim: true,
      default: '',
    },
    fileSize: {
      type: Number, // bytes
      default: 0,
    },
    mimeType: {
      type: String,
      default: '',
    },

    // ── YouTube fields (sourceType === 'youtube') ───────────────────────────
    youtubeId: {
      type: String,
      trim: true,
      default: '',
    },
    youtubeUrl: {
      type: String, // original URL the admin pasted, kept for reference
      trim: true,
      default: '',
    },

    // ── Shared fields ────────────────────────────────────────────────────
    thumbnailUrl: {
      type: String,
      trim: true,
      default: '',
    },
    thumbnailKey: {
      type: String,
      trim: true,
      default: '',
    },
    duration: {
      type: Number, // seconds, set client-side after load (upload only)
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt — newest first sort uses createdAt
  },
);

// Require the right identifier depending on source type
VideoGallerySchema.pre('validate', function (next) {
  if (this.sourceType === 'upload' && !this.videoUrl) {
    return next(new Error('videoUrl is required for uploaded videos'));
  }
  if (this.sourceType === 'youtube' && !this.youtubeId) {
    return next(new Error('youtubeId is required for YouTube videos'));
  }
  next();
});

// Index for fast retrieval: active videos newest first
VideoGallerySchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model('VideoGallery', VideoGallerySchema);
