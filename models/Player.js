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

// Enhanced pre-save middleware
playerSchema.pre('save', function (next) {
  if (this.isModified('seasons') && this.seasons && this.seasons.length > 0) {
    // Prioritize the season being modified (if provided in context) or the latest by registrationDate
    const modifiedSeason = this.seasons.find((s) =>
      this.isModified(`seasons.${this.seasons.indexOf(s)}`)
    );

    let targetSeason = modifiedSeason;
    if (!targetSeason) {
      // Fallback to the latest season by registrationDate or paymentDate
      targetSeason = this.seasons.reduce((latest, current) => {
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
    }

    // Update top-level fields based on target season
    if (targetSeason) {
      this.season = targetSeason.season;
      this.registrationYear = targetSeason.year;
      this.paymentStatus = targetSeason.paymentStatus;
      this.paymentComplete = targetSeason.paymentStatus === 'paid';
      this.registrationComplete = true;
      if (targetSeason.paymentDate) {
        this.lastPaymentDate = targetSeason.paymentDate;
      } else if (
        targetSeason.registrationDate &&
        targetSeason.paymentStatus === 'paid'
      ) {
        this.lastPaymentDate = targetSeason.registrationDate;
      }
    }

    console.log('Pre-save middleware:', {
      playerId: this._id,
      fullName: this.fullName,
      targetSeason: targetSeason
        ? {
            season: targetSeason.season,
            year: targetSeason.year,
            tryoutId: targetSeason.tryoutId,
            paymentStatus: targetSeason.paymentStatus,
            paymentComplete: targetSeason.paymentComplete,
          }
        : 'none',
      updatedFields: {
        season: this.season,
        registrationYear: this.registrationYear,
        paymentStatus: this.paymentStatus,
        paymentComplete: this.paymentComplete,
        registrationComplete: this.registrationComplete,
        lastPaymentDate: this.lastPaymentDate,
      },
    });
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
    registrationComplete: doc.registrationComplete,
    seasons: doc.seasons.map((s) => ({
      season: s.season,
      year: s.year,
      tryoutId: s.tryoutId,
      paymentStatus: s.paymentStatus,
      paymentComplete: s.paymentComplete,
      paymentDate: s.paymentDate,
      registrationDate: s.registrationDate,
    })),
  });
});

// Ensure unique index for season registrations per player
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
