const mongoose = require('mongoose');

const FormSubmissionSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
  },
  formId: { type: mongoose.Schema.Types.ObjectId, ref: 'Form', required: true },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  data: { type: Object, required: true },
  payment: {
    id: String,
    amount: Number,
    currency: String,
    status: String,
    receiptUrl: String,
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('FormSubmission', FormSubmissionSchema);
