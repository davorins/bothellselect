const mongoose = require('mongoose');

const mergeRequestSchema = new mongoose.Schema({
  fromParentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Parent',
    required: true,
  },
  toParentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Parent',
    required: true,
  },
  // Support both single player (legacy) and multiple players (bulk)
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
    required: false,
  },
  playerIds: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Player',
    required: false,
    default: [],
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined', 'expired'],
    default: 'pending',
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  respondedAt: Date,
});

// Index for cleanup
mergeRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
mergeRequestSchema.index({ token: 1 });

module.exports = mongoose.model('MergeRequest', mergeRequestSchema);
