// routes/marketingRoutes.js
const express = require('express');
const router = express.Router();
const MarketingAttribution = require('../models/MarketingAttribution');
const Registration = require('../models/Registration');
const { authenticate, isAdmin } = require('../utils/auth');

// ---------------------------------------------------------------
// Payment normalisation helpers
// ---------------------------------------------------------------

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
  return (
    Number(
      reg.paymentDetails?.amountPaid ??
        reg.payment?.amount ??
        reg.amountPaid ??
        0,
    ) || 0
  );
}

// ---------------------------------------------------------------
// GET /marketing/attribution/stats   (admin)
// ---------------------------------------------------------------
router.get('/attribution/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const { campaign, source, eventType, startDate, endDate, season, year } =
      req.query;

    const filter = {};
    if (campaign) filter.campaign = campaign;
    if (source) filter.source = source;
    if (eventType) filter.eventType = eventType;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const populateFields =
      'paymentStatus paymentComplete paymentDetails amountPaid parent player season year tryoutId';

    let attributions = await MarketingAttribution.find(filter)
      .populate('registrationId', populateFields)
      .populate('parentId', 'fullName email')
      .lean();

    // ✅ Filter by season/year of the linked Registration.
    // Attributed records without a linked registration are dropped when
    // a season or year filter is applied.
    if (season || year) {
      attributions = attributions.filter((a) => {
        const reg = a.registrationId;
        if (!reg) return false;
        if (season && reg.season !== season) return false;
        if (year && Number(reg.year) !== Number(year)) return false;
        return true;
      });
    }

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

      const s = ensure(stats.bySource, a.source || 'direct');
      s.count += 1;
      s.revenue += amount;
      if (paid) s.paid += 1;

      const c = ensure(stats.byCampaign, a.campaign || 'none');
      c.count += 1;
      c.revenue += amount;
      if (paid) c.paid += 1;

      const t = ensure(stats.byEventType, a.eventType || 'player');
      t.count += 1;
      t.revenue += amount;
      if (paid) t.paid += 1;
    }

    const round = (obj) =>
      Object.values(obj).forEach((v) => {
        v.revenue = Math.round(v.revenue * 100) / 100;
      });
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
// GET /marketing/campaigns  (admin)
// ---------------------------------------------------------------
router.get('/campaigns', authenticate, isAdmin, async (req, res) => {
  try {
    const campaigns = await MarketingAttribution.distinct('campaign');
    res.json({
      success: true,
      campaigns: campaigns.filter((c) => c && c !== 'none'),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/sources  (admin)
// ---------------------------------------------------------------
router.get('/sources', authenticate, isAdmin, async (req, res) => {
  try {
    const sources = await MarketingAttribution.distinct('source');
    res.json({
      success: true,
      sources: sources.filter((s) => s && s !== 'direct'),
    });
  } catch (error) {
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
        .json({ success: false, error: 'Attribution not found' });
    }
    res.json({ success: true, attribution });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/debug   (admin, TEMPORARY)
// ---------------------------------------------------------------
router.get('/debug', authenticate, isAdmin, async (req, res) => {
  try {
    const sample = await MarketingAttribution.findOne()
      .populate('registrationId')
      .lean();
    const reg = sample?.registrationId;

    res.json({
      success: true,
      sample: {
        attributionId: sample?._id,
        hasRegistrationIdField: sample
          ? Object.prototype.hasOwnProperty.call(sample, 'registrationId')
          : null,
        registrationIdValue: sample?.registrationId?._id ?? null,
        registrationPaymentStatus: reg?.paymentStatus ?? null,
        registrationPaymentComplete: reg?.paymentComplete ?? null,
        registrationPaymentDetails: reg?.paymentDetails ?? null,
        amountResolved: getAmount(reg),
        isPaidResolved: isPaid(reg),
      },
      counts: {
        total: await MarketingAttribution.countDocuments(),
        missingRegistrationId: await MarketingAttribution.countDocuments({
          registrationId: { $exists: false },
        }),
        nullRegistrationId: await MarketingAttribution.countDocuments({
          registrationId: null,
        }),
        paidRegistrations: await Registration.countDocuments({
          paymentStatus: 'paid',
        }),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------
// GET /marketing/seasons  (admin)
// Distinct { season, year } pairs pulled from attributed registrations
// ---------------------------------------------------------------
router.get('/seasons', authenticate, isAdmin, async (req, res) => {
  try {
    const rows = await MarketingAttribution.aggregate([
      // Look up the linked registration
      {
        $lookup: {
          from: 'registrations',
          localField: 'registrationId',
          foreignField: '_id',
          as: 'reg',
        },
      },
      { $unwind: '$reg' },
      // Only registrations with both season and year present
      {
        $match: {
          'reg.season': { $exists: true, $ne: null },
          'reg.year': { $exists: true, $ne: null },
        },
      },
      // Distinct season/year pairs, with counts
      {
        $group: {
          _id: { season: '$reg.season', year: '$reg.year' },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          season: '$_id.season',
          year: '$_id.year',
          count: 1,
          label: {
            $concat: ['$_id.season', ' ', { $toString: '$_id.year' }],
          },
        },
      },
      { $sort: { year: -1, season: 1 } },
    ]);

    res.json({ success: true, seasons: rows });
  } catch (error) {
    console.error('Error fetching marketing seasons:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
