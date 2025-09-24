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
        required: false, // Optional for team registrations
        index: true,
      },
      parent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        required: [true, 'Parent reference is required'],
        index: true,
      },
      team: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team',
        required: false, // Optional for player registrations
        index: true,
      },
      season: {
        type: String,
        required: false, // Optional for team registrations
      },
      year: {
        type: Number,
        required: [true, 'Year is required'],
        min: [2020, 'Year must be 2020 or later'],
        max: [2030, 'Year must be 2030 or earlier'],
      },
      tournament: {
        type: String,
        required: false, // Required for team registrations, enforced in route
      },
      tryoutId: {
        type: String,
        required: false, // Optional for all registrations
        default: null,
      },
      levelOfCompetition: {
        type: String,
        enum: ['Gold', 'Silver'],
        required: false, // Optional for player registrations
      },
      paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'failed', 'refunded'],
        default: 'pending',
      },
      paymentComplete: { type: Boolean, default: false },
      paymentDetails: {
        amountPaid: { type: Number, min: 0 },
        currency: { type: String, default: 'USD' },
        paymentId: { type: String },
        paymentMethod: { type: String },
        cardLast4: { type: String },
        cardBrand: { type: String },
        paymentDate: { type: Date },
      },
      registrationComplete: { type: Boolean, default: false },
    },
    {
      timestamps: true,
      toJSON: { virtuals: true },
      toObject: { virtuals: true },
    }
  );

  // Unique index for player registrations (only when player exists)
  registrationSchema.index(
    { player: 1, season: 1, year: 1, tryoutId: 1 },
    { unique: true, partialFilterExpression: { player: { $exists: true } } }
  );

  // Unique index for team registrations (only when team exists)
  registrationSchema.index(
    { team: 1, tournament: 1, year: 1 },
    { unique: true, partialFilterExpression: { team: { $exists: true } } }
  );

  // Virtual for display name (season + year or tournament + year)
  registrationSchema.virtual('seasonYear').get(function () {
    if (this.season) {
      return `${this.season} ${this.year}`;
    } else if (this.tournament) {
      return `${this.tournament} ${this.year}`;
    }
    return this.year.toString();
  });

  // Virtual for payment status display
  registrationSchema.virtual('paymentStatusDisplay').get(function () {
    const statusMap = {
      pending: 'Pending Payment',
      paid: 'Paid',
      failed: 'Payment Failed',
      refunded: 'Refunded',
    };
    return statusMap[this.paymentStatus] || this.paymentStatus;
  });

  // Pre-save hook to update paymentComplete
  registrationSchema.pre('save', async function (next) {
    if (this.isModified('paymentStatus')) {
      this.paymentComplete = this.paymentStatus === 'paid';
      if (this.paymentStatus === 'paid' && !this.paymentDetails.paymentDate) {
        this.paymentDetails.paymentDate = new Date();
      }
    }
    next();
  });

  // Static method to update payment status
  registrationSchema.statics.updatePaymentStatus = async function (
    registrationId,
    status,
    paymentDetails = {}
  ) {
    return this.findByIdAndUpdate(
      registrationId,
      {
        $set: {
          paymentStatus: status,
          paymentComplete: status === 'paid',
          'paymentDetails.amountPaid': paymentDetails.amountPaid,
          'paymentDetails.paymentId': paymentDetails.paymentId,
          'paymentDetails.paymentMethod': paymentDetails.paymentMethod,
          'paymentDetails.cardLast4': paymentDetails.cardLast4,
          'paymentDetails.cardBrand': paymentDetails.cardBrand,
          'paymentDetails.paymentDate':
            status === 'paid' ? new Date() : undefined,
        },
      },
      { new: true }
    );
  };

  // Query helper for active registrations
  registrationSchema.query.active = function () {
    return this.where({ paymentComplete: true });
  };

  module.exports = mongoose.model('Registration', registrationSchema);
}
