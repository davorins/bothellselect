const mongoose = require('mongoose');

const aiSettingsSchema = new mongoose.Schema(
  {
    // Singleton settings document
    key: {
      type: String,
      unique: true,
      default: 'default',
      immutable: true,
    },

    enabled: {
      type: Boolean,
      default: true,
    },

    // Phase 1: always require human approval.
    automaticRepliesEnabled: {
      type: Boolean,
      default: false,
    },

    confidenceThreshold: {
      type: Number,
      min: 0,
      max: 100,
      default: 95,
    },

    tone: {
      type: String,
      enum: ['professional', 'friendly', 'concise'],
      default: 'professional',
    },

    // Categories that may eventually be eligible for automatic replies.
    allowedAutomaticCategories: {
      type: [String],
      default: [],
    },

    // Categories/rules that always require human review.
    alwaysRequireHumanReview: {
      type: [String],
      default: ['payments', 'refunds', 'complaints', 'teams', 'exceptions'],
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('AiSettings', aiSettingsSchema);
