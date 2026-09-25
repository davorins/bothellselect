// services/marketingService.js
const MarketingAttribution = require('../models/MarketingAttribution');

class MarketingService {
  normalize(marketing = {}) {
    const m = marketing || {};
    return {
      source: m.utm_source || m.source || 'direct',
      medium: m.utm_medium || m.medium || 'none',
      campaign: m.utm_campaign || m.campaign || 'none',
      content: m.utm_content || m.content || 'none',
      term: m.utm_term || m.term || 'none',
      landingPage: m.landingPage || null,
      referrer: m.referrer || null,
      userAgent: m.userAgent || null,
      ipAddress: m.ipAddress || null,
      firstTouchAt: m.firstTouchAt ? new Date(m.firstTouchAt) : new Date(),
    };
  }

  async createForRegistration({
    registrationId,
    parentId,
    marketing,
    eventType = 'player',
    eventId = null,
  }) {
    if (!registrationId) throw new Error('registrationId is required');
    if (!parentId) throw new Error('parentId is required');

    const existing = await MarketingAttribution.findOne({ registrationId });
    if (existing) return existing;

    const m = this.normalize(marketing);

    return MarketingAttribution.create({
      registrationId,
      parentId,
      eventType,
      eventId,
      ...m,
      registrationAt: new Date(),
    });
  }

  async attachOrCreate({
    registrationId,
    parentId,
    marketing,
    eventType = 'player',
    eventId = null,
  }) {
    if (!registrationId) throw new Error('registrationId is required');
    if (!parentId) throw new Error('parentId is required');

    const linked = await MarketingAttribution.findOne({ registrationId });
    if (linked) return linked;

    const unlinked = await MarketingAttribution.findOneAndUpdate(
      {
        parentId,
        $or: [{ registrationId: null }, { registrationId: { $exists: false } }],
      },
      {
        $set: {
          registrationId,
          eventType,
          eventId,
          registrationAt: new Date(),
        },
      },
      { new: true, sort: { createdAt: -1 } },
    );

    if (unlinked) return unlinked;

    return this.createForRegistration({
      registrationId,
      parentId,
      marketing,
      eventType,
      eventId,
    });
  }

  async attachRegistrationToAttribution(parentId, registrationId) {
    return MarketingAttribution.findOneAndUpdate(
      {
        parentId,
        $or: [{ registrationId: null }, { registrationId: { $exists: false } }],
      },
      { $set: { registrationId, registrationAt: new Date() } },
      { new: true, sort: { createdAt: -1 } },
    );
  }
}

module.exports = new MarketingService();
