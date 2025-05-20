const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema({
  category: { type: String, required: true },
  questions: { type: [String], required: true },
  answers: { type: [String], required: true },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('FAQ', faqSchema);
