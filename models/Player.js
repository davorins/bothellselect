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
    packageType: String,
    amountPaid: Number,
    paymentId: String,
    paymentMethod: String,
    cardLast4: String,
    cardBrand: String,
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
      required: [true, 'Parent ID is required'],
    },
    registrationYear: { type: Number },
    season: { type: String },
    seasons: [seasonRegistrationSchema],
    registrationComplete: { type: Boolean, default: false },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    lastPaymentDate: Date,
    avatar: {
      type: String,
      default: function () {
        return this.gender === 'Female'
          ? 'https://bothell-select.onrender.com/uploads/avatars/girl.png'
          : 'https://bothell-select.onrender.com/uploads/avatars/boy.png';
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Middleware to update top-level fields when seasons array changes
playerSchema.pre('save', function (next) {
  if (this.isModified('seasons') && this.seasons.length > 0) {
    // Find the most recent season with payment status
    const paidSeasons = this.seasons.filter((s) => s.paymentStatus === 'paid');
    const latestSeason =
      paidSeasons.length > 0
        ? paidSeasons.reduce((latest, current) =>
            new Date(current.registrationDate) >
            new Date(latest.registrationDate)
              ? current
              : latest
          )
        : this.seasons.reduce((latest, current) =>
            new Date(current.registrationDate) >
            new Date(latest.registrationDate)
              ? current
              : latest
          );

    this.season = latestSeason.season;
    this.registrationYear = latestSeason.year;
    this.paymentStatus = latestSeason.paymentStatus;
    this.paymentComplete = latestSeason.paymentStatus === 'paid';

    if (latestSeason.paymentStatus === 'paid') {
      this.lastPaymentDate = latestSeason.registrationDate;
    }
  }
  next();
});

// Virtual for easy access to current season
playerSchema.virtual('currentSeason').get(function () {
  if (this.seasons && this.seasons.length > 0) {
    return this.seasons.reduce((latest, current) =>
      !latest ||
      new Date(current.registrationDate) > new Date(latest.registrationDate)
        ? current
        : latest
    );
  }
  return null;
});

playerSchema.index({ parentId: 1 });
playerSchema.index({
  'seasons.season': 1,
  'seasons.year': 1,
  'seasons.tryoutId': 1,
});

module.exports = mongoose.model('Player', playerSchema);
