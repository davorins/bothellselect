const mongoose = require('mongoose');

// Venue Schema
const venueSchema = new mongoose.Schema({
  venueName: { type: String, required: true },
  address: String,
  city: String,
  state: String,
  zipCode: String,
  country: { type: String, default: 'US' },
  fullAddress: String,
  date: { type: Date, required: true },
  startTime: String,
  endTime: String,
  isPrimary: { type: Boolean, default: false },
  additionalInfo: String,
});

// Tournament Settings Schema
const tournamentSettingsSchema = new mongoose.Schema({
  startDate: Date,
  endDate: Date,
  startTime: String,
  endTime: String,
  isRefundable: { type: Boolean, default: false },
  refundPolicy: String,
  ticketCheckMethod: {
    type: String,
    enum: ['qr', 'email', 'manual', 'name-list', 'other'],
    default: 'qr',
  },
  customCheckMethod: String,
  venues: [venueSchema],
});

const formFieldSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: [
      'text',
      'email',
      'number',
      'tel',
      'url',
      'password',
      'textarea',
      'select',
      'checkbox',
      'radio',
      'date',
      'file',
      'payment',
      'section',
      'heading',
      'divider',
    ],
  },
  label: { type: String, required: true },
  name: { type: String, required: true },
  placeholder: String,
  helpText: String,
  required: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  defaultValue: mongoose.Schema.Types.Mixed,
  options: [
    {
      label: String,
      value: String,
      selected: { type: Boolean, default: false },
    },
  ],
  validation: {
    pattern: String,
    min: Number,
    max: Number,
    minLength: Number,
    maxLength: Number,
    customMessage: String,
  },
  style: {
    width: { type: String, default: '100%' },
    className: String,
    inline: { type: Boolean, default: false },
    rows: Number,
  },
  conditionalLogic: {
    dependsOn: String,
    condition: {
      type: String,
      enum: ['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan'],
    },
    value: mongoose.Schema.Types.Mixed,
    show: { type: Boolean, default: true },
  },
  fileConfig: {
    accept: String,
    maxSize: Number,
    multiple: { type: Boolean, default: false },
  },
  paymentConfig: {
    amount: { type: Number, default: 0 },
    description: { type: String, default: 'Payment for form submission' },
    currency: { type: String, default: 'USD' },
    recurring: { type: Boolean, default: false },
    recurringInterval: {
      type: String,
      enum: ['monthly', 'yearly', 'weekly'],
      default: 'monthly',
    },
    pricingPackages: [
      {
        name: { type: String, required: true },
        description: String,
        price: { type: Number, required: true },
        currency: { type: String, default: 'USD' },
        quantity: { type: Number, default: 1, min: 1 },
        maxQuantity: { type: Number, min: 1 },
        defaultSelected: { type: Boolean, default: false },
        isEnabled: { type: Boolean, default: true },
      },
    ],
    fixedPrice: { type: Boolean, default: true },
    squareAppId: String,
    squareLocationId: String,
    sandboxMode: { type: Boolean, default: true },
  },
});

const formSchema = new mongoose.Schema(
  {
    // Basic Info
    name: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: String,

    // Form Configuration
    fields: [formFieldSchema],
    settings: {
      submitText: { type: String, default: 'Submit' },
      resetText: { type: String, default: 'Reset' },
      successMessage: { type: String, default: 'Form submitted successfully!' },
      redirectUrl: String,
      sendEmail: { type: Boolean, default: false },
      emailTo: [String],
      emailTemplate: String,
      storeSubmissions: { type: Boolean, default: true },
      captcha: { type: Boolean, default: false },
      submitButtonStyle: {
        color: { type: String, default: '#007bff' },
        backgroundColor: { type: String, default: '#007bff' },
        textColor: { type: String, default: '#ffffff' },
      },
      paymentSettings: {
        squareAppId: String,
        squareLocationId: String,
        squareAccessToken: String,
        sandboxMode: { type: Boolean, default: true },
        currency: { type: String, default: 'USD' },
      },
    },

    // Tournament Settings - ADD THIS SECTION
    isTournamentForm: { type: Boolean, default: false },
    tournamentSettings: tournamentSettingsSchema,

    // Status & Metadata
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    version: { type: Number, default: 1 },

    // Embedding
    embedCode: String,
    shortcode: { type: String, unique: true },

    // Access Control
    allowedRoles: [{ type: String, enum: ['admin', 'user', 'guest'] }],
    passwordProtected: { type: Boolean, default: false },
    formPassword: String,

    // Analytics
    views: { type: Number, default: 0 },
    submissions: { type: Number, default: 0 },

    // Timestamps
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Parent' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    publishedAt: Date,
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for embed code generation
formSchema.virtual('embedHtml').get(function () {
  return `<div class="custom-form-container" data-form-id="${this._id}">
    <iframe 
      src="/forms/embed/${this._id}" 
      width="100%" 
      height="500" 
      frameborder="0" 
      style="border: none;"
      title="${this.title}"
    ></iframe>
  </div>`;
});

formSchema.virtual('shortcodeTag').get(function () {
  return `[form id="${this._id}"]`;
});

// Generate shortcode before saving
formSchema.pre('save', function (next) {
  this.updatedAt = Date.now();

  if (!this.shortcode) {
    const prefix = 'form_';
    const random = Math.random().toString(36).substr(2, 8);
    this.shortcode = `${prefix}${random}`;
  }

  if (this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  next();
});

// Indexes
formSchema.index({ status: 1, createdAt: -1 });
formSchema.index({ createdBy: 1 });
formSchema.index({ isTournamentForm: 1 });
formSchema.index({ 'tournamentSettings.startDate': 1 });

module.exports = mongoose.model('Form', formSchema);
