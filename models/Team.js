// Team.js
const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  coachIds: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
      index: true,
    },
  ], // Changed from coachId to coachIds (array)
  grade: { type: String, required: true },
  sex: { type: String, enum: ['Male', 'Female', 'Coed'], required: true },
  levelOfCompetition: {
    type: String,
    enum: ['Gold', 'Silver'],
    required: true,
  },
  tournaments: [
    {
      tournament: { type: String, required: true },
      year: { type: Number, required: true },
      levelOfCompetition: {
        type: String,
        enum: ['Gold', 'Silver'],
        required: true,
      },
      registrationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Registration',
      },
      paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'failed', 'refunded'],
        default: 'pending',
      },
      paymentComplete: { type: Boolean, default: false },
      paymentDate: { type: Date },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Team', teamSchema);
