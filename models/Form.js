const mongoose = require('mongoose');
const { Schema } = mongoose;

const formFieldSchema = new Schema({
  id: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: [
      'text',
      'email',
      'number',
      'select',
      'checkbox',
      'radio',
      'payment',
      'section',
    ],
  },
  label: { type: String, required: true },
  required: { type: Boolean, default: false },
  placeholder: String,
  options: [
    {
      label: String,
      value: String,
    },
  ],
  defaultValue: Schema.Types.Mixed,
  validation: {
    pattern: String,
    min: Number,
    max: Number,
  },
  conditional: {
    fieldId: String,
    value: Schema.Types.Mixed,
  },
  paymentConfig: {
    amount: Number,
    description: String,
    currency: { type: String, default: 'USD' },
  },
});

const formSchema = new Schema({
  title: { type: String, required: true },
  description: String,
  fields: [formFieldSchema],
  status: { type: Boolean, default: true },
  tags: [String],
  createdBy: { type: Schema.Types.ObjectId, ref: 'Parent', required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

formSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Form', formSchema);
