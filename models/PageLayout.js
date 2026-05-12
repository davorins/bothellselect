// backend/models/PageLayout.js
const mongoose = require('mongoose');

const pageSectionSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        'welcome',
        'spotlight',
        'form',
        'registration',
        'custom',
        'tournament',
        'sponsors',
        'video',
        'text',
        'image',
        'image-gallery',
        'stats',
        'testimonials',
        'team',
        'schedule',
        'pricing',
        'faq',
        'contact-form',
        'map',
        'social-feed',
      ],
    },
    position: {
      type: Number,
      required: true,
      min: 0,
    },
    title: String,
    subtitle: String,
    content: String,
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    styles: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false, timestamps: true },
);

const pageLayoutSchema = new mongoose.Schema(
  {
    pageType: {
      type: String,
      required: true,
      enum: [
        'home',
        'about',
        'programs',
        'tournaments',
        'contact',
        'spotlight',
        'registration',
        'custom',
      ],
    },
    pageSlug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    pageTitle: {
      type: String,
      required: true,
    },
    metaDescription: String,
    metaKeywords: [String],
    version: {
      type: String,
      default: '1.0.0',
    },
    sections: [pageSectionSchema],
    settings: {
      showHeader: { type: Boolean, default: true },
      showFooter: { type: Boolean, default: true },
      showSponsorBanner: { type: Boolean, default: true },
      sponsorBannerPosition: {
        type: String,
        enum: ['top', 'bottom', 'both'],
        default: 'bottom',
      },
      containerMaxWidth: { type: String, default: '1200px' },
      defaultSectionSpacing: { type: String, default: '3rem' },
      backgroundColor: { type: String, default: '#ffffff' },
      textColor: { type: String, default: '#333333' },
      accentColor: { type: String, default: '#506ee4' },
      canonicalUrl: String,
      openGraphImage: String,
      headerScripts: String,
      footerScripts: String,
    },
    parentTemplate: String,
    isTemplate: {
      type: Boolean,
      default: false,
    },
    templateName: String,
    publishedAt: Date,
    publishedBy: String,
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

pageLayoutSchema.index({ pageType: 1 });
pageLayoutSchema.index({ isTemplate: 1 });
pageLayoutSchema.index({ publishedAt: -1 });

module.exports = mongoose.model('PageLayout', pageLayoutSchema);
