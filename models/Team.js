const mongoose = require('mongoose');

const tournamentRegistrationSchema = new mongoose.Schema(
  {
    tournament: { type: String, required: true },
    year: { type: Number, required: true },
    tournamentId: { type: String, default: null },
    registrationDate: { type: Date, default: Date.now },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentId: String,
    paymentMethod: String,
    amountPaid: Number,
    cardLast4: String,
    cardBrand: String,
    paymentDate: Date,
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver'],
      default: 'Gold',
    },
  },
  { _id: false }
);

const teamCoachSchema = new mongoose.Schema(
  {
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: true,
    },
    aauNumber: { type: String, required: true },
    isPrimary: { type: Boolean, default: true },
  },
  { _id: false, timestamps: true }
);

const teamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    grade: {
      type: String,
      required: true,
      enum: [
        'PK',
        'K',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
      ],
    },
    sex: {
      type: String,
      required: true,
      enum: ['Male', 'Female', 'Coed'],
    },
    levelOfCompetition: {
      type: String,
      enum: ['Gold', 'Silver'],
      default: 'Gold',
    },
    primaryCoachId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    coaches: [teamCoachSchema],
    players: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
      },
    ],
    registrationYear: { type: Number },
    tournament: { type: String },
    tournaments: [tournamentRegistrationSchema],
    registrationComplete: { type: Boolean, default: true },
    paymentComplete: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    lastPaymentDate: Date,
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for current tournament
teamSchema.virtual('currentTournament').get(function () {
  if (this.tournaments && this.tournaments.length > 0) {
    return this.tournaments[this.tournaments.length - 1].tournament;
  }
  return this.tournament;
});

// Virtual for current registration year
teamSchema.virtual('currentRegistrationYear').get(function () {
  if (this.tournaments && this.tournaments.length > 0) {
    return this.tournaments[this.tournaments.length - 1].year;
  }
  return this.registrationYear;
});

// Virtual for primary coach
teamSchema.virtual('primaryCoach').get(function () {
  if (this.coaches && this.coaches.length > 0) {
    return this.coaches.find((coach) => coach.isPrimary) || this.coaches[0];
  }
  return null;
});

// Virtual for display name (team name + grade + gender)
teamSchema.virtual('displayName').get(function () {
  return `${this.name} (Grade ${this.grade} ${this.sex})`;
});

// Index for unique tournament registration per team
teamSchema.index(
  {
    primaryCoachId: 1,
    'tournaments.tournament': 1,
    'tournaments.year': 1,
    'tournaments.tournamentId': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'tournaments.tournament': { $exists: true } },
  }
);

// Index for team search functionality
teamSchema.index({ name: 1, grade: 1, sex: 1 });
teamSchema.index({ primaryCoachId: 1, isActive: 1 });
teamSchema.index({ 'tournaments.paymentStatus': 1 });
teamSchema.index({ players: 1 });

// Static method to find teams by tournament and year
teamSchema.statics.findByTournament = function (tournament, year) {
  return this.find({
    'tournaments.tournament': tournament,
    'tournaments.year': year,
  }).populate('primaryCoachId players');
};

// Static method to find teams by coach/parent
teamSchema.statics.findByCoach = function (parentId) {
  return this.find({ primaryCoachId: parentId, isActive: true })
    .populate('primaryCoachId players')
    .sort({ createdAt: -1 });
};

// Static method to find teams with players
teamSchema.statics.findTeamsWithPlayers = function () {
  return this.find({ isActive: true })
    .populate('primaryCoachId players')
    .sort({ name: 1 });
};

// Instance method to register for a tournament
teamSchema.methods.registerForTournament = function (tournamentData) {
  const tournamentRegistration = {
    tournament: tournamentData.tournament,
    year: tournamentData.year,
    tournamentId: tournamentData.tournamentId,
    levelOfCompetition:
      tournamentData.levelOfCompetition || this.levelOfCompetition,
    registrationDate: new Date(),
    paymentStatus: 'pending',
  };

  this.tournaments.push(tournamentRegistration);
  return this.save();
};

