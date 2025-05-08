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
    avatar: {
      type: String,
      default: '',
    },
    read: {
      type: Boolean,
      default: false,
    },
    dismissedBy: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Parent', default: [] },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);
