// models/TicketPurchase.js
const mongoose = require('mongoose');

const ticketPurchaseSchema = new mongoose.Schema(
  {
    // Form/Submission reference
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Form',
      required: true,
    },
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FormSubmission',
      required: true,
    },

    // Customer information (no parent ID required)
    customerEmail: {
      type: String,
      required: true,
      index: true,
    },
    customerName: {
      type: String,
      required: false,
    },

    // Payment Details
    paymentId: { type: String, required: true },
    squarePaymentId: { type: String, required: true },
    locationId: { type: String, required: true },

    // Card Information
    cardLastFour: { type: String, required: true },
    cardBrand: { type: String, required: true },
    cardExpMonth: { type: String, required: true },
    cardExpYear: { type: String, required: true },

    // Purchase Details
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'CAD'],
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      required: true,
    },

    // Package/Ticket Details
    packageName: { type: String },
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number },

    // Additional Info
    receiptUrl: String,
    processedAt: { type: Date },

    // Metadata
    ipAddress: String,
    userAgent: String,

    // Timestamps
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

ticketPurchaseSchema.index({ customerEmail: 1, createdAt: -1 });
ticketPurchaseSchema.index({ formId: 1, status: 1 });
ticketPurchaseSchema.index({ submissionId: 1 }, { unique: true });
ticketPurchaseSchema.index({ paymentId: 1 }, { unique: true });
ticketPurchaseSchema.index({ squarePaymentId: 1 });

const TicketPurchase = mongoose.model('TicketPurchase', ticketPurchaseSchema);

module.exports = TicketPurchase;
