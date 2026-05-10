const mongoose = require('mongoose');

const seasonRegistrationSchema = new mongoose.Schema(
  {
    season: {
      type: String,
      required: true,
      trim: true,
    },
    year: {
      type: Number,
      required: true,
      min: 2020,
      max: 2030,
    },
    tryoutId: {
      type: String,
      default: null,
      trim: true,
    },
    registrationDate: {
      type: Date,
      default: Date.now,
    },
    paymentComplete: {
      type: Boolean,
      default: false,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentId: {
      type: String,
      trim: true,
    },
    paymentMethod: {
      type: String,
      trim: true,
    },
    amountPaid: {
      type: Number,
      min: 0,
      default: 0,
    },
    cardLast4: {
      type: String,
      match: /^\d{4}$/,
    },
    cardBrand: {
      type: String,
      trim: true,
    },
    paymentDate: Date,
  },
  {
    _id: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for formatted season display
seasonRegistrationSchema.virtual('seasonDisplay').get(function () {
  return `${this.season} ${this.year}`;
});

// Virtual for payment status display
seasonRegistrationSchema.virtual('paymentStatusDisplay').get(function () {
  const statusMap = {
    pending: 'Payment Pending',
    paid: 'Paid',
    failed: 'Payment Failed',
    refunded: 'Refunded',
  };
  return statusMap[this.paymentStatus] || this.paymentStatus;
});

const playerSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    gender: {
      type: String,
      required: true,
      enum: ['Male', 'Female'],
    },
    dob: {
      type: Date,
      required: false,
    },
    schoolName: {
      type: String,
      required: false,
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
    healthConcerns: {
      type: String,
      default: '',
      trim: true,
    },
    aauNumber: {
      type: String,
      default: '',
      trim: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
      index: true,
    },
    registrationYear: {
      type: Number,
      min: 2020,
      max: 2030,
    },
    season: {
      type: String,
      trim: true,
    },
    seasons: [seasonRegistrationSchema],
    registrationComplete: {
      type: Boolean,
      default: true,
    },
    paymentComplete: {
      type: Boolean,
      default: false,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    lastPaymentDate: Date,
    avatar: {
      type: String,
      default: null,
    },
    isGradeOverridden: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ==================== VIRTUAL PROPERTIES ====================

playerSchema.virtual('age').get(function () {
  if (!this.dob) return null;
  const today = new Date();
  const birthDate = new Date(this.dob);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age--;
  }
  return age;
});

playerSchema.virtual('currentSeason').get(function () {
  if (this.seasons && this.seasons.length > 0) {
    // Get the most recent season based on year and registration date
    const sortedSeasons = [...this.seasons].sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return new Date(b.registrationDate) - new Date(a.registrationDate);
    });
    return sortedSeasons[0];
  }
  return {
    season: this.season,
    year: this.registrationYear,
    tryoutId: null,
  };
});

playerSchema.virtual('currentRegistrationYear').get(function () {
  const currentSeason = this.currentSeason;
  return currentSeason.year || this.registrationYear;
});

playerSchema.virtual('hasPaidSeason').get(function () {
  return this.seasons?.some((s) => s.paymentStatus === 'paid') || false;
});

playerSchema.virtual('pendingSeasons').get(function () {
  return this.seasons?.filter((s) => s.paymentStatus === 'pending') || [];
});

playerSchema.virtual('activeSeasons').get(function () {
  return this.seasons?.filter((s) => s.paymentStatus === 'paid') || [];
});

playerSchema.virtual('avatarUrl').get(function () {
  if (this.avatar) {
    return `${this.avatar}${this.avatar.includes('?') ? '&' : '?'}ts=${Date.now()}`;
  }
  return this.gender === 'Female'
    ? 'https://bothell-select.onrender.com/uploads/avatars/girl.png'
    : 'https://bothell-select.onrender.com/uploads/avatars/boy.png';
});

// ==================== INDEXES ====================

// Compound index for efficient season lookups
playerSchema.index(
  {
    parentId: 1,
    'seasons.season': 1,
    'seasons.year': 1,
    'seasons.tryoutId': 1,
  },
  {
    name: 'season_lookup_idx',
    background: true,
  },
);

// Index for active players (frequently used in queries)
playerSchema.index(
  { 'seasons.paymentStatus': 1 },
  {
    name: 'payment_status_idx',
    partialFilterExpression: { 'seasons.paymentStatus': 'paid' },
    background: true,
  },
);

// Index for grade-based queries
playerSchema.index(
  { grade: 1, gender: 1 },
  {
    name: 'grade_gender_idx',
    background: true,
  },
);

// ==================== MIDDLEWARE ====================

/**
 * Remove duplicate seasons before saving
 */
playerSchema.pre('save', function (next) {
  if (this.isModified('seasons')) {
    const originalCount = this.seasons.length;
    const seen = new Map();
    const removedDuplicates = [];

    this.seasons = this.seasons.filter((season, index) => {
      // Normalize values for comparison
      const normalizedSeason = (season.season || '').trim().toLowerCase();
      const normalizedTryoutId = (season.tryoutId || '')
        .toString()
        .trim()
        .toLowerCase();
      const key = `${normalizedSeason}|${season.year}|${normalizedTryoutId}`;

      if (!seen.has(key)) {
        seen.set(key, {
          index,
          season: {
            ...season,
            season: normalizedSeason,
            tryoutId: normalizedTryoutId,
          },
        });
        return true;
      }

      // Keep the earliest registration if duplicates exist
      const existing = seen.get(key);
      const currentDate = new Date(season.registrationDate || 0);
      const existingDate = new Date(existing.season.registrationDate || 0);

      if (currentDate < existingDate) {
        // Current is earlier, keep current, remove existing
        removedDuplicates.push({
          ...existing.season,
          reason: 'replaced_by_earlier',
        });
        seen.set(key, {
          index,
          season: {
            ...season,
            season: normalizedSeason,
            tryoutId: normalizedTryoutId,
          },
        });
        return true;
      } else {
        // Existing is earlier or same, keep existing, remove current
        removedDuplicates.push({ ...season, reason: 'duplicate_later_date' });
        return false;
      }
    });

    // Sort seasons by year (descending), then registration date (descending)
    this.seasons.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      const dateA = new Date(a.registrationDate || 0);
      const dateB = new Date(b.registrationDate || 0);
      return dateB - dateA;
    });

    // Update top-level fields with the most recent paid season
    if (this.seasons.length > 0) {
      const latestPaidSeason =
        this.seasons.find((s) => s.paymentStatus === 'paid') || this.seasons[0];
      this.registrationYear = latestPaidSeason.year;
      this.season = latestPaidSeason.season;
      this.paymentComplete = latestPaidSeason.paymentComplete;
      this.paymentStatus = latestPaidSeason.paymentStatus;
    }

    // Log duplicates if any were removed
    if (removedDuplicates.length > 0) {
      console.warn(
        `⚠️ Removed ${removedDuplicates.length} duplicate season(s) from player ${this._id}:`,
        {
          playerId: this._id,
          playerName: this.fullName,
          originalCount,
          finalCount: this.seasons.length,
          removed: removedDuplicates,
        },
      );
    }
  }
  next();
});

