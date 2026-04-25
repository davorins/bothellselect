// PaymentConfiguration.js
const mongoose = require('mongoose');

const paymentConfigurationSchema = new mongoose.Schema({
  paymentSystem: {
    type: String,
    enum: ['square', 'clover', 'stripe', 'paypal'],
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // Square configuration
  squareConfig: {
    accessToken: {
      type: String,
    },
    applicationId: String,
    environment: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox',
    },
    locationId: String,
    webhookSignatureKey: {
      type: String,
      select: false,
    },
  },
  // Clover configuration
  cloverConfig: {
    merchantId: String,
    accessToken: {
      type: String,
    },
    refreshToken: {
      type: String,
      select: false,
    },
    tokenExpiresAt: {
      type: Date,
    },
    environment: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox',
    },
    apiBaseUrl: {
      type: String,
      default: 'https://sandbox.dev.clover.com/v3',
    },
  },
  // Stripe configuration (optional for future)
  stripeConfig: {
    secretKey: { type: String, select: false },
    publishableKey: String,
    webhookSecret: { type: String, select: false },
  },
  // PayPal configuration (optional for future)
  paypalConfig: {
    clientId: { type: String, select: false },
    clientSecret: { type: String, select: false },
    environment: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox',
    },
  },
  // General settings
  settings: {
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'CAD', 'EUR', 'GBP'],
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    enableAutomaticRefunds: {
      type: Boolean,
      default: true,
    },
    enablePartialRefunds: {
      type: Boolean,
      default: true,
    },
    defaultPaymentDescription: String,
    receiptEmailTemplate: String,
  },
  // Webhook URLs (if any)
  webhookUrls: {
    paymentSuccess: String,
    paymentFailed: String,
    refundProcessed: String,
  },
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
});

// Update timestamp on save
paymentConfigurationSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// Hide sensitive fields by default
paymentConfigurationSchema.methods.toJSON = function () {
  const obj = this.toObject();

  // Remove sensitive fields
  delete obj.squareConfig?.accessToken;
  delete obj.squareConfig?.webhookSignatureKey;
  delete obj.cloverConfig?.accessToken;
  delete obj.cloverConfig?.refreshToken;
  delete obj.stripeConfig?.secretKey;
  delete obj.stripeConfig?.webhookSecret;
  delete obj.paypalConfig?.clientSecret;

  return obj;
};

const PaymentConfiguration = mongoose.model(
  'PaymentConfiguration',
  paymentConfigurationSchema,
);

module.exports = PaymentConfiguration;
