const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
    dismissedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        default: [],
      },
    ],
    targetType: {
      type: String,
      enum: ['all', 'season', 'individual'],
      default: 'all',
      required: true,
    },
    parentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        default: [],
      },
    ],
    targetSeason: {
      type: String,
    },
    targetYear: {
      type: Number,
    },
    seasonName: {
      type: String,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ parentIds: 1 });
notificationSchema.index({ dismissedBy: 1 });
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ targetType: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
