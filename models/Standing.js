const mongoose = require('mongoose');

const standingSchema = new mongoose.Schema(
  {
    tournament: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    group: {
      type: String,
    },
    played: {
      type: Number,
      default: 0,
    },
    wins: {
      type: Number,
      default: 0,
    },
    losses: {
      type: Number,
      default: 0,
    },
    draws: {
      type: Number,
      default: 0,
    },
    pointsFor: {
      type: Number,
      default: 0,
    },
    pointsAgainst: {
      type: Number,
      default: 0,
    },
    pointsDifference: {
      type: Number,
      default: 0,
    },
    points: {
      type: Number,
      default: 0,
    },
    rank: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

standingSchema.index({ tournament: 1, team: 1 }, { unique: true });
standingSchema.index({ tournament: 1, group: 1, points: -1 });
standingSchema.index({ tournament: 1, rank: 1 });

module.exports = mongoose.model('Standing', standingSchema);
