const express = require('express');
const router = express.Router();
const MarketingAttribution = require('../models/MarketingAttribution');
const { authenticate, isAdmin } = require('../utils/auth');

// Get marketing attribution stats for dashboard
router.get('/attribution/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const { campaign, source, eventType, startDate, endDate } = req.query;

    // Build filter
    const filter = {};
    if (campaign) filter.campaign = campaign;
    if (source) filter.source = source;
    if (eventType) filter.eventType = eventType;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    // Get all attributions with registration data
    const attributions = await MarketingAttribution.find(filter)
      .populate('registrationId', 'paymentStatus paymentDetails player')
      .populate('parentId', 'fullName email')
      .lean();

    // Aggregate stats
    const stats = {
      totalRegistrations: attributions.length,
      paidRegistrations: attributions.filter(
        (a) => a.registrationId?.paymentStatus === 'paid',
      ).length,
      totalRevenue: attributions.reduce((sum, a) => {
        return sum + (a.registrationId?.paymentDetails?.amountPaid || 0);
      }, 0),
      pendingPayments: attributions.filter(
        (a) => a.registrationId?.paymentStatus === 'pending',
      ).length,
      bySource: {},
      byCampaign: {},
      byEventType: {},
    };

    // Group by source
    attributions.forEach((a) => {
      const source = a.source || 'direct';
      if (!stats.bySource[source]) {
        stats.bySource[source] = { count: 0, revenue: 0, paid: 0 };
      }
      stats.bySource[source].count++;
      stats.bySource[source].revenue +=
        a.registrationId?.paymentDetails?.amountPaid || 0;
      if (a.registrationId?.paymentStatus === 'paid') {
        stats.bySource[source].paid++;
      }
    });

    // Group by campaign
    attributions.forEach((a) => {
      const campaign = a.campaign || 'none';
      if (!stats.byCampaign[campaign]) {
        stats.byCampaign[campaign] = { count: 0, revenue: 0, paid: 0 };
      }
      stats.byCampaign[campaign].count++;
      stats.byCampaign[campaign].revenue +=
        a.registrationId?.paymentDetails?.amountPaid || 0;
      if (a.registrationId?.paymentStatus === 'paid') {
        stats.byCampaign[campaign].paid++;
      }
    });

    // Group by event type
    attributions.forEach((a) => {
      const type = a.eventType || 'player';
      if (!stats.byEventType[type]) {
        stats.byEventType[type] = { count: 0, revenue: 0, paid: 0 };
      }
      stats.byEventType[type].count++;
      stats.byEventType[type].revenue +=
        a.registrationId?.paymentDetails?.amountPaid || 0;
      if (a.registrationId?.paymentStatus === 'paid') {
        stats.byEventType[type].paid++;
      }
    });

    res.json({
      success: true,
      stats,
      attributions: attributions.slice(0, 100),
    });
  } catch (error) {
    console.error('Error fetching marketing stats:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
