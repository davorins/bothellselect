// models/RegistrationFormConfig.js
const mongoose = require('mongoose');

const PricingPackageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
});

// Add these new schemas for training details
const TrainingLocationSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  zipCode: { type: String, default: '' },
});

const TrainingSessionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  number: { type: Number, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  grades: { type: String, required: true },
});

const TrainingDetailsSchema = new mongoose.Schema({
  startDate: { type: String, default: '' },
  endDate: { type: String, default: '' },
  duration: { type: String, default: '' },
  gender: { type: String, default: '' },
  days: [{ type: String }],
  location: { type: TrainingLocationSchema, default: () => ({}) },
  trainingSessions: [TrainingSessionSchema],
  notes: [{ type: String }],
  dropOffTime: { type: String, default: '' },
  pickUpTime: { type: String, default: '' },
  hasLimitedSpots: { type: Boolean, default: false },
  contactEmail: { type: String, default: '' },
  ageGroups: [{ type: String }],
  maxParticipants: { type: Number, default: null },
});

const RegistrationFormConfigSchema = new mongoose.Schema(
  {
    // Reference the SeasonEvent by eventId
    eventId: {
      type: String,
      required: true,
      ref: 'SeasonEvent',
    },
    // Backward compatibility and easier querying
    season: { type: String, required: true },
    year: { type: Number, required: true },
    isActive: { type: Boolean, default: false },
    requiresPayment: { type: Boolean, default: true },
    requiresQualification: { type: Boolean, default: false },
    description: { type: String, default: '' },
    pricing: {
      basePrice: { type: Number, default: 0 },
      packages: [PricingPackageSchema],
    },
    // New field for structured training details
    trainingDetails: { type: TrainingDetailsSchema, default: () => ({}) },
  },
  {
    timestamps: true,
  },
);

// Unique index on eventId
RegistrationFormConfigSchema.index({ eventId: 1 }, { unique: true });
// Season-year index for backward compatibility
RegistrationFormConfigSchema.index({ season: 1, year: 1 }, { unique: false });

module.exports = mongoose.model(
  'RegistrationFormConfig',
  RegistrationFormConfigSchema,
);
