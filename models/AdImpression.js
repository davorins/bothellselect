const mongoose = require('mongoose');

const adImpressionSchema = new mongoose.Schema({
  adId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Advertisement',
    required: true,
  },
  userId: {
    type: String, // Can be user ID or session ID for guests
    required: true,
  },
  userType: {
    type: String,
    enum: ['authenticated', 'guest'],
    default: 'guest',
  },
  userRole: String,
  viewedAt: {
    type: Date,
    default: Date.now,
    expires: 90 * 24 * 60 * 60, // Auto-delete after 90 days
  },
  clicked: {
    type: Boolean,
    default: false,
  },
  clickedAt: Date,
  ipAddress: String,
  userAgent: String,
  pageUrl: String,
});

// Compound index for checking impressions
adImpressionSchema.index({ adId: 1, userId: 1, viewedAt: -1 });
adImpressionSchema.index({ viewedAt: -1 });

module.exports = mongoose.model('AdImpression', adImpressionSchema);
