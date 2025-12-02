const mongoose = require('mongoose');

const SeasonEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    season: { type: String, required: true },
    year: { type: Number, required: true },
    description: String,
    startDate: Date,
    endDate: Date,
    registrationOpen: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('SeasonEvent', SeasonEventSchema);
