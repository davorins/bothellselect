const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  grade: { type: String, required: true },
  sex: { type: String, enum: ['Male', 'Female', 'Coed'], required: true },
  levelOfCompetition: {
    type: String,
    enum: ['Gold', 'Silver'],
    required: true,
  },
  registrationYear: { type: Number, required: true },
  tournament: { type: String, required: true },
  coachIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Parent' }],
  paymentComplete: { type: Boolean, default: false },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
  },
  tournaments: [
    {
      tournament: String,
      year: Number,
      registrationDate: { type: Date, default: Date.now },
      paymentComplete: { type: Boolean, default: false },
      paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'failed'],
        default: 'pending',
      },
      amountPaid: { type: Number, default: 0 },
      paymentId: { type: String },
      paymentMethod: { type: String },
      cardLast4: { type: String },
      cardBrand: { type: String },
      levelOfCompetition: { type: String, enum: ['Gold', 'Silver'] },
    },
  ],
  isActive: { type: Boolean, default: true },
});

module.exports = mongoose.model('Team', teamSchema);
