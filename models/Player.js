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
    registrationComplete: { type: Boolean, default: false },
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

// Enhanced pre-save middleware
playerSchema.pre('save', function (next) {
  if (this.isModified('seasons')) {
    if (this.seasons && this.seasons.length > 0) {
      // Find the most recent season with payment or registration date
      const latestSeason = this.seasons.reduce((latest, current) => {
        const currentDate = current.paymentDate || current.registrationDate;
        const latestDate = latest?.paymentDate || latest?.registrationDate;

        if (
          !latest ||
          (currentDate && (!latestDate || currentDate > latestDate))
        ) {
          return current;
        }
        return latest;
      });

      // Update top-level fields
      this.season = latestSeason.season;
      this.registrationYear = latestSeason.year;
      this.paymentStatus = latestSeason.paymentStatus;
      this.paymentComplete = latestSeason.paymentStatus === 'paid';

      if (latestSeason.paymentDate) {
        this.lastPaymentDate = latestSeason.paymentDate;
      } else if (
        latestSeason.registrationDate &&
        latestSeason.paymentStatus === 'paid'
      ) {
        this.lastPaymentDate = latestSeason.registrationDate;
      }
    }
  }
  next();
});

// Post-save hook for verification
playerSchema.post('save', function (doc) {
  console.log('Player document saved:', {
    _id: doc._id,
    fullName: doc.fullName,
    paymentStatus: doc.paymentStatus,
    paymentComplete: doc.paymentComplete,
    seasons: doc.seasons.map((s) => ({
      season: s.season,
      year: s.year,
      tryoutId: s.tryoutId,
      paymentStatus: s.paymentStatus,
      paymentComplete: s.paymentComplete,
      paymentDate: s.paymentDate,
    })),
  });
});

playerSchema.index({ parentId: 1 });
playerSchema.index({
  'seasons.season': 1,
  'seasons.year': 1,
  'seasons.tryoutId': 1,
});

module.exports = mongoose.model('Player', playerSchema);
