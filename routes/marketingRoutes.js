const express = require('express');
const router = express.Router();
const MarketingAttribution = require('../models/MarketingAttribution');
const Registration = require('../models/Registration');
const { authenticate, isAdmin } = require('../utils/auth');

// ---------------------------------------------------------------
// Helpers — normalise the many shapes payment data can take
// ---------------------------------------------------------------

// Treat anything that means "money was collected" as paid.
const PAID_STATUSES = new Set(['paid', 'completed', 'succeeded', 'complete']);

function isPaid(reg) {
  if (!reg) return false;
  if (reg.paymentComplete === true) return true;
  return PAID_STATUSES.has(String(reg.paymentStatus || '').toLowerCase());
}

function isPending(reg) {
  if (!reg) return false;
  return String(reg.paymentStatus || '').toLowerCase() === 'pending';
}

function getAmount(reg) {
  if (!reg) return 0;
  const amount =
    reg.paymentDetails?.amountPaid ??
    reg.payment?.amount ??
    reg.amountPaid ??
    0;
  return Number(amount) || 0;
}

// ---------------------------------------------------------------
// GET /marketing/attribution/stats
// ---------------------------------------------------------------
router.get('/attribution/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const { campaign, source, eventType, startDate, endDate } = req.query;

    const filter = {};
    if (campaign) filter.campaign = campaign;
    if (source) filter.source = source;
    if (eventType) filter.eventType = eventType;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const attributions = await MarketingAttribution.find(filter)
      .populate(
        'registrationId',
        'paymentStatus paymentComplete paymentDetails amountPaid parent player',
      )
      .populate('parentId', 'fullName email')
      .lean();

    const stats = {
      totalRegistrations: attributions.length,
      paidRegistrations: 0,
      totalRevenue: 0,
      pendingPayments: 0,
      bySource: {},
      byCampaign: {},
      byEventType: {},
    };

    const ensure = (bucket, key) => {
      if (!bucket[key]) bucket[key] = { count: 0, revenue: 0, paid: 0 };
      return bucket[key];
    };

    for (const a of attributions) {
      const reg = a.registrationId;
      const paid = isPaid(reg);
      const pending = isPending(reg);
      const amount = getAmount(reg);

      if (paid) stats.paidRegistrations += 1;
      if (pending) stats.pendingPayments += 1;
      stats.totalRevenue += amount;

      const sourceKey = a.source || 'direct';
      const campaignKey = a.campaign || 'none';
      const typeKey = a.eventType || 'player';

      const s = ensure(stats.bySource, sourceKey);
      s.count += 1;
      s.revenue += amount;
      if (paid) s.paid += 1;

      const c = ensure(stats.byCampaign, campaignKey);
      c.count += 1;
      c.revenue += amount;
      if (paid) c.paid += 1;

      const t = ensure(stats.byEventType, typeKey);
      t.count += 1;
      t.revenue += amount;
      if (paid) t.paid += 1;
    }

    // Round revenue values to 2dp so the UI doesn't show 12.340000000001
    const round = (obj) => {
      Object.values(obj).forEach((v) => {
        v.revenue = Math.round(v.revenue * 100) / 100;
      });
    };
    round(stats.bySource);
    round(stats.byCampaign);
    round(stats.byEventType);
    stats.totalRevenue = Math.round(stats.totalRevenue * 100) / 100;

    res.json({
      success: true,
      stats,
      attributions: attributions.slice(0, 100),
    });
  } catch (error) {
    console.error('Error fetching marketing stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/campaigns
// ---------------------------------------------------------------
router.get('/campaigns', authenticate, isAdmin, async (req, res) => {
  try {
    const campaigns = await MarketingAttribution.distinct('campaign');
    res.json({
      success: true,
      campaigns: campaigns.filter((c) => c && c !== 'none'),
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/sources
// ---------------------------------------------------------------
router.get('/sources', authenticate, isAdmin, async (req, res) => {
  try {
    const sources = await MarketingAttribution.distinct('source');
    res.json({
      success: true,
      sources: sources.filter((s) => s && s !== 'direct'),
    });
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/registration/:registrationId
// ---------------------------------------------------------------
router.get('/registration/:registrationId', authenticate, async (req, res) => {
  try {
    const attribution = await MarketingAttribution.findOne({
      registrationId: req.params.registrationId,
    })
      .populate(
        'registrationId',
        'paymentStatus paymentComplete paymentDetails',
      )
      .lean();

    if (!attribution) {
      return res
        .status(404)
        .json({
          success: false,
          error: 'Attribution not found for this registration',
        });
    }

    res.json({ success: true, attribution });
  } catch (error) {
    console.error('Error fetching registration attribution:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/debug  (temporary — helps you see what's really stored)
// Remove this before going to production.
// ---------------------------------------------------------------
router.get('/debug', authenticate, isAdmin, async (req, res) => {
  try {
    const attr = await MarketingAttribution.findOne()
      .populate('registrationId')
      .lean();

    const reg = attr?.registrationId;

    res.json({
      success: true,
      sample: {
        attributionId: attr?._id,
        registrationIdRaw: attr?.registrationId?._id ?? null,
        registrationPaymentStatus: reg?.paymentStatus ?? null,
        registrationPaymentComplete: reg?.paymentComplete ?? null,
        registrationPaymentDetails: reg?.paymentDetails ?? null,
        amountResolved: getAmount(reg),
        isPaidResolved: isPaid(reg),
      },
      allPaymentStatuses: await Registration.distinct('paymentStatus'),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
