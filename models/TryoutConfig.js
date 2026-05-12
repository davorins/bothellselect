// models/TryoutConfig.js
const mongoose = require('mongoose');

// New schema for tryout sessions (grade-specific times)
const TryoutSessionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  number: { type: Number, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  grades: { type: String, required: true },
});

// New schema for structured location
const TryoutLocationSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  zipCode: { type: String, default: '' },
});

// New schema for structured tryout details
const TryoutDetailsSchema = new mongoose.Schema({
  startDate: { type: String, default: '' },
  endDate: { type: String, default: '' },
  duration: { type: String, default: '' },
  gender: { type: String, default: '' },
  days: [{ type: String }],
  location: { type: TryoutLocationSchema, default: () => ({}) },
  tryoutSessions: [TryoutSessionSchema],
  notes: [{ type: String }],
  dropOffTime: { type: String, default: '' },
  pickUpTime: { type: String, default: '' },
  hasLimitedSpots: { type: Boolean, default: false },
  contactEmail: { type: String, default: '' },
  ageGroups: [{ type: String }],
  maxParticipants: { type: Number, default: null },
  whatToBring: [{ type: String }],
});

const TryoutConfigSchema = new mongoose.Schema(
  {
    // Basic tryout info
    tryoutName: { type: String, required: true, unique: true },
    tryoutYear: { type: Number, required: true },
    displayName: { type: String },

    // Link to season event
    eventId: { type: String, required: true },
    season: { type: String, required: true },

    // Tryout details - OLD FIELDS (kept for backward compatibility, but deprecated)
    registrationDeadline: { type: Date },
    divisions: [{ type: String }],
    ageGroups: [{ type: String }],
    description: { type: String, default: '' },

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

    // NEW: Structured tryout details
    tryoutDetails: { type: TryoutDetailsSchema, default: () => ({}) },
  },
  {
    timestamps: true,
  },
);

// Index for efficient queries
TryoutConfigSchema.index({ eventId: 1 });
TryoutConfigSchema.index({ season: 1, tryoutYear: -1 });
TryoutConfigSchema.index({ isActive: 1 });

module.exports = mongoose.model('TryoutConfig', TryoutConfigSchema);
