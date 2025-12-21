const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const parentSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: function (v) {
          // Simple email regex that allows dots
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: 'Please enter a valid email',
      },
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,
    },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },

    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      minlength: [2, 'Full name must be at least 2 characters'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      validate: {
        validator: function (v) {
          return /^\d{10}$/.test(v.replace(/\D/g, ''));
        },
        message: 'Please enter a valid 10-digit phone number',
      },
      trim: true,
    },
    address: {
      street: {
        type: String,
        required: [true, 'Street address is required'],
        minlength: [5, 'Street address must be at least 5 characters'],
      },
      street2: { type: String, default: '' },
      city: {
        type: String,
        required: [true, 'City is required'],
      },
      state: {
        type: String,
        required: [true, 'State is required'],
        uppercase: true,
        minlength: 2,
        maxlength: 2,
        enum: [
          'AL',
          'AK',
          'AZ',
          'AR',
          'CA',
          'CO',
          'CT',
          'DE',
          'FL',
          'GA',
          'HI',
          'ID',
          'IL',
          'IN',
          'IA',
          'KS',
          'KY',
          'LA',
          'ME',
          'MD',
          'MA',
          'MI',
          'MN',
          'MS',
          'MO',
          'MT',
          'NE',
          'NV',
          'NH',
          'NJ',
          'NM',
          'NY',
          'NC',
          'ND',
          'OH',
          'OK',
          'OR',
          'PA',
          'RI',
          'SC',
          'SD',
          'TN',
          'TX',
          'UT',
          'VT',
          'VA',
          'WA',
          'WV',
          'WI',
          'WY',
        ],
      },
      zip: {
        type: String,
        required: [true, 'ZIP code is required'],
        validate: {
          validator: function (v) {
            return /^\d{5}(-\d{4})?$/.test(v);
          },
          message: 'Please enter a valid ZIP code',
        },
      },
    },
    relationship: {
      type: String,
      required: [true, 'Relationship to player is required'],
    },
    isCoach: { type: Boolean, default: false },
    aauNumber: { type: String },
    agreeToTerms: {
      type: Boolean,
      required: function () {
        return this.registerMethod === 'self';
      },
      default: function () {
        return this.registerMethod === 'adminCreate';
      },
      validate: {
        validator: function (v) {
          return this.registerMethod !== 'self' || v === true;
        },
        message: 'You must agree to the terms and conditions',
      },
    },
    registerMethod: {
      type: String,
      required: true,
      enum: ['self', 'adminCreate'],
      default: 'self',
    },
    role: {
      type: String,
      default: 'user',
      enum: ['user', 'admin', 'coach'],
    },
    registrationComplete: { type: Boolean, default: false },
    paymentComplete: { type: Boolean, default: false },
    avatar: {
      type: String,
      default: null,
    },
    players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
    additionalGuardians: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        fullName: { type: String, required: true, trim: true },
        relationship: { type: String, required: true, trim: true },
        phone: {
          type: String,
          required: true,
          validate: {
            validator: function (v) {
              return /^\d{10}$/.test(v.replace(/\D/g, ''));
            },
            message: 'Please enter a valid 10-digit phone number',
          },
        },
        email: {
          type: String,
          required: true,
          lowercase: true,
          trim: true,
          validate: {
            validator: function (v) {
              return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: 'Please enter a valid email',
          },
        },
        address: {
          street: { type: String, required: true, trim: true },
          street2: { type: String, default: '', trim: true },
          city: { type: String, required: true, trim: true },
          state: {
            type: String,
            required: true,
            uppercase: true,
            enum: [
              'AL',
              'AK',
              'AZ',
              'AR',
              'CA',
              'CO',
              'CT',
              'DE',
              'FL',
              'GA',
              'HI',
              'ID',
              'IL',
              'IN',
              'IA',
              'KS',
              'KY',
              'LA',
              'ME',
              'MD',
              'MA',
              'MI',
              'MN',
              'MS',
              'MO',
              'MT',
              'NE',
              'NV',
              'NH',
              'NJ',
              'NM',
              'NY',
              'NC',
              'ND',
              'OH',
              'OK',
              'OR',
              'PA',
              'RI',
              'SC',
              'SD',
              'TN',
              'TX',
              'UT',
              'VT',
              'VA',
              'WA',
              'WV',
              'WI',
              'WY',
            ],
          },
          zip: {
            type: String,
            required: true,
            validate: {
              validator: function (v) {
                return /^\d{5}(-\d{4})?$/.test(v);
              },
              message: 'Please enter a valid ZIP code',
            },
          },
        },
        isCoach: { type: Boolean, default: false },
        aauNumber: {
          type: String,
          required: function () {
            return this.isCoach;
          },
        },
        isAdmin: { type: Boolean, default: false },
        isPrimaryParent: { type: Boolean, default: true },
        managedParents: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Parent',
          },
        ],
        avatar: {
          type: String,
          default: null,
        },
      },
    ],
    isGuardian: Boolean,
    dismissedNotifications: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Notification',
        default: [],
      },
    ],
    playersSeason: {
      type: [String],
      default: [],
    },
    playersYear: {
      type: [Number],
      default: [],
    },
    communicationPreferences: {
      emailNotifications: {
        type: Boolean,
        default: true,
      },
      newsUpdates: {
        type: Boolean,
        default: true,
      },
      offersPromotions: {
        type: Boolean,
        default: true,
      },
      marketingEmails: {
        type: Boolean,
        default: true,
      },
      transactionalEmails: {
        type: Boolean,
        default: true,
      },
      broadcastEmails: {
        type: Boolean,
        default: true,
      },
      lastUpdated: {
        type: Date,
        default: Date.now,
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.emailVerificationToken;
        delete ret.emailVerificationExpires;
        return ret;
      },
    },
  }
);

