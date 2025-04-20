const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const parentSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please enter a valid email',
      ],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
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
        fullName: { type: String, required: true },
        relationship: { type: String, required: true },
        phone: { type: String, required: true },
        email: { type: String, required: true },
        address: {
          street: { type: String, required: true },
          street2: { type: String, default: '' },
          city: { type: String, required: true },
          state: { type: String, required: true },
          zip: { type: String, required: true },
        },
        isCoach: { type: Boolean, default: false },
        aauNumber: { type: String, default: '' },
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
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        return ret;
      },
    },
  }
);

// Hash password before saving
parentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Compare password method
parentSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Avatar management methods
parentSchema.statics.updateAvatar = async function (parentId, file) {
  if (!file) throw new Error('No file provided');

  const parent = await this.findById(parentId);
  if (!parent) throw new Error('Parent not found');

  // Delete old avatar if exists
  if (parent.avatar) {
    const oldPath = path.join(__dirname, '..', parent.avatar);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }

  // Create uploads directory if it doesn't exist
  const uploadDir = path.join(__dirname, '../uploads/avatars');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Generate unique filename
  const filename = `${parentId}-${Date.now()}${path.extname(
    file.originalname
  )}`;
  const filePath = path.join(uploadDir, filename);
  const relativePath = `/uploads/avatars/${filename}`;

  // Save file
  await fs.promises.writeFile(filePath, file.buffer);

  // Update parent
  parent.avatar = relativePath;
  await parent.save();

  return relativePath;
};

parentSchema.statics.deleteAvatar = async function (parentId) {
  const parent = await this.findById(parentId);
  if (!parent) throw new Error('Parent not found');

  if (parent.avatar) {
    const filePath = path.join(__dirname, '..', parent.avatar);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    parent.avatar = null;
    await parent.save();
  }

  return true;
};

module.exports = mongoose.model('Parent', parentSchema);
