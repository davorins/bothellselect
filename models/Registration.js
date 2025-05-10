const mongoose = require('mongoose');

// Check if model already exists
if (mongoose.models.Registration) {
  module.exports = mongoose.model('Registration');
} else {
  const registrationSchema = new mongoose.Schema(
    {
      player: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Player',
        required: [true, 'Player reference is required'],
        index: true,
      },
      parent: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Parent',
        required: [true, 'Parent reference is required'],
        index: true,
      },
      season: {
        type: String,
        required: [true, 'Season is required'],
        enum: ['Spring', 'Summer', 'Fall', 'Winter'],
      },
      year: {
        type: Number,
        required: [true, 'Year is required'],
        min: [2020, 'Year must be 2020 or later'],
        max: [2030, 'Year must be 2030 or earlier'],
      },
      paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded', 'partial'],
        default: 'pending',
      },
      paymentDetails: {
        amount: {
          type: Number,
          min: 0,
        },
        currency: {
          type: String,
          default: 'USD',
        },
        paymentMethod: {
          type: String,
          enum: ['credit_card', 'bank_transfer', 'cash', 'check', 'other'],
        },
        transactionId: String,
        paymentDate: Date,
        receiptUrl: String,
        last4Digits: String,
        cardBrand: String,
      },
      packageType: {
        type: String,
        enum: ['1', '2', '3'], // Corresponding to your 3/4/5 times per week packages
      },
      isActive: {
        type: Boolean,
        default: true,
      },
      notes: String,
    },
    {
      timestamps: true,
      toJSON: { virtuals: true },
      toObject: { virtuals: true },
    }
  );

  // Add indexes for faster queries
  registrationSchema.index({ player: 1, season: 1, year: 1 }, { unique: true });
  registrationSchema.index({ parent: 1, paymentStatus: 1 });
  registrationSchema.index({ paymentStatus: 1 });
  registrationSchema.index({ 'paymentDetails.paymentDate': 1 });
  registrationSchema.index({ season: 1, year: 1 });

  // Virtual for display name (season + year)
  registrationSchema.virtual('seasonYear').get(function () {
    return `${this.season} ${this.year}`;
  });

  // Virtual for payment status display
  registrationSchema.virtual('paymentStatusDisplay').get(function () {
    const statusMap = {
      pending: 'Pending Payment',
      completed: 'Paid',
      failed: 'Payment Failed',
      refunded: 'Refunded',
      partial: 'Partially Paid',
    };
    return statusMap[this.paymentStatus] || this.paymentStatus;
  });

  // Pre-save hook to update related player/parent documents
  registrationSchema.pre('save', async function (next) {
    if (
      this.isModified('paymentStatus') &&
      this.paymentStatus === 'completed'
    ) {
      try {
        // Update player's payment status
        await mongoose
          .model('Player')
          .updateOne({ _id: this.player }, { $set: { paymentStatus: 'paid' } });

        // Update parent's registration status if all registrations are paid
        const unpaidRegistrations = await this.model(
          'Registration'
        ).countDocuments({
          parent: this.parent,
          paymentStatus: { $ne: 'completed' },
        });

        if (unpaidRegistrations === 0) {
          await mongoose
            .model('Parent')
            .updateOne(
              { _id: this.parent },
              { $set: { paymentComplete: true } }
            );
        }
      } catch (error) {
        console.error('Error updating related documents:', error);
      }
    }
    next();
  });

  // Static method to update payment status
  registrationSchema.statics.updatePaymentStatus = async function (
    registrationId,
    status,
    paymentDetails = {}
  ) {
    return this.findByIdAndUpdate(
      registrationId,
      {
        $set: {
          paymentStatus: status,
          paymentDetails: {
            ...paymentDetails,
            paymentDate: status === 'completed' ? new Date() : undefined,
          },
        },
      },
      { new: true }
    );
  };

  // Query helper for active registrations
  registrationSchema.query.active = function () {
    return this.where({ isActive: true });
  };

  module.exports = mongoose.model('Registration', registrationSchema);
}
