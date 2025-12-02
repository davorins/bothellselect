const mongoose = require('mongoose');

const PricingPackageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
});

const RegistrationFormConfigSchema = new mongoose.Schema(
  {
    season: { type: String, required: true },
    year: { type: Number, required: true },
    isActive: { type: Boolean, default: false },
    requiresPayment: { type: Boolean, default: true },
    requiresQualification: { type: Boolean, default: false },
    pricing: {
      basePrice: { type: Number, default: 0 },
      packages: [PricingPackageSchema],
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index
RegistrationFormConfigSchema.index({ season: 1, year: 1 }, { unique: true });

module.exports = mongoose.model(
  'RegistrationFormConfig',
  RegistrationFormConfigSchema
);