/**
 * Validate seasons array for duplicates
 */
playerSchema.path('seasons').validate(function (seasons) {
  if (!Array.isArray(seasons)) return true;

  const seen = new Set();
  for (const season of seasons) {
    const key = `${(season.season || '').trim().toLowerCase()}|${season.year}|${(season.tryoutId || '').toString().trim().toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}, 'Duplicate season entries detected. Player cannot have multiple registrations for the same season, year, and tryout.');

/**
 * Prevent duplicate seasons in findOneAndUpdate operations
 */
playerSchema.pre('findOneAndUpdate', async function (next) {
  try {
    const update = this.getUpdate();

    if (update.$push && update.$push.seasons) {
      const newSeasons = update.$push.seasons.$each || [update.$push.seasons];
      const filter = this.getQuery();

      // Get the current player to check existing seasons
      const player = await this.model.findOne(filter).lean();
      if (!player) {
        return next(new Error('Player not found'));
      }

      // Check each new season for duplicates
      for (const newSeason of newSeasons) {
        const normalizedSeason = (newSeason.season || '').trim().toLowerCase();
        const normalizedTryoutId = (newSeason.tryoutId || '')
          .toString()
          .trim()
          .toLowerCase();

        const isDuplicate = (player.seasons || []).some((existingSeason) => {
          const existingNormalizedSeason = (existingSeason.season || '')
            .trim()
            .toLowerCase();
          const existingNormalizedTryoutId = (existingSeason.tryoutId || '')
            .toString()
            .trim()
            .toLowerCase();

          return (
            existingNormalizedSeason === normalizedSeason &&
            existingSeason.year === newSeason.year &&
            existingNormalizedTryoutId === normalizedTryoutId
          );
        });

        if (isDuplicate) {
          return next(
            new Error(
              `Player already has registration for ${newSeason.season} ${newSeason.year}`,
            ),
          );
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Update timestamps and sync top-level fields after save
 */
playerSchema.pre('save', function (next) {
  this.updatedAt = new Date();

  // Sync top-level payment status from seasons
  if (this.seasons && this.seasons.length > 0) {
    const hasPaidSeason = this.seasons.some((s) => s.paymentStatus === 'paid');
    this.paymentComplete = hasPaidSeason;
    this.paymentStatus = hasPaidSeason
      ? 'paid'
      : this.paymentStatus || 'pending';

    // Update last payment date if there are paid seasons
    const paidSeasons = this.seasons.filter(
      (s) => s.paymentStatus === 'paid' && s.paymentDate,
    );
    if (paidSeasons.length > 0) {
      const latestPayment = paidSeasons.sort(
        (a, b) => new Date(b.paymentDate) - new Date(a.paymentDate),
      )[0];
      this.lastPaymentDate = latestPayment.paymentDate;
    }
  }

  next();
});

// Pre-save middleware to normalize season names
playerSchema.pre('save', function (next) {
  if (this.seasons && this.isModified('seasons')) {
    this.seasons = this.seasons.map((season) => {
      let normalizedSeason = season.season;

      // DON'T normalize tryout seasons with "Tryout - " prefix
      // Just use the season name as provided

      // Normalize training/camp seasons if needed
      if (
        season.season.toLowerCase().includes('camp') ||
        season.season.toLowerCase().includes('training') ||
        season.season.toLowerCase().includes('clinic') ||
        (season.tryoutId && season.tryoutId.includes('-camp-'))
      ) {
        // Keep as is - don't change to "Basketball Training"
        normalizedSeason = season.season;
      }

      return {
        ...season,
        season: normalizedSeason,
      };
    });
  }

  // Don't modify top-level season either
  next();
});

// ==================== STATIC METHODS ====================

/**
 * Add a season to a player with duplicate checking
 */
playerSchema.statics.addSeason = async function (
  playerId,
  seasonData,
  options = {},
) {
  const session = options.session;
  const player = await this.findById(playerId).session(session);

  if (!player) {
    throw new Error('Player not found');
  }

  // Check for duplicate
  const normalizedSeason = (seasonData.season || '').trim().toLowerCase();
  const normalizedTryoutId = (seasonData.tryoutId || '')
    .toString()
    .trim()
    .toLowerCase();

  const isDuplicate = player.seasons.some((s) => {
    const existingSeason = (s.season || '').trim().toLowerCase();
    const existingTryoutId = (s.tryoutId || '').toString().trim().toLowerCase();

    return (
      existingSeason === normalizedSeason &&
      s.year === seasonData.year &&
      existingTryoutId === normalizedTryoutId
    );
  });

  if (isDuplicate) {
    throw new Error(
      `Player already registered for ${seasonData.season} ${seasonData.year}`,
    );
  }

  // Add the season
  const newSeason = {
    season: seasonData.season.trim(),
    year: seasonData.year,
    tryoutId: seasonData.tryoutId || null,
    registrationDate: new Date(),
    paymentStatus: seasonData.paymentStatus || 'pending',
    paymentComplete: seasonData.paymentStatus === 'paid',
    ...(seasonData.paymentId && { paymentId: seasonData.paymentId }),
    ...(seasonData.amountPaid && { amountPaid: seasonData.amountPaid }),
    ...(seasonData.cardLast4 && { cardLast4: seasonData.cardLast4 }),
    ...(seasonData.cardBrand && { cardBrand: seasonData.cardBrand }),
    ...(seasonData.paymentDate && { paymentDate: seasonData.paymentDate }),
  };

  player.seasons.push(newSeason);

  // Update top-level fields if specified
  if (options.updateTopLevel !== false) {
    player.registrationYear = seasonData.year;
    player.season = seasonData.season.trim();
    if (seasonData.paymentStatus === 'paid') {
      player.paymentComplete = true;
      player.paymentStatus = 'paid';
      player.lastPaymentDate = new Date();
    }
  }

  await player.save({ session });
  return player;
};

/**
 * Get players by season and year
 */
playerSchema.statics.findBySeason = function (season, year, options = {}) {
  const query = {
    'seasons.season': { $regex: new RegExp(season, 'i') },
    'seasons.year': parseInt(year),
  };

  if (options.tryoutId) {
    query['seasons.tryoutId'] = options.tryoutId;
  }

  if (options.paymentStatus) {
    query['seasons.paymentStatus'] = options.paymentStatus;
  }

  return this.find(query)
    .populate('parentId', 'fullName email phone')
    .sort({ 'seasons.registrationDate': -1 });
};

/**
 * Get active (paid) players for a season
 */
playerSchema.statics.findActiveBySeason = function (season, year) {
  return this.find({
    'seasons.season': { $regex: new RegExp(season, 'i') },
    'seasons.year': parseInt(year),
    'seasons.paymentStatus': 'paid',
  })
    .populate('parentId', 'fullName email phone')
    .sort({ fullName: 1 });
};

/**
 * Check if player is registered for a specific season/tryout
 */
playerSchema.statics.isRegistered = async function (
  playerId,
  season,
  year,
  tryoutId = null,
) {
  const query = {
    _id: playerId,
    'seasons.season': { $regex: new RegExp(season, 'i') },
    'seasons.year': parseInt(year),
  };

  if (tryoutId) {
    query['seasons.tryoutId'] = tryoutId;
  }

  const player = await this.findOne(query);
  return !!player;
};

// ==================== INSTANCE METHODS ====================

/**
 * Get season by season/year/tryoutId
 */
playerSchema.methods.getSeason = function (season, year, tryoutId = null) {
  return this.seasons.find((s) => {
    const seasonMatch =
      (s.season || '').toLowerCase() === (season || '').toLowerCase();
    const yearMatch = s.year === parseInt(year);
    const tryoutMatch = tryoutId
      ? (s.tryoutId || '').toString() === tryoutId.toString()
      : true;

    return seasonMatch && yearMatch && tryoutMatch;
  });
};

/**
 * Update season payment status
 */
playerSchema.methods.updateSeasonPayment = async function (
  season,
  year,
  tryoutId,
  paymentData,
) {
  const seasonIndex = this.seasons.findIndex((s) => {
    const seasonMatch =
      (s.season || '').toLowerCase() === (season || '').toLowerCase();
    const yearMatch = s.year === parseInt(year);
    const tryoutMatch =
      (s.tryoutId || '').toString() === (tryoutId || '').toString();

    return seasonMatch && yearMatch && tryoutMatch;
  });

  if (seasonIndex === -1) {
    throw new Error(`Season ${season} ${year} not found for player`);
  }

  // Update season payment info
  this.seasons[seasonIndex].paymentStatus = paymentData.paymentStatus;
  this.seasons[seasonIndex].paymentComplete =
    paymentData.paymentStatus === 'paid';
  this.seasons[seasonIndex].paymentId = paymentData.paymentId;
  this.seasons[seasonIndex].amountPaid = paymentData.amountPaid;
  this.seasons[seasonIndex].cardLast4 = paymentData.cardLast4;
  this.seasons[seasonIndex].cardBrand = paymentData.cardBrand;

  if (paymentData.paymentStatus === 'paid') {
    this.seasons[seasonIndex].paymentDate = new Date();
    this.lastPaymentDate = new Date();
  }

  // Update top-level fields if this is the latest season
  const isLatestSeason =
    seasonIndex === 0 ||
    this.seasons[seasonIndex].year > this.seasons[0].year ||
    (this.seasons[seasonIndex].year === this.seasons[0].year &&
      new Date(this.seasons[seasonIndex].registrationDate) >
        new Date(this.seasons[0].registrationDate));

  if (isLatestSeason) {
    this.paymentStatus = paymentData.paymentStatus;
    this.paymentComplete = paymentData.paymentStatus === 'paid';
  }

  await this.save();
  return this;
};

/**
 * Remove a season registration
 */
playerSchema.methods.removeSeason = async function (
  season,
  year,
  tryoutId = null,
) {
  const initialLength = this.seasons.length;

  this.seasons = this.seasons.filter((s) => {
    const seasonMatch =
      (s.season || '').toLowerCase() === (season || '').toLowerCase();
    const yearMatch = s.year === parseInt(year);
    const tryoutMatch = tryoutId
      ? (s.tryoutId || '').toString() === tryoutId.toString()
      : true;

    return !(seasonMatch && yearMatch && tryoutMatch);
  });

  if (this.seasons.length === initialLength) {
    throw new Error(`Season ${season} ${year} not found for player`);
  }

  // Update top-level fields if we removed the current season
  if (this.seasons.length > 0) {
    const latestSeason = this.seasons[0];
    this.registrationYear = latestSeason.year;
    this.season = latestSeason.season;
    this.paymentStatus = latestSeason.paymentStatus;
    this.paymentComplete = latestSeason.paymentComplete;
  } else {
    this.registrationYear = null;
    this.season = null;
    this.paymentStatus = 'pending';
    this.paymentComplete = false;
  }

  await this.save();
  return this;
};

// ==================== QUERY HELPERS ====================

/**
 * Query helper for active (paid) players
 */
playerSchema.query.active = function () {
  return this.where({ 'seasons.paymentStatus': 'paid' });
};

/**
 * Query helper for pending payment players
 */
playerSchema.query.pending = function () {
  return this.where({ 'seasons.paymentStatus': 'pending' });
};

/**
 * Query helper for specific season
 */
playerSchema.query.bySeason = function (season, year) {
  return this.where({
    'seasons.season': { $regex: new RegExp(season, 'i') },
    'seasons.year': parseInt(year),
  });
};

module.exports = mongoose.model('Player', playerSchema);
