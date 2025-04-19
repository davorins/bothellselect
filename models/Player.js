const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    gender: { type: String, required: true },
    dob: {
      type: Date,
      required: true,
      validate: {
        validator: function (value) {
          return value instanceof Date && !isNaN(value);
        },
        message: 'Invalid date of birth',
      },
    },
    schoolName: { type: String, required: true },
    grade: { type: String, required: true },
    healthConcerns: { type: String },
    aauNumber: { type: String },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    registrationYear: { type: Number, required: true },
    season: { type: String, required: true },
    registrationComplete: { type: Boolean, default: false },
    paymentComplete: { type: Boolean, default: false },
  },
  { timestamps: true }
);

playerSchema.index({ parentId: 1 });

module.exports = mongoose.model('Player', playerSchema);
