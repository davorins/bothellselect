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
      ref: 'User',
      required: true,
    },

    playerIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
        required: true,
      },
    ],

    // Square Payment Details
    paymentId: { type: String, required: true }, // Square transaction ID
    orderId: { type: String }, // Your internal order reference
    locationId: { type: String, required: true }, // Square location ID

    // Card Information (safe to store)
    cardLastFour: { type: String, required: true },
    cardBrand: { type: String, required: true },
    cardExpMonth: { type: String, required: true },
    cardExpYear: { type: String, required: true },

    // Payment Details
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'CAD'], // Add other currencies as needed
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      required: true,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
    },

    // Additional Info
    receiptUrl: String,
    refunds: [
      {
        refundId: { type: String },
        squareRefundId: { type: String },
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
          enum: ['web', 'square_dashboard', 'api'],
          default: 'web',
        },
      },
    ],

    // Track overall refund status
    refundedAmount: { type: Number, default: 0 },
    refundStatus: {
      type: String,
      enum: ['none', 'partial', 'full', 'processing'],
      default: 'none',
    },

    // Metadata
    ipAddress: String, // For fraud detection
    deviceFingerprint: String,

    // Audit Log
    statusHistory: [
      {
        status: String,
        changedAt: Date,
        reason: String,
      },
    ],
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

paymentSchema.index({ paymentId: 1 }, { unique: true });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ parentId: 1, status: 1 });
paymentSchema.index({ parentId: 1, createdAt: -1 });
paymentSchema.index({ playerIds: 1 });
paymentSchema.index({ status: 1, createdAt: -1 });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
