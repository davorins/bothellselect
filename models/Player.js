const mongoose = require('mongoose');

const tournamentRegistrationSchema = new mongoose.Schema(
  {
    tournament: { type: String, required: true },
    year: { type: Number, required: true },
    tournamentId: { type: String, default: null },
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
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver'],
      default: 'Gold',
    },
  },
  { _id: false }
);

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
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver'],
      default: 'Gold',
    },
    healthConcerns: { type: String },
    aauNumber: { type: String },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    registrationYear: { type: Number },
    season: { type: String },
    tournament: { type: String },
    seasons: [seasonRegistrationSchema],
    tournaments: [tournamentRegistrationSchema],
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

playerSchema.virtual('currentTournament').get(function () {
  if (this.tournaments && this.tournaments.length > 0) {
    return this.tournaments[this.tournaments.length - 1].tournament;
  }
  return this.tournament;
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

playerSchema.index(
  {
    parentId: 1,
    'tournaments.tournament': 1,
    'tournaments.year': 1,
    'tournaments.tournamentId': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'tournaments.tournament': { $exists: true } },
  }
);

module.exports = mongoose.model('Player', playerSchema);
