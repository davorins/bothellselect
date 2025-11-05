// models/Spotlight.js
const mongoose = require('mongoose');

const SpotlightSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    category: {
      type: String,
      enum: ['Team', 'Player', 'Other'],
      default: 'Other',
    },
    playerNames: [String],
    badges: [String],
    images: [String], // URLs (public path or S3 URL)
    date: { type: Date, default: Date.now },
    featured: { type: Boolean, default: false }, // show at top
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Spotlight', SpotlightSchema);
