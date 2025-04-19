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
        amount: Number,
        reason: String,
        processedAt: Date,
        refundId: String, // Square refund ID
      },
    ],

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

// Add index for faster queries
paymentSchema.index({ playerId: 1 });
paymentSchema.index({ parentId: 1 });
paymentSchema.index({ paymentId: 1 }, { unique: true });
paymentSchema.index({ status: 1 });
paymentSchema.index({ createdAt: -1 });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
