const mongoose = require('mongoose');

const aiEmailSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    threadId: {
      type: String,
      trim: true,
      default: null,
    },
    from: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    originalFrom: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    replyToEmail: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    to: {
      type: String,
      trim: true,
      default: null,
    },
    subject: {
      type: String,
      trim: true,
      default: '',
    },
    body: {
      type: String,
      required: true,
    },
    receivedAt: {
      type: Date,
      required: true,
    },

    category: {
      type: String,
      enum: [
        'tryouts',
        'registration',
        'payments',
        'schedules',
        'teams',
        'practices',
        'programs',
        'technical',
        'general',
        'other',
      ],
      default: 'other',
    },
    confidence: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    aiDraft: {
      type: String,
      default: '',
    },
    aiReason: {
      type: String,
      default: '',
    },
    dataUsed: {
      type: [String],
      default: [],
    },

    status: {
      type: String,
      enum: [
        'new',
        'draft_ready',
        'reviewed',
        'sent',
        'rejected',
        'skipped',
        'ignored',
      ],
      default: 'new',
      index: true,
    },
    skipReason: {
      type: String,
      default: '',
    },
    requiresHumanReview: {
      type: Boolean,
      default: true,
      index: true,
    },
    reviewReason: {
      type: String,
      default: '',
    },

    humanEditedDraft: {
      type: String,
      default: '',
    },
    finalResponse: {
      type: String,
      default: '',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    sentMessageId: {
      type: String,
      default: null,
    },
    autoSent: {
      type: Boolean,
      default: false,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      default: null,
      index: true,
    },
    playerIds: {
      type: [String],
      default: [],
    },
    registrationIds: {
      type: [String],
      default: [],
    },
    paymentIds: {
      type: [String],
      default: [],
    },
    teamIds: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

aiEmailSchema.index({ status: 1, receivedAt: -1 });
aiEmailSchema.index({ from: 1, receivedAt: -1 });
aiEmailSchema.index({ parentId: 1, receivedAt: -1 });

module.exports = mongoose.model('AiEmail', aiEmailSchema);
