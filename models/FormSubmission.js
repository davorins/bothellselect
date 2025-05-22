const mongoose = require('mongoose');

const FormSubmissionSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Form',
      required: true,
    },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    data: { type: Object, required: true },
    payment: {
      id: String,
      amount: Number,
      currency: { type: String, default: 'USD' },
      status: String,
      receiptUrl: String,
      processedAt: Date,
    },
    submittedAt: { type: Date, default: Date.now },
    ipAddress: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('FormSubmission', FormSubmissionSchema);
