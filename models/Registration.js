const mongoose = require('mongoose');

// Check if model already exists
if (mongoose.models.Registration) {
  module.exports = mongoose.model('Registration');
} else {
  const registrationSchema = new mongoose.Schema(
    {
      player: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
        required: [true, 'Player reference is required'],
        index: true,
      },
      parent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        required: [true, 'Parent reference is required'],
        index: true,
      },
      season: {
        type: String,
        required: [true, 'Season is required'],
        enum: ['Spring', 'Summer', 'Fall', 'Winter'],
      },
      year: {
        type: Number,
        required: [true, 'Year is required'],
        min: [2020, 'Year must be 2020 or later'],
        max: [2030, 'Year must be 2030 or earlier'],
      },
      paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed'],
        default: 'pending',
      },
    },
    { timestamps: true }
  );

  // Add index for faster queries
  registrationSchema.index({ player: 1, season: 1, year: 1 }, { unique: true });

  module.exports = mongoose.model('Registration', registrationSchema);
}
