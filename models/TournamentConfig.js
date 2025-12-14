// backend/models/TournamentConfig.js
const mongoose = require('mongoose');

const TournamentConfigSchema = new mongoose.Schema(
  {
    // Basic tournament info - ONLY tournamentName and tournamentYear
    tournamentName: { type: String, required: true, unique: true },
    tournamentYear: { type: Number, required: true },
    displayName: { type: String },

    // Tournament details
    registrationDeadline: { type: Date },
    tournamentDates: [{ type: Date }],
    locations: [{ type: String }],
    divisions: [{ type: String }],

    // Requirements
    requiresRoster: { type: Boolean, default: true },
    requiresInsurance: { type: Boolean, default: true },
    paymentDeadline: { type: Date },
    refundPolicy: {
      type: String,
      default: 'No refunds after registration deadline',
    },

    // Documents
    rulesDocumentUrl: { type: String },
    scheduleDocumentUrl: { type: String },

    // Pricing
    tournamentFee: { type: Number, required: true, default: 425 },

    // Status
    isActive: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('TournamentConfig', TournamentConfigSchema);
