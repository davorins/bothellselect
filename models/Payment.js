// Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    // References
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: false,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: false,
    },

    playerIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
        required: false,
      },
    ],

    teamIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team',
        required: false,
      },
    ],

    // Payment system identifiers
    paymentId: {
      type: String,
      required: true,
    },
    paymentSystem: {
      type: String,
      enum: ['square', 'clover', 'stripe', 'paypal'],
      required: true,
    },
    configurationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentConfiguration',
      required: true,
    },

    // System-specific IDs - conditionally required
    locationId: {
      type: String,
      required: function () {
        return this.paymentSystem === 'square';
      },
    },
    merchantId: {
      type: String,
      required: function () {
        return this.paymentSystem === 'clover';
      },
    },
    orderId: {
      type: String,
      required: false,
    },

    // Card Information
    cardLastFour: {
      type: String,
      required: true,
    },
    cardBrand: {
      type: String,
      required: true,
    },
    cardExpMonth: {
      type: String,
      required: true,
    },
    cardExpYear: {
      type: String,
      required: true,
    },

    // Payment Details
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'CAD', 'EUR', 'GBP'],
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      required: true,
    },

    // Buyer information
    buyerEmail: {
      type: String,
      required: true,
    },

    // Payment type
    paymentType: {
      type: String,
      enum: ['tryout', 'training', 'tournament', 'general'],
      default: 'general',
    },

    // Note/Description
    note: String,

    // Timestamps
    processedAt: {
      type: Date,
    },

    // Additional Info
    receiptUrl: String,

    // Player details for tryout/training payments
    players: [
      {
        playerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Player',
        },
        season: String,
        year: Number,
        tryoutId: String,
      },
    ],

    // Tournament details
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
    },
    tournamentName: String,
    year: Number,

    // Metadata for analytics
    metadata: {
      playerCount: Number,
      teamCount: Number,
      tournament: String,
      year: Number,
      amountPerPlayer: Number,
      amountPerTeam: Number,
    },

    // Refunds
    refunds: [
      {
        refundId: { type: String },
        externalRefundId: { type: String },
        amount: { type: Number, required: true },
        reason: String,
        status: {
          type: String,
          enum: ['pending', 'completed', 'failed', 'rejected'],
          default: 'pending',
        },
        processedAt: Date,
        notes: String,
        refundedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        source: {
          type: String,
          enum: ['web', 'admin_dashboard', 'api'],
          default: 'web',
        },
      },
    ],

    refundedAmount: {
      type: Number,
      default: 0,
    },
    refundStatus: {
      type: String,
      enum: ['none', 'partial', 'full', 'processing'],
      default: 'none',
    },

    // Metadata
    ipAddress: String,
    deviceFingerprint: String,
  },
  {
    timestamps: true,
  },
);

// Indexes
paymentSchema.index({ paymentId: 1 }, { unique: true });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ parentId: 1, status: 1 });
paymentSchema.index({ parentId: 1, createdAt: -1 });
paymentSchema.index({ playerIds: 1 });
paymentSchema.index({ teamIds: 1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ paymentSystem: 1 });
paymentSchema.index({ configurationId: 1 });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
