const MarketingAttribution = require('../models/MarketingAttribution');

class MarketingService {
  async createAttribution(registrationId, marketingData) {
    const attribution = new MarketingAttribution({
      registrationId,
      source: marketingData.source || 'direct',
      medium: marketingData.medium || 'none',
      campaign: marketingData.campaign || 'none',
      content: marketingData.content || 'none',
      term: marketingData.term || 'none',
      landingPage: marketingData.landingPage,
      referrer: marketingData.referrer,
      userAgent: marketingData.userAgent,
      ipAddress: marketingData.ipAddress,
    });
    return await attribution.save();
  }

  async getMarketingStats(campaign = null) {
    const matchStage = campaign ? { campaign } : {};

    const stats = await MarketingAttribution.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 },
          registrations: { $push: '$registrationId' },
        },
      },
    ]);

    return stats;
  }

  async getCampaignPerformance(campaign) {
    const registrations = await MarketingAttribution.find({ campaign })
      .populate('registrationId')
      .lean();

    return {
      totalRegistrations: registrations.length,
      bySource: this.groupBySource(registrations),
      totalRevenue: this.calculateRevenue(registrations),
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
      if (attr.registrationId && attr.registrationId.payment) {
        // Assuming payment has amount field
        return total + (attr.registrationId.payment.amount || 0);
      }
      return total;
    }, 0);
  }
}

module.exports = new MarketingService();
