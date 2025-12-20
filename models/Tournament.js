const mongoose = require('mongoose');

const tournamentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
    },
    year: {
      type: Number,
      required: true,
      default: new Date().getFullYear(),
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    registrationDeadline: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['draft', 'open', 'ongoing', 'completed', 'cancelled'],
      default: 'draft',
    },
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver', 'All'],
      required: true,
    },
    gradeRange: {
      min: String,
      max: String,
    },
    sex: {
      type: String,
      enum: ['Male', 'Female', 'Mixed'],
      required: true,
    },
    maxTeams: {
      type: Number,
      default: 16,
    },
    minTeams: {
      type: Number,
      default: 4,
    },
    format: {
      type: String,
      enum: [
        'single-elimination',
        'double-elimination',
        'round-robin',
        'group-stage',
      ],
      default: 'single-elimination',
    },
    registeredTeams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team',
      },
    ],
    groups: [
      {
        name: String,
        teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
        matches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Match' }],
      },
    ],
    brackets: {
      type: Map,
      of: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Match',
        },
      ],
    },
    settings: {
      pointsPerWin: { type: Number, default: 3 },
      pointsPerDraw: { type: Number, default: 1 },
      pointsPerLoss: { type: Number, default: 0 },
      matchDuration: { type: Number, default: 40 },
      breakDuration: { type: Number, default: 10 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent', // CHANGED FROM 'User' TO 'Parent'
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent', // CHANGED FROM 'User' TO 'Parent'
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for formatted start date
tournamentSchema.virtual('formattedStartDate').get(function () {
  return this.startDate
    ? new Date(this.startDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';
});

// Virtual for formatted end date
tournamentSchema.virtual('formattedEndDate').get(function () {
  return this.endDate
    ? new Date(this.endDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';
});

// Virtual for team count
tournamentSchema.virtual('teamCount').get(function () {
  return this.registeredTeams ? this.registeredTeams.length : 0;
});

// Indexes for better query performance
tournamentSchema.index({ year: -1, status: 1 });
tournamentSchema.index({ levelOfCompetition: 1, sex: 1 });
tournamentSchema.index({ createdBy: 1 });
tournamentSchema.index({ status: 1, startDate: 1 });

module.exports = mongoose.model('Tournament', tournamentSchema);
