// backend/models/FormFieldConfig.js
const mongoose = require('mongoose');

const fieldDependencySchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    operator: {
      type: String,
      enum: ['equals', 'notEquals', 'exists', 'notExists', 'true', 'false'],
      required: true,
    },
    value: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const formFieldConfigSchema = new mongoose.Schema({
  fieldName: {
    type: String,
    required: true,
    unique: true,
    enum: [
      'fullName',
      'parentFullName',
      'gender',
      'dob',
      'age',
      'schoolName',
      'grade',
      'healthConcerns',
      'aauNumber',
      'address',
      'city',
      'state',
      'zip',
      'phone',
      'email',
      'relationship',
      'isCoach',
    ],
  },
  label: { type: String, required: true },
  description: String,
  placeholder: String,
  fieldType: {
    type: String,
    enum: [
      'text',
      'number',
      'date',
      'select',
      'checkbox',
      'radio',
      'textarea',
      'email',
      'tel',
    ],
    default: 'text',
  },
  options: [
    {
      value: String,
      label: String,
      default: { type: Boolean, default: false },
    },
  ],
  isEnabled: { type: Boolean, default: true },
  isRequired: { type: Boolean, default: false },
  isReadOnly: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
  section: {
    type: String,
    enum: ['personal', 'contact', 'player', 'medical', 'emergency'],
    default: 'personal',
  },
  dependencies: [fieldDependencySchema],
  calculation: {
    type: {
      type: String,
      enum: ['fromDOB', 'formula', 'static'],
    },
    formula: String,
    dependsOn: [String],
  },
  validation: {
    minLength: Number,
    maxLength: Number,
    pattern: String,
    min: Number,
    max: Number,
    customMessage: String,
  },
  appliesTo: {
    type: [String],
    enum: ['parent', 'player', 'guardian', 'team'],
    default: ['player'],
  },
  allowOverride: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

formFieldConfigSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('FormFieldConfig', formFieldConfigSchema);
