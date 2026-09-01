const mongoose = require('mongoose');

if (mongoose.models.MarketingAttribution) {
  module.exports = mongoose.model('MarketingAttribution');
} else {
  const marketingAttributionSchema = new mongoose.Schema(
    {
      parentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        required: true,
        index: true,
      },
      registrationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Registration',
        index: true,
      },
      source: {
        type: String,
        required: true,
        default: 'direct',
        index: true,
      },
      medium: {
        type: String,
        default: 'none',
        index: true,
      },
      campaign: {
        type: String,
        default: 'none',
        index: true,
      },
      content: {
        type: String,
        default: 'none',
      },
      term: {
        type: String,
        default: 'none',
      },
      eventType: {
        type: String,
        enum: ['player', 'tryout', 'training', 'tournament'],
        default: 'player',
        index: true,
      },
      eventId: {
        type: String,
        default: null,
      },
      firstTouchAt: {
        type: Date,
        default: Date.now,
      },
      registrationAt: {
        type: Date,
        default: Date.now,
      },
      userAgent: {
        type: String,
        default: null,
      },
      ipAddress: {
        type: String,
        default: null,
      },
      referrer: {
        type: String,
        default: null,
      },
      landingPage: {
        type: String,
        default: null,
      },
    },
    {
      timestamps: true,
    },
  );

  // Compound indexes for faster queries
  marketingAttributionSchema.index({ parentId: 1, registrationId: 1 });
  marketingAttributionSchema.index({ source: 1, campaign: 1 });
  marketingAttributionSchema.index({ campaign: 1, eventType: 1 });
  marketingAttributionSchema.index({ createdAt: -1 });

  module.exports = mongoose.model(
    'MarketingAttribution',
    marketingAttributionSchema,
  );
}
