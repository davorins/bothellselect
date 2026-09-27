// models/Team.js
const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    year: { type: Number, required: true }, // "Team Year" from form
    grade: { type: String, required: true },
    sex: { type: String, enum: ['Male', 'Female'], required: true },

    // Tryout specific fields
    tryoutSeason: { type: String, required: true },
    tryoutYear: { type: Number, required: true },

    // Players selected from tryouts
    playerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],

    // Optional fields (not required for tryout-based creation)
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver', null],
      default: null,
    },
    tournament: { type: String, default: '' },

    // Keep registrationYear for backward compatibility (auto-populated from year)
    registrationYear: { type: Number },

    coachIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parent' }],
    notes: { type: String, default: '' },

    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },

    tournaments: [
      {
        tournament: String,
        year: Number,
        registrationDate: { type: Date, default: Date.now },
        paymentComplete: { type: Boolean, default: false },
        paymentStatus: {
          type: String,
          enum: ['pending', 'paid', 'failed'],
          default: 'pending',
        },
        amountPaid: { type: Number, default: 0 },
        paymentId: { type: String },
        paymentMethod: { type: String },
        cardLast4: { type: String },
        cardBrand: { type: String },
        levelOfCompetition: { type: String, enum: ['Gold', 'Silver'] },
      },
    ],

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deactivatedAt: { type: Date },
    deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Team', teamSchema);
