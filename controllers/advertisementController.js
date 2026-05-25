const Advertisement = require('../models/Advertisement');
const AdImpression = require('../models/AdImpression');
const { uploadToR2, deleteFromR2, isR2Url } = require('../utils/r2');

// ─── Helpers ────────────────────────────────────────────────────────────────

const getUserId = (req) => {
  if (req.user?._id) return req.user._id.toString();
  const sessionId =
    req.headers['x-session-id'] ||
    req.headers['x-forwarded-for'] ||
    req.ip ||
    'anonymous';
  return `guest_${sessionId}`;
};

const uploadImageToR2 = async (file, folder) => {
  if (!file) return null;
  const { url, key } = await uploadToR2(
    file.buffer,
    `ads/${folder}`,
    file.originalname,
  );
  return { url, publicId: key, alt: file.originalname, fileSize: file.size };
};

const deleteImageFromR2 = async (imageData) => {
  if (imageData?.publicId && isR2Url(imageData.url)) {
    try {
      await deleteFromR2(imageData.url);
      return true;
    } catch (error) {
      console.error('Error deleting image from R2:', error);
      return false;
    }
  }
  return false;
};

const parseArrayField = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    return JSON.parse(value);
  } catch {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
};

// ─── Public ─────────────────────────────────────────────────────────────────

