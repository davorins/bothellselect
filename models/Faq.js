const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema(
  {
    category: { type: String, required: true },
    questions: { type: [String], required: true },
    answers: { type: [String], required: true },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('FAQ', faqSchema);
