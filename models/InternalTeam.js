// models/InternalTeam.js
const mongoose = require('mongoose');

const internalTeamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
    },
    grade: {
      type: String,
      required: true,
    },
    gender: {
      type: String,
      enum: ['Male', 'Female'],
      required: true,
    },
    coachIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
      },
    ],
    playerIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
      },
    ],
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    tryoutSeason: {
      type: String,
      required: true,
      default: 'Basketball Select Tryout',
    },
    tryoutYear: {
      type: Number,
      required: true,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Updated index (removed season)
internalTeamSchema.index({ name: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('InternalTeam', internalTeamSchema);