// GET /ads/active
exports.getActiveAds = async (req, res) => {
  try {
    const { placement, role, pageSlug } = req.query;
    const userId = getUserId(req);
    const now = new Date();
    const userRole = role || req.user?.role || 'guest';

    // ── Build query using $and for ALL conditions ──────────────────────────
    // This avoids the previous bug where Object.assign clobbered an existing
    // $or key, causing page-targeting to silently drop.
    const andClauses = [
      // Date range: not started yet
      {
        $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }],
      },
      // Date range: already expired
      {
        $or: [{ endDate: { $exists: false } }, { endDate: { $gte: now } }],
      },
      // Role targeting: empty array = show to all
      {
        $or: [
          { targetRoles: { $in: [userRole] } },
          { targetRoles: { $size: 0 } },
          { targetRoles: { $exists: false } },
        ],
      },
    ];

    // Page targeting (only restrict when a specific slug is given)
    if (pageSlug && pageSlug !== 'all') {
      andClauses.push({
        $or: [
          { targetPages: pageSlug },
          { targetPages: 'all' },
          { targetPages: { $size: 0 } },
          { targetPages: { $exists: false } },
        ],
      });
    }

    const query = {
      isActive: true,
      $and: andClauses,
    };

    if (placement) query.placement = placement;

    let ads = await Advertisement.find(query).sort('displayOrder').lean();

    // ── Frequency capping ─────────────────────────────────────────────────
    const cappedAds = [];
    for (const ad of ads) {
      if (!ad.showOnceOnly) {
        cappedAds.push(ad);
        continue;
      }

      const existing = await AdImpression.findOne({ adId: ad._id, userId });

      if (!existing) {
        cappedAds.push(ad);
        continue;
      }

      // Cooldown: show again after N days
      if (ad.cooldownDays > 0) {
        const daysSince = (now - existing.viewedAt) / (1000 * 60 * 60 * 24);
        if (daysSince >= ad.cooldownDays) {
          cappedAds.push(ad);
        }
      }
      // else: showOnceOnly + no cooldown = never show again after first view
    }

    // ── Record impressions (fire-and-forget) ──────────────────────────────
    for (const ad of cappedAds) {
      AdImpression.create({
        adId: ad._id,
        userId,
        userType: req.user ? 'authenticated' : 'guest',
        userRole,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        userAgent: req.headers['user-agent'],
        pageUrl: req.headers.referer || req.headers.origin,
      }).catch((err) => console.error('Error recording impression:', err));

      Advertisement.findByIdAndUpdate(ad._id, {
        $inc: { impressions: 1 },
      }).catch((err) => console.error('Error incrementing impressions:', err));
    }

    res.json({ success: true, ads: cappedAds, count: cappedAds.length });
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /ads/click/:adId
exports.recordClick = async (req, res) => {
  try {
    const { adId } = req.params;
    const userId = getUserId(req);

    await AdImpression.findOneAndUpdate(
      { adId, userId, clicked: false },
      { clicked: true, clickedAt: new Date() },
      { sort: { viewedAt: -1 } },
    );

    const ad = await Advertisement.findByIdAndUpdate(
      adId,
      { $inc: { clicks: 1 } },
      { new: true },
    );

    res.json({ success: true, clickUrl: ad?.clickUrl || ad?.website });
  } catch (error) {
    console.error('Error recording click:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

// GET /ads/admin
exports.getAllAds = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, placement } = req.query;
    const query = {};
    if (status === 'active') query.isActive = true;
    if (status === 'inactive') query.isActive = false;
    if (placement) query.placement = placement;

    const ads = await Advertisement.find(query)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('createdBy', 'firstName lastName email');

    const total = await Advertisement.countDocuments(query);

    res.json({
      success: true,
      ads,
      pagination: {
        current: parseInt(page),
        pageSize: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /ads/admin/stats
exports.getAdStats = async (req, res) => {
  try {
    const stats = await Advertisement.aggregate([
      {
        $group: {
          _id: null,
          totalImpressions: { $sum: '$impressions' },
          totalClicks: { $sum: '$clicks' },
          activeAds: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          totalAds: { $sum: 1 },
        },
      },
    ]);

    const r = stats[0] || {
      totalImpressions: 0,
      totalClicks: 0,
      activeAds: 0,
      totalAds: 0,
    };
    const clickThroughRate =
      r.totalImpressions > 0 ? (r.totalClicks / r.totalImpressions) * 100 : 0;

    res.json({
      success: true,
      stats: {
        totalImpressions: r.totalImpressions,
        totalClicks: r.totalClicks,
        activeAds: r.activeAds,
        totalAds: r.totalAds,
        clickThroughRate: clickThroughRate.toFixed(2),
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /ads/admin/:id
exports.getAdById = async (req, res) => {
  try {
    const ad = await Advertisement.findById(req.params.id).populate(
      'createdBy',
      'firstName lastName email',
    );
    if (!ad)
      return res.status(404).json({ success: false, error: 'Ad not found' });
    res.json({ success: true, data: ad });
  } catch (error) {
    console.error('Error fetching ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /ads/admin
exports.createAd = async (req, res) => {
  try {
    const targetRoles = parseArrayField(req.body.targetRoles);
    const targetPages = parseArrayField(req.body.targetPages);

    let desktopImage = null;
    let mobileImage = null;
    if (req.files?.desktopImage?.[0]) {
      desktopImage = await uploadImageToR2(
        req.files.desktopImage[0],
        'desktop',
      );
    }
    if (req.files?.mobileImage?.[0]) {
      mobileImage = await uploadImageToR2(req.files.mobileImage[0], 'mobile');
    }

    const ad = new Advertisement({
      ...req.body,
      title: req.body.title || req.body.businessName,
      targetRoles,
      targetPages: targetPages.length ? targetPages : ['all'],
      desktopImage,
      mobileImage,
      createdBy: req.user._id,
    });
    await ad.save();

    res
      .status(201)
      .json({
        success: true,
        message: 'Advertisement created successfully',
        data: ad,
      });
  } catch (error) {
    console.error('Error creating ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// PUT /ads/admin/:id
exports.updateAd = async (req, res) => {
  try {
    const targetRoles = parseArrayField(req.body.targetRoles);
    const targetPages = parseArrayField(req.body.targetPages);

    const existingAd = await Advertisement.findById(req.params.id);
    if (!existingAd)
      return res.status(404).json({ success: false, error: 'Ad not found' });

    let desktopImage = existingAd.desktopImage;
    let mobileImage = existingAd.mobileImage;

    if (req.files?.desktopImage?.[0]) {
      await deleteImageFromR2(desktopImage);
      desktopImage = await uploadImageToR2(
        req.files.desktopImage[0],
        'desktop',
      );
    }
    if (req.files?.mobileImage?.[0]) {
      await deleteImageFromR2(mobileImage);
      mobileImage = await uploadImageToR2(req.files.mobileImage[0], 'mobile');
    }

    const ad = await Advertisement.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        title: req.body.title || req.body.businessName || existingAd.title,
        targetRoles,
        targetPages: targetPages.length ? targetPages : existingAd.targetPages,
        desktopImage,
        mobileImage,
        updatedAt: new Date(),
        updatedBy: req.user._id,
      },
      { new: true, runValidators: true },
    );

    res.json({
      success: true,
      message: 'Advertisement updated successfully',
      data: ad,
    });
  } catch (error) {
    console.error('Error updating ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /ads/admin/:id
exports.deleteAd = async (req, res) => {
  try {
    const ad = await Advertisement.findById(req.params.id);
    if (!ad)
      return res.status(404).json({ success: false, error: 'Ad not found' });

    await deleteImageFromR2(ad.desktopImage);
    await deleteImageFromR2(ad.mobileImage);
    await AdImpression.deleteMany({ adId: req.params.id });
    await Advertisement.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Advertisement deleted successfully' });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
