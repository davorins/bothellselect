const mongoose = require('mongoose');

const seasonRegistrationSchema = new mongoose.Schema(
  {
    season: { type: String, required: true },
    year: { type: Number, required: true },
    tryoutId: { type: String, default: null },
    registrationDate: { type: Date, default: Date.now },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentId: String,
    paymentMethod: String,
    amountPaid: Number,
    cardLast4: String,
    cardBrand: String,
    paymentDate: Date,
  },
  { _id: false }
);

const playerSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    gender: { type: String, required: true },
    dob: { type: Date, required: true },
    schoolName: { type: String, required: true },
    grade: { type: String, required: true },
    healthConcerns: { type: String },
    aauNumber: { type: String },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    registrationYear: { type: Number },
    season: { type: String },
    seasons: [seasonRegistrationSchema],
    registrationComplete: { type: Boolean, default: true },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    lastPaymentDate: Date,
    avatar: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

playerSchema.virtual('currentSeason').get(function () {
  if (this.seasons && this.seasons.length > 0) {
    return this.seasons[this.seasons.length - 1].season;
  }
  return this.season;
});

playerSchema.virtual('currentRegistrationYear').get(function () {
  if (this.seasons && this.seasons.length > 0) {
    return this.seasons[this.seasons.length - 1].year;
  }
  return this.registrationYear;
});

playerSchema.index(
  {
    parentId: 1,
    'seasons.season': 1,
    'seasons.year': 1,
    'seasons.tryoutId': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'seasons.season': { $exists: true } },
  }
);

module.exports = mongoose.model('Player', playerSchema);
