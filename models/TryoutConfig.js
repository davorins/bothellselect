const mongoose = require('mongoose');

const TryoutConfigSchema = new mongoose.Schema(
  {
    // Basic tryout info
    tryoutName: { type: String, required: true, unique: true },
    tryoutYear: { type: Number, required: true },
    displayName: { type: String },

    // Tryout details
    registrationDeadline: { type: Date },
    tryoutDates: [{ type: Date }],
    locations: [{ type: String }],
    divisions: [{ type: String }],
    ageGroups: [{ type: String }],

    // Requirements
    requiresPayment: { type: Boolean, default: true },
    requiresRoster: { type: Boolean, default: false },
    requiresInsurance: { type: Boolean, default: true },
    paymentDeadline: { type: Date },
    refundPolicy: {
      type: String,
      default: 'No refunds after tryout registration deadline',
    },

    // Pricing
    tryoutFee: { type: Number, required: true, default: 50 },

    // Status
    isActive: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('TryoutConfig', TryoutConfigSchema);
