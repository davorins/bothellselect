const mongoose = require('mongoose');

const FormSubmissionSchema = new mongoose.Schema(
  {
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Form',
      required: true,
      index: true,
    },
    formVersion: { type: Number, required: true },

    // Submission Data
    data: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      required: true,
    },

    // Payment Information (if applicable)
    payment: {
      id: String,
      amount: Number,
      currency: { type: String, default: 'USD' },
      status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending',
      },
      gateway: String,
      transactionId: String,
      receiptUrl: String,
      processedAt: Date,
      metadata: mongoose.Schema.Types.Mixed,
    },

    // Tournament Information (for tournament forms)
    tournamentInfo: {
      tournamentName: String,
      tournamentTitle: String,
      tournamentDates: {
        startDate: Date,
        endDate: Date,
        startTime: String,
        endTime: String,
      },
      ticketInfo: {
        packageName: String,
        packageDescription: String,
        unitPrice: Number,
        quantity: { type: Number, default: 1 },
        totalAmount: Number,
        ticketCheckMethod: String,
        customCheckMethod: String,
      },
      venueInfo: {
        venueName: String,
        venueDate: Date,
        venueStartTime: String,
        venueEndTime: String,
        venueAddress: String,
        venueFullAddress: String,
        isPrimaryVenue: { type: Boolean, default: false },
      },
      refundPolicy: {
        isRefundable: { type: Boolean, default: false },
        policyDescription: String,
      },
      selectedVenueIndex: Number,
    },

    // File Uploads
    files: [
      {
        fieldId: String,
        originalName: String,
        fileName: String,
        path: String,
        size: Number,
        mimeType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // User Information
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    userEmail: String,
    userName: String,

    // Technical Info
    ipAddress: String,
    userAgent: String,
    referrer: String,
    pageUrl: String,

    // Status
    status: {
      type: String,
      enum: ['pending', 'submitted', 'processing', 'completed', 'failed'],
      default: 'submitted',
    },

    // Email Status
    emailSent: { type: Boolean, default: false },
    emailSentAt: Date,
    emailError: String,

    // Metadata
    metadata: mongoose.Schema.Types.Mixed,

    // Timestamps
    submittedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
FormSubmissionSchema.index({ formId: 1, submittedAt: -1 });
FormSubmissionSchema.index({ submittedBy: 1, submittedAt: -1 });
FormSubmissionSchema.index({ status: 1 });
FormSubmissionSchema.index({ 'payment.status': 1 });
FormSubmissionSchema.index({ 'payment.transactionId': 1 }, { sparse: true });
// Tournament-specific indexes
FormSubmissionSchema.index({ 'tournamentInfo.tournamentDates.startDate': 1 });
FormSubmissionSchema.index({ 'tournamentInfo.venueInfo.venueDate': 1 });
FormSubmissionSchema.index({ 'tournamentInfo.ticketInfo.packageName': 1 });

// Virtual to get total amount
FormSubmissionSchema.virtual('totalAmount').get(function () {
  return (
    this.payment?.amount || this.tournamentInfo?.ticketInfo?.totalAmount || 0
  );
});

// Method to mark as completed
FormSubmissionSchema.methods.markAsCompleted = function () {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

// Method to process payment
FormSubmissionSchema.methods.processPayment = async function (paymentData) {
  this.payment = {
    ...this.payment,
    ...paymentData,
    processedAt: new Date(),
    status: 'completed',
  };
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

// Method to set tournament info
FormSubmissionSchema.methods.setTournamentInfo = function (
  formData,
  selectedPackage = null,
  quantity = 1,
  selectedVenueIndex = null
) {
  if (!formData.isTournamentForm || !formData.tournamentSettings) {
    return this;
  }

  const tournament = formData.tournamentSettings;
  let venueInfo = {};

  // Get selected venue
  if (selectedVenueIndex !== null && tournament.venues[selectedVenueIndex]) {
    const venue = tournament.venues[selectedVenueIndex];
    venueInfo = {
      venueName: venue.venueName,
      venueDate: venue.date,
      venueStartTime: venue.startTime,
      venueEndTime: venue.endTime,
      venueAddress: venue.address,
      venueFullAddress: venue.fullAddress,
      isPrimaryVenue: venue.isPrimary,
    };
  } else if (tournament.venues.length > 0) {
    // Use primary venue or first venue
    const primaryVenue =
      tournament.venues.find((v) => v.isPrimary) || tournament.venues[0];
    venueInfo = {
      venueName: primaryVenue.venueName,
      venueDate: primaryVenue.date,
      venueStartTime: primaryVenue.startTime,
      venueEndTime: primaryVenue.endTime,
      venueAddress: primaryVenue.address,
      venueFullAddress: primaryVenue.fullAddress,
      isPrimaryVenue: primaryVenue.isPrimary,
    };
  }

  // Calculate total amount if package is selected
  let totalAmount = 0;
  if (selectedPackage) {
    totalAmount = selectedPackage.price * quantity;
  }

  this.tournamentInfo = {
    tournamentName: formData.name,
    tournamentTitle: formData.title,
    tournamentDates: {
      startDate: tournament.startDate,
      endDate: tournament.endDate,
      startTime: tournament.startTime,
      endTime: tournament.endTime,
    },
    ticketInfo: {
      packageName: selectedPackage?.name || 'General Admission',
      packageDescription: selectedPackage?.description || '',
      unitPrice: selectedPackage?.price || 0,
      quantity: quantity,
      totalAmount: totalAmount,
      ticketCheckMethod: tournament.ticketCheckMethod,
      customCheckMethod: tournament.customCheckMethod,
    },
    venueInfo: venueInfo,
    refundPolicy: {
      isRefundable: tournament.isRefundable,
      policyDescription: tournament.refundPolicy,
    },
    selectedVenueIndex: selectedVenueIndex,
  };

  return this;
};

// Static method to find submissions by tournament date
FormSubmissionSchema.statics.findByTournamentDate = function (
  startDate,
  endDate
) {
  return this.find({
    'tournamentInfo.tournamentDates.startDate': { $gte: startDate },
    'tournamentInfo.tournamentDates.endDate': { $lte: endDate },
  });
};

// Static method to find submissions by venue
FormSubmissionSchema.statics.findByVenue = function (venueName) {
  return this.find({
    'tournamentInfo.venueInfo.venueName': venueName,
  });
};

// Static method to get tournament statistics
FormSubmissionSchema.statics.getTournamentStats = function (formId) {
  return this.aggregate([
    {
      $match: {
        formId: mongoose.Types.ObjectId(formId),
        'tournamentInfo.tournamentName': { $exists: true },
      },
    },
    {
      $group: {
        _id: '$tournamentInfo.ticketInfo.packageName',
        totalTickets: { $sum: '$tournamentInfo.ticketInfo.quantity' },
        totalRevenue: { $sum: '$tournamentInfo.ticketInfo.totalAmount' },
        count: { $sum: 1 },
      },
    },
    {
      $sort: { totalRevenue: -1 },
    },
  ]);
};

module.exports = mongoose.model('FormSubmission', FormSubmissionSchema);
