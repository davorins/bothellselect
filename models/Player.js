const mongoose = require('mongoose');

const seasonRegistrationSchema = new mongoose.Schema(
  {
    season: { type: String, required: true },
    year: { type: Number, required: true },
    registrationDate: { type: Date, default: Date.now },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    packageType: String,
    amountPaid: Number,
  },
  { _id: false }
);

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
    registrationYear: { type: Number },
    season: { type: String },
    seasons: [seasonRegistrationSchema],
    registrationComplete: { type: Boolean, default: false },
    paymentComplete: { type: Boolean, default: false },
    avatar: {
      type: String,
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    lastPaymentDate: Date,
  },
  { timestamps: true }
);

// Middleware to update top-level season fields when seasons array changes
playerSchema.pre('save', function (next) {
  if (this.isModified('seasons') && this.seasons.length > 0) {
    // Find the most recent season by registrationDate
    const latestSeason = [...this.seasons].sort(
      (a, b) => new Date(b.registrationDate) - new Date(a.registrationDate)
    )[0];

    this.season = latestSeason.season;
    this.registrationYear = latestSeason.year;

    // Also update payment status if needed
    this.paymentStatus = latestSeason.paymentStatus;
    this.paymentComplete = latestSeason.paymentComplete;
    if (latestSeason.paymentComplete) {
      this.lastPaymentDate = latestSeason.registrationDate;
    }
  }
  next();
});

// Virtual for easy access to current season
playerSchema.virtual('currentSeason').get(function () {
  if (this.seasons && this.seasons.length > 0) {
    return this.seasons.reduce((latest, current) =>
      !latest || current.registrationDate > latest.registrationDate
        ? current
        : latest
    );
  }
  return null;
});

playerSchema.set('toJSON', { virtuals: true });
playerSchema.set('toObject', { virtuals: true });

playerSchema.index({ parentId: 1 });
playerSchema.index({ 'seasons.season': 1, 'seasons.year': 1 });
playerSchema.index({ season: 1, registrationYear: 1 });

module.exports = mongoose.model('Player', playerSchema);
