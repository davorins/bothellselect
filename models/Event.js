const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  start: {
    type: Date,
    required: true,
  },
  end: Date,
  allDay: {
    type: Boolean,
    default: false,
  },
  category: {
    type: String,
    enum: ['meeting', 'holiday', 'training', 'celebration', 'camp'],
    default: 'meeting',
  },
  backgroundColor: String,
  forStudents: Boolean,
  forStaff: Boolean,
  classes: {
    type: [String],
    validate: {
      validator: function (v) {
        return v.every((cls) => cls.length <= 50);
      },
      message: 'Each class must be 50 characters or less',
    },
  },
  sections: {
    type: [String],
    validate: {
      validator: function (v) {
        return v.every((section) => section.length <= 50);
      },
      message: 'Each section must be 50 characters or less',
    },
  },
  roles: {
    type: [String],
    enum: [
      'Admin',
      'Teacher',
      'Driver',
      'Accountant',
      'Librarian',
      'Receptionist',
    ],
  },
  attendees: [String],
  attachment: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

eventSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Event', eventSchema);
