const MarketingAttribution = require('../models/MarketingAttribution');
const Registration = require('../models/Registration');

class MarketingService {
  async createAttribution({
    registrationId,
    parentId,
    eventType,
    marketingData,
  }) {
    if (!parentId) throw new Error('createAttribution requires parentId');
    if (!registrationId)
      throw new Error('createAttribution requires registrationId');

    const attribution = new MarketingAttribution({
      registrationId,
      parentId,
      eventType: eventType || 'player',
      source: marketingData.source || 'direct',
      medium: marketingData.medium || 'none',
      campaign: marketingData.campaign || 'none',
      content: marketingData.content || 'none',
      term: marketingData.term || 'none',
      eventId: marketingData.eventId || null,
      landingPage: marketingData.landingPage,
      referrer: marketingData.referrer,
      userAgent: marketingData.userAgent,
      ipAddress: marketingData.ipAddress,
    });
    return await attribution.save();
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

  async getMarketingStats(campaign = null) {
    const matchStage = campaign ? { campaign } : {};

    return MarketingAttribution.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 },
          registrations: { $push: '$registrationId' },
        },
      },
    ]);
  }

  async getCampaignPerformance(campaign) {
    const attributions = await MarketingAttribution.find({ campaign })
      .populate('registrationId')
      .lean();

    return {
      totalRegistrations: attributions.length,
      bySource: this.groupBySource(attributions),
      totalRevenue: this.calculateRevenue(attributions),
    };
  }

  groupBySource(attributions) {
    return attributions.reduce((acc, curr) => {
      acc[curr.source] = (acc[curr.source] || 0) + 1;
      return acc;
    }, {});
  }

  calculateRevenue(attributions) {
    return attributions.reduce((total, attr) => {
      const reg = attr.registrationId;
      if (!reg) return total;

      const amount =
        reg.paymentDetails?.amountPaid ??
        reg.payment?.amount ??
        reg.amountPaid ??
        0;

      return total + Number(amount);
    }, 0);
  }
}

module.exports = new MarketingService();
