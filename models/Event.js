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
    enum: ['training', 'game', 'holidays', 'celebration', 'camp', 'tryout'],
    default: 'training',
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
      message: 'Each class name must be 50 characters or less',
    },
  },
  sections: {
    type: [String],
    validate: {
      validator: function (v) {
        return v.every((section) => section.length <= 50);
      },
      message: 'Each section name must be 50 characters or less',
    },
  },
  roles: {
    type: [String],
    enum: [''],
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
  if (this.isModified('category')) {
    const colorMap = {
      training: '#1abe17',
      game: '#dc3545',
      holidays: '#0dcaf0',
      celebration: '#ffc107',
      camp: '#6c757d',
      tryout: '#0d6efd',
    };

    this.backgroundColor = colorMap[this.category] || '#adb5bd'; // light gray fallback
  }

  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Event', eventSchema);
