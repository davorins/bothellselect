const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  caption: {
    type: String,
    default: '',
    trim: true,
    maxlength: 150,
  },
  price: {
    type: Number,
    min: 0,
    default: 0,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  start: {
    type: Date,
    required: true,
    set: function (date) {
      return new Date(date);
    },
  },
  end: {
    type: Date,
    set: function (date) {
      return date ? new Date(date) : undefined;
    },
  },
  category: {
    type: String,
    enum: ['training', 'game', 'holidays', 'celebration', 'camp', 'tryout'],
    default: 'training',
  },
  school: {
    name: String,
    address: String,
    website: String,
  },
  backgroundColor: String,
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
  if (typeof this.price !== 'number') {
    this.price = parseFloat(this.price) || 0;
  }

  if (this.isModified('category')) {
    const colorMap = {
      training: '#1abe17',
      game: '#dc3545',
      holidays: '#0f65cd',
      celebration: '#eab300',
      camp: '#6c757d',
      tryout: '#0d6efd',
    };

    this.backgroundColor = colorMap[this.category] || '#adb5bd';
  }

  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Event', eventSchema);
