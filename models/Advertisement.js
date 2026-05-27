const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  // Basic info
  title: {
    type: String,
    trim: true,
    // Make title optional - can use businessName as fallback
  },
  description: {
    type: String,
    trim: true,
  },

  // Media assets
  desktopImage: {
    url: String,
    publicId: String,
    alt: String,
    fileSize: Number,
  },
  mobileImage: {
    url: String,
    publicId: String,
    alt: String,
    fileSize: Number,
  },

  // Links & CTAs
  clickUrl: {
    type: String,
    trim: true,
  },
  ctaText: {
    type: String,
    default: 'Learn More',
  },

  // Business contact info
  businessName: {
    type: String,
    required: true,
  },
  contactEmail: String,
  contactPhone: String,
  website: String,

  // Display settings
  displayOrder: {
    type: Number,
    default: 0,
  },
  placement: {
    type: String,
    enum: ['sidebar', 'header', 'footer', 'inline', 'popup'],
    default: 'sidebar',
  },

  // Targeting
  targetRoles: [
    {
      type: String,
      enum: ['admin', 'coach', 'parent', 'student', 'guest'],
    },
  ],
  targetPages: [String],

  // Frequency capping
  showOnceOnly: {
    type: Boolean,
    default: true,
  },
  cooldownDays: {
    type: Number,
    default: 45,
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
  },
  startDate: Date,
  endDate: Date,

  // Analytics
  impressions: {
    type: Number,
    default: 0,
  },
  clicks: {
    type: Number,
    default: 0,
  },

  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Parent',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: Date,
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Parent',
  },
  isPreview: {
    type: Boolean,
    default: false,
  },
});

// Index for efficient queries
adSchema.index({ isActive: 1, placement: 1, displayOrder: 1 });
adSchema.index({ startDate: 1, endDate: 1 });

// Virtual for thumbnail
adSchema.virtual('thumbnail').get(function () {
  return this.desktopImage?.url || this.mobileImage?.url;
});

module.exports = mongoose.model('Advertisement', adSchema);
