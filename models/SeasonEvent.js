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
    isActive: { type: Boolean, default: true },
    isActiveOverride: {
      type: String,
      enum: ['auto', 'always-on', 'always-off'],
      default: 'auto',
    },

    // Audit
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Parent' },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Parent' },
    lastModifiedAt: Date,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('SeasonEvent', SeasonEventSchema);
