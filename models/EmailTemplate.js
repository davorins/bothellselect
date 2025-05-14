const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      maxlength: 100,
      index: true, // Remove this line if you're defining indexes separately
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    content: {
      type: String,
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
      index: true, // Remove this line if you're defining indexes separately
    },
    variables: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        description: {
          type: String,
          required: true,
          trim: true,
        },
        defaultValue: {
          type: String,
          trim: true,
        },
      },
    ],
    category: {
      type: String,
      enum: ['system', 'marketing', 'transactional', 'notification', 'other'],
      default: 'system',
      index: true, // Remove this line if you're defining indexes separately
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    version: {
      type: Number,
      default: 1,
    },
    previousVersions: [
      {
        content: String,
        updatedAt: Date,
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Parent',
        },
      },
    ],
    predefinedVariables: {
      type: [String],
      default: [
        'parent.fullName',
        'parent.email',
        'parent.phone',
        'player.fullName',
        'player.grade',
        'player.schoolName',
      ],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

emailTemplateSchema.index({ tags: 1 });
emailTemplateSchema.index({ createdAt: -1 });
emailTemplateSchema.index({ updatedAt: -1 });
emailTemplateSchema.index({ title: 1, status: 1 });
emailTemplateSchema.index({ category: 1, status: 1 });

// Versioning middleware
emailTemplateSchema.pre('save', function (next) {
  if (this.isModified('content') && !this.isNew) {
    if (!this.previousVersions) {
      this.previousVersions = [];
    }
    this.previousVersions.push({
      content: this.content,
      updatedAt: new Date(),
      updatedBy: this.lastUpdatedBy,
    });
    this.version += 1;
  }
  next();
});

const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

module.exports = EmailTemplate;
