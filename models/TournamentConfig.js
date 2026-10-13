// backend/models/TournamentConfig.js
const mongoose = require('mongoose');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdValidator = {
  validator: (v) => v === '' || v == null || YMD.test(v),
  message: (props) => `${props.value} is not a YYYY-MM-DD date`,
};

const TournamentConfigSchema = new mongoose.Schema(
  {
    // Basic tournament info - ONLY tournamentName and tournamentYear
    tournamentName: { type: String, required: true, unique: true },
    tournamentYear: { type: Number, required: true },
    displayName: { type: String },

    // Tournament details (calendar days stored as "YYYY-MM-DD")
    registrationDeadline: { type: String, validate: ymdValidator },
    tournamentDates: [{ type: String, validate: ymdValidator }],
    locations: [{ type: String }],
    divisions: [{ type: String }],
    description: { type: String, default: '' },

    // Requirements
    requiresRoster: { type: Boolean, default: true },
    requiresInsurance: { type: Boolean, default: true },
    paymentDeadline: { type: String, validate: ymdValidator },
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
  },
);

module.exports = mongoose.model('TournamentConfig', TournamentConfigSchema);
