const mongoose = require('mongoose');

if (mongoose.models.EventConfig) {
  module.exports = mongoose.model('EventConfig');
} else {
  const eventConfigSchema = new mongoose.Schema(
    {
      // Event Type: tryout, training, tournament
      eventType: {
        type: String,
        enum: ['tryout', 'training', 'tournament'],
        required: true,
        index: true,
      },

      // Basic Info
      title: {
        type: String,
        required: true,
      },
      description: {
        type: String,
        default: '',
      },

      // Date & Time
      startDate: {
        type: Date,
        required: true,
      },
      endDate: {
        type: Date,
      },
      startTime: {
        type: String,
        default: '9:00 AM',
      },
      endTime: {
        type: String,
        default: '12:00 PM',
      },

      // Location
      location: {
        name: {
          type: String,
          required: true,
        },
        address: {
          type: String,
          default: '',
        },
        city: {
          type: String,
          default: '',
        },
        state: {
          type: String,
          default: '',
        },
        zip: {
          type: String,
          default: '',
        },
      },

      // Eligibility
      gender: {
        type: String,
        enum: ['Boys', 'Girls', 'Boys & Girls', 'Co-ed'],
        default: 'Boys & Girls',
      },
      grades: {
        type: String,
        default: '',
      },
      ageGroups: {
        type: [String],
        default: [],
      },

      // Pricing
      price: {
        type: Number,
        default: 0,
      },

      // Status
      registrationOpen: {
        type: Boolean,
        default: false,
      },
      isActive: {
        type: Boolean,
        default: true,
      },

      // Additional Info
      whatToBring: {
        type: [String],
        default: [],
      },
      whatToExpect: {
        type: String,
        default: '',
      },
      importantNotes: {
        type: [String],
        default: [],
      },

      // Featured Image
      imageUrl: {
        type: String,
        default: '',
      },

      // Related form config ID (when registration opens)
      formConfigId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RegistrationFormConfig',
      },

      // Metadata
      createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
      },
      updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
      },
    },
    {
      timestamps: true,
    },
  );

  // Ensure only one active config per event type
  eventConfigSchema.index({ eventType: 1, isActive: 1 }, { unique: true });

  module.exports = mongoose.model('EventConfig', eventConfigSchema);
}