// Instance method to update payment status
teamSchema.methods.updatePaymentStatus = function (
  tournament,
  year,
  paymentData
) {
  const tournamentReg = this.tournaments.find(
    (t) => t.tournament === tournament && t.year === year
  );

  if (tournamentReg) {
    tournamentReg.paymentComplete = paymentData.paymentComplete;
    tournamentReg.paymentStatus = paymentData.paymentStatus;
    tournamentReg.paymentId = paymentData.paymentId;
    tournamentReg.paymentMethod = paymentData.paymentMethod;
    tournamentReg.amountPaid = paymentData.amountPaid;
    tournamentReg.cardLast4 = paymentData.cardLast4;
    tournamentReg.cardBrand = paymentData.cardBrand;
    tournamentReg.paymentDate = new Date();

    this.lastPaymentDate = new Date();
    this.paymentComplete = paymentData.paymentComplete;
    this.paymentStatus = paymentData.paymentStatus;

    return this.save();
  }

  throw new Error('Tournament registration not found');
};

// Instance method to add player to team
teamSchema.methods.addPlayer = function (playerId) {
  if (!this.players.includes(playerId)) {
    this.players.push(playerId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Instance method to remove player from team
teamSchema.methods.removePlayer = function (playerId) {
  this.players = this.players.filter(
    (id) => id.toString() !== playerId.toString()
  );
  return this.save();
};

// Instance method to add assistant coach
teamSchema.methods.addCoach = function (parentData) {
  const existingCoach = this.coaches.find(
    (coach) => coach.parentId.toString() === parentData.parentId.toString()
  );

  if (!existingCoach) {
    this.coaches.push({
      parentId: parentData.parentId,
      firstName: parentData.firstName,
      lastName: parentData.lastName,
      email: parentData.email,
      phone: parentData.phone,
      aauNumber: parentData.aauNumber,
      isPrimary: false,
    });
    return this.save();
  }

  return Promise.resolve(this);
};

// Middleware to update team-level payment status based on tournaments
teamSchema.pre('save', function (next) {
  // If there are tournaments, set team status based on latest tournament
  if (this.tournaments && this.tournaments.length > 0) {
    const latestTournament = this.tournaments[this.tournaments.length - 1];
    this.paymentComplete = latestTournament.paymentComplete;
    this.paymentStatus = latestTournament.paymentStatus;
    if (latestTournament.paymentDate) {
      this.lastPaymentDate = latestTournament.paymentDate;
    }
  }
  next();
});

// Middleware to populate coach data when primaryCoachId is set
teamSchema.pre('save', async function (next) {
  if (this.isModified('primaryCoachId') && this.primaryCoachId) {
    try {
      const Parent = mongoose.model('Parent');
      const coach = await Parent.findById(this.primaryCoachId);

      if (coach) {
        // Ensure primary coach is in coaches array
        const primaryCoachExists = this.coaches.some(
          (c) => c.parentId.toString() === this.primaryCoachId.toString()
        );

        if (!primaryCoachExists) {
          this.coaches.push({
            parentId: this.primaryCoachId,
            firstName: coach.fullName.split(' ')[0],
            lastName: coach.fullName.split(' ').slice(1).join(' '),
            email: coach.email,
            phone: coach.phone,
            aauNumber: coach.aauNumber || '',
            isPrimary: true,
          });
        } else {
          // Update existing coach to be primary
          this.coaches.forEach((coach) => {
            coach.isPrimary =
              coach.parentId.toString() === this.primaryCoachId.toString();
          });
        }
      }
    } catch (error) {
      console.error('Error populating coach data:', error);
    }
  }
  next();
});

module.exports = mongoose.model('Team', teamSchema);