parentSchema.index({ notifications: 1 });
parentSchema.index({ dismissedNotifications: 1 });
parentSchema.index({ emailVerificationToken: 1 });
parentSchema.index({ emailVerificationExpires: 1 });

// Hash password before saving
parentSchema.pre('save', async function (next) {
  try {
    // Normalize email
    if (this.email) {
      this.email = this.email.toLowerCase().trim();
    }

    // Hash password if it's new or changed
    if (this.isModified('password')) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }

    // Generate email verification token for new users
    if (this.isNew && this.registerMethod === 'self') {
      const crypto = require('crypto');
      this.emailVerificationToken = crypto.randomBytes(32).toString('hex');
      this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
      this.emailVerified = false;
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Update seasons and years when players change
parentSchema.pre('save', async function (next) {
  if (this.isModified('players')) {
    try {
      if (this.players && this.players.length > 0) {
        const players = await mongoose
          .model('Player')
          .find({ _id: { $in: this.players } }, { seasons: 1 });

        // Extract all unique seasons and years from players' seasons
        const allSeasons = players.flatMap((p) =>
          p.seasons.map((s) => s.season)
        );
        const allYears = players.flatMap((p) => p.seasons.map((s) => s.year));

        this.playersSeason = [...new Set(allSeasons)];
        this.playersYear = [...new Set(allYears)];
      } else {
        this.playersSeason = [];
        this.playersYear = [];
      }
    } catch (err) {
      console.error('Error updating player seasons/years:', err);
    }
  }
  next();
});

// Compare password method
parentSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to generate new verification token
parentSchema.methods.generateVerificationToken = function () {
  const crypto = require('crypto');
  this.emailVerificationToken = crypto.randomBytes(32).toString('hex');
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  return this.emailVerificationToken;
};

// Method to verify email
parentSchema.methods.verifyEmail = function () {
  this.emailVerified = true;
  this.emailVerificationToken = undefined;
  this.emailVerificationExpires = undefined;
  return this.save();
};

// Static method to find by verification token
parentSchema.statics.findByVerificationToken = function (token) {
  return this.findOne({
    emailVerificationToken: token,
    emailVerificationExpires: { $gt: Date.now() },
  }).select('+emailVerificationToken +emailVerificationExpires');
};

// Update seasons/years for all parents
parentSchema.statics.updateAllSeasonsAndYears = async function () {
  const parents = await this.find({});

  for (const parent of parents) {
    if (parent.players && parent.players.length > 0) {
      const players = await mongoose
        .model('Player')
        .find(
          { _id: { $in: parent.players } },
          { season: 1, registrationYear: 1 }
        );

      const seasons = [...new Set(players.map((p) => p.season))];
      const years = [...new Set(players.map((p) => p.registrationYear))];

      parent.playersSeason = seasons;
      parent.playersYear = years;
      await parent.save();
    }
  }
};

module.exports = mongoose.model('Parent', parentSchema);
