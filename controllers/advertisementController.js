const Advertisement = require('../models/Advertisement');
const AdImpression = require('../models/AdImpression');
const { uploadToR2, deleteFromR2, isR2Url } = require('../utils/r2');

// Helper function to get user ID from request
const getUserId = (req) => {
  if (req.user && req.user._id) {
    return req.user._id.toString();
  }
  const sessionId =
    req.headers['x-session-id'] ||
    req.headers['x-forwarded-for'] ||
    req.ip ||
    'anonymous';
  return `guest_${sessionId}`;
};

// Helper function to upload image to R2
const uploadImageToR2 = async (file, folder) => {
  if (!file) return null;

  const { url, key } = await uploadToR2(
    file.buffer,
    `ads/${folder}`,
    file.originalname,
  );

  return {
    url,
    publicId: key,
    alt: file.originalname,
    fileSize: file.size,
  };
};

// Helper function to delete image from R2
const deleteImageFromR2 = async (imageData) => {
  if (imageData && imageData.publicId && isR2Url(imageData.url)) {
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

// Get active advertisements for display
exports.getActiveAds = async (req, res) => {
  try {
    const { placement, role, pageSlug } = req.query;
    const userId = getUserId(req);
    const now = new Date();

    // Build query
    const query = {
      isActive: true,
      $and: [
        {
          $or: [
            { startDate: { $exists: false } },
            { startDate: { $lte: now } },
          ],
        },
        {
          $or: [{ endDate: { $exists: false } }, { endDate: { $gte: now } }],
        },
      ],
    };

    if (placement) query.placement = placement;

    // Role targeting
    const userRole = role || req.user?.role || 'guest';
    const roleQuery = {
      $or: [
        { targetRoles: { $in: [userRole] } },
        { targetRoles: { $size: 0 } },
        { targetRoles: { $exists: false } },
      ],
    };
    Object.assign(query, roleQuery);

    // Page targeting
    if (pageSlug && pageSlug !== 'all') {
      query.$or = [
        { targetPages: pageSlug },
        { targetPages: 'all' },
        { targetPages: { $size: 0 } },
        { targetPages: { $exists: false } },
      ];
    }

    let ads = await Advertisement.find(query).sort('displayOrder').lean();

    // Apply frequency capping
    const cappedAds = [];

    for (const ad of ads) {
      let shouldShow = true;

      if (ad.showOnceOnly) {
        const existingImpression = await AdImpression.findOne({
          adId: ad._id,
          userId: userId,
        });

        if (existingImpression) {
          shouldShow = false;

          if (ad.cooldownDays > 0) {
            const daysSinceView =
              (now - existingImpression.viewedAt) / (1000 * 60 * 60 * 24);
            if (daysSinceView >= ad.cooldownDays) {
              shouldShow = true;
            }
          }
        }
      }

      if (shouldShow) {
        cappedAds.push(ad);
      }
    }

    // Record impressions asynchronously
    for (const ad of cappedAds) {
      AdImpression.create({
        adId: ad._id,
        userId: userId,
        userType: req.user ? 'authenticated' : 'guest',
        userRole: userRole,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        userAgent: req.headers['user-agent'],
        pageUrl: req.headers.referer || req.headers.origin,
      }).catch((err) => console.error('Error recording impression:', err));

      Advertisement.findByIdAndUpdate(ad._id, {
        $inc: { impressions: 1 },
      }).catch((err) => console.error('Error incrementing impressions:', err));
    }

    res.json({
      success: true,
      ads: cappedAds,
      count: cappedAds.length,
    });
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Record ad click
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

    res.json({
      success: true,
      clickUrl: ad?.clickUrl || ad?.website,
    });
  } catch (error) {
    console.error('Error recording click:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Admin: Create advertisement
exports.createAd = async (req, res) => {
  try {
    // Parse JSON fields
    let targetRoles = req.body.targetRoles;
    let targetPages = req.body.targetPages;

    if (typeof targetRoles === 'string') {
      try {
        targetRoles = JSON.parse(targetRoles);
      } catch (e) {
        targetRoles = targetRoles.split(',').map((r) => r.trim());
      }
    }

    if (typeof targetPages === 'string') {
      try {
        targetPages = JSON.parse(targetPages);
      } catch (e) {
        targetPages = targetPages.split(',').map((p) => p.trim());
      }
    }

    // Upload images to R2 if provided
    let desktopImage = null;
    let mobileImage = null;

    if (req.files) {
      if (req.files.desktopImage && req.files.desktopImage[0]) {
        desktopImage = await uploadImageToR2(
          req.files.desktopImage[0],
          'desktop',
        );
      }
      if (req.files.mobileImage && req.files.mobileImage[0]) {
        mobileImage = await uploadImageToR2(req.files.mobileImage[0], 'mobile');
      }
    }

    // Use businessName as title if title not provided
    const title = req.body.title || req.body.businessName;

    const adData = {
      ...req.body,
      title: title,
      targetRoles: targetRoles || [],
      targetPages: targetPages || ['all'],
      desktopImage,
      mobileImage,
      createdBy: req.user._id,
      createdAt: new Date(),
    };

    const ad = new Advertisement(adData);
    await ad.save();

    res.status(201).json({
      success: true,
      message: 'Advertisement created successfully',
      data: ad,
    });
  } catch (error) {
    console.error('Error creating ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Admin: Update advertisement
exports.updateAd = async (req, res) => {
  try {
    // Parse JSON fields
    let targetRoles = req.body.targetRoles;
    let targetPages = req.body.targetPages;

    if (typeof targetRoles === 'string') {
      try {
        targetRoles = JSON.parse(targetRoles);
      } catch (e) {
        targetRoles = targetRoles.split(',').map((r) => r.trim());
      }
    }

    if (typeof targetPages === 'string') {
      try {
        targetPages = JSON.parse(targetPages);
      } catch (e) {
        targetPages = targetPages.split(',').map((p) => p.trim());
      }
    }

    // Get existing ad
    const existingAd = await Advertisement.findById(req.params.id);
    if (!existingAd) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    // Handle image updates
    let desktopImage = existingAd.desktopImage;
    let mobileImage = existingAd.mobileImage;

    if (req.files) {
      // Delete old images if new ones are uploaded
      if (req.files.desktopImage && req.files.desktopImage[0]) {
        await deleteImageFromR2(desktopImage);
        desktopImage = await uploadImageToR2(
          req.files.desktopImage[0],
          'desktop',
        );
      }
      if (req.files.mobileImage && req.files.mobileImage[0]) {
        await deleteImageFromR2(mobileImage);
        mobileImage = await uploadImageToR2(req.files.mobileImage[0], 'mobile');
      }
    }

    // Use businessName as title if title not provided
    const title = req.body.title || req.body.businessName || existingAd.title;

    const updateData = {
      ...req.body,
      title: title,
      targetRoles: targetRoles,
      targetPages: targetPages,
      desktopImage,
      mobileImage,
      updatedAt: new Date(),
      updatedBy: req.user._id,
    };

    const ad = await Advertisement.findByIdAndUpdate(
      req.params.id,
      updateData,
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

// Admin: Get all ads
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

// Admin: Get single ad
exports.getAdById = async (req, res) => {
  try {
    const ad = await Advertisement.findById(req.params.id).populate(
      'createdBy',
      'firstName lastName email',
    );

    if (!ad) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    res.json({ success: true, data: ad });
  } catch (error) {
    console.error('Error fetching ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Admin: Delete advertisement
exports.deleteAd = async (req, res) => {
  try {
    const ad = await Advertisement.findById(req.params.id);

    if (!ad) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    // Delete images from R2
    await deleteImageFromR2(ad.desktopImage);
    await deleteImageFromR2(ad.mobileImage);

    // Delete associated impressions
    await AdImpression.deleteMany({ adId: req.params.id });

    // Delete the ad
    await Advertisement.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Advertisement deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get ad statistics
exports.getAdStats = async (req, res) => {
  try {
    const stats = await Advertisement.aggregate([
      {
        $group: {
          _id: null,
          totalImpressions: { $sum: '$impressions' },
          totalClicks: { $sum: '$clicks' },
          activeAds: {
            $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] },
          },
          totalAds: { $sum: 1 },
        },
      },
    ]);

    const result = stats[0] || {
      totalImpressions: 0,
      totalClicks: 0,
      activeAds: 0,
      totalAds: 0,
    };

    const clickThroughRate =
      result.totalImpressions > 0
        ? (result.totalClicks / result.totalImpressions) * 100
        : 0;

    res.json({
      success: true,
      stats: {
        totalImpressions: result.totalImpressions,
        totalClicks: result.totalClicks,
        activeAds: result.activeAds,
        totalAds: result.totalAds,
        clickThroughRate: clickThroughRate.toFixed(2),
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
