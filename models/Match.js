const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema(
  {
    tournament: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    round: {
      type: Number,
      required: true,
    },
    matchNumber: {
      type: Number,
      required: true,
    },
    team1: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    team2: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    team1Score: {
      type: Number,
      default: 0,
      min: 0,
    },
    team2Score: {
      type: Number,
      default: 0,
      min: 0,
    },
    winner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    loser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    status: {
      type: String,
      enum: [
        'scheduled',
        'in-progress',
        'completed',
        'cancelled',
        'walkover',
        'bye',
      ],
      default: 'scheduled',
    },
    scheduledTime: {
      type: Date,
    },
    actualStartTime: {
      type: Date,
    },
    actualEndTime: {
      type: Date,
    },
    court: {
      type: String,
    },
    referee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent', // CHANGED FROM 'User' TO 'Parent'
    },
    notes: {
      type: String,
    },
    nextMatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
    },
    isConsolation: {
      type: Boolean,
      default: false,
    },
    walkoverReason: {
      type: String,
    },
    group: {
      type: String,
    },
    bracketType: {
      type: String,
      enum: ['winners', 'losers', 'final'],
      default: 'winners',
    },
    positions: {
      team1Position: {
        type: Number,
        default: 0,
      },
      team2Position: {
        type: Number,
        default: 0,
      },
    },
    bracketLocation: {
      type: String,
      enum: ['upper', 'lower', 'final', 'consolation'],
      default: 'upper',
    },
    // Schedule information
    court: {
      type: String,
      trim: true,
    },
    scheduledTime: {
      type: Date,
      index: true,
    },
    actualStartTime: {
      type: Date,
    },
    actualEndTime: {
      type: Date,
    },
    duration: {
      type: Number,
      default: 40, // minutes
    },

    // Time slot tracking
    timeSlot: {
      start: Date,
      end: Date,
    },

    // Referee assignment
    referee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    assistantReferee1: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    assistantReferee2: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },

    // Weather/venue info
    weatherConditions: {
      type: String,
      enum: ['clear', 'rain', 'snow', 'windy', 'extreme_heat', 'other'],
    },
    venue: {
      type: String,
    },

    // Equipment/requirements
    equipmentNotes: {
      type: String,
    },
    specialRequirements: {
      type: String,
    },

    // Status tracking
    isRescheduled: {
      type: Boolean,
      default: false,
    },
    rescheduledFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
    },
    cancellationReason: {
      type: String,
    },
    timeSlot: {
      type: String,
      trim: true,
    },
    sequence: {
      type: Number,
      default: 0,
    },
    group: {
      type: String,
      trim: true,
    },
    pool: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for formatted scheduled time
matchSchema.virtual('formattedScheduledTime').get(function () {
  if (!this.scheduledTime) return 'TBD';
  return new Date(this.scheduledTime).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
});

// Virtual for determining if match is ready to start
matchSchema.virtual('isReady').get(function () {
  return this.status === 'scheduled' && this.team1 && this.team2;
});

matchSchema.virtual('timeRemaining').get(function () {
  if (!this.scheduledTime || !this.duration) return null;
  const now = new Date();
  const endTime = new Date(this.scheduledTime);
  endTime.setMinutes(endTime.getMinutes() + this.duration);
  return endTime - now;
});

matchSchema.virtual('isOverdue').get(function () {
  if (!this.scheduledTime || !this.duration) return false;
  const now = new Date();
  const endTime = new Date(this.scheduledTime);
  endTime.setMinutes(endTime.getMinutes() + this.duration);
  return now > endTime && this.status !== 'completed';
});

matchSchema.virtual('formattedDuration').get(function () {
  return `${this.duration} minutes`;
});

// Indexes
matchSchema.index({ tournament: 1, round: 1, matchNumber: 1 });
matchSchema.index({ tournament: 1, status: 1, scheduledTime: 1 });
matchSchema.index({ team1: 1, team2: 1 });

module.exports = mongoose.model('Match', matchSchema);
