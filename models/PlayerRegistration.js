// backend/models/PlayerRegistration.js
const mongoose = require('mongoose');

// Define the PlayerRegistration schema
const playerRegistrationSchema = new mongoose.Schema({
  playerId: {
    type: mongoose.Schema.Types.ObjectId, // References the Player model
    required: true,
  },
  season: {
    type: String,
    required: true,
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
    required: true,
  },
  schoolName: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Create the PlayerRegistration model
const PlayerRegistration = mongoose.model(
  'PlayerRegistration',
  playerRegistrationSchema
);

// Export the model
module.exports = PlayerRegistration;
