const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Parent = require('../models/Parent');
const Payment = require('../models/Payment');
const Registration = require('../models/Registration');
const InternalTeam = require('../models/InternalTeam');

async function getRecentPayments() {
  try {
    console.log('💳 Fetching recent payments...');

    const recentPayments = await Payment.find({})
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    console.log(
      `💳 Found ${recentPayments.length} recent payments for display`
    );

    return recentPayments.map((payment) => ({
      id: payment._id,
      amount: payment.amount,
      refunded: payment.refundAmount || 0,
      createdAt: payment.createdAt,
      status: payment.status,
      cardBrand: payment.cardBrand,
      last4: payment.cardLastFour,
    }));
  } catch (error) {
    console.error('Error fetching recent payments:', error);
    return [];
  }
}

async function getPendingPaymentsData() {
  try {
    console.log(
      '🔍 Searching for pending payments in Registration collection...'
    );

    const pendingRegistrations = await Registration.find({
      paymentStatus: 'pending',
    }).lean();

    console.log(
      `📊 Found ${pendingRegistrations.length} pending registrations`
    );

    const pendingPaymentsAmount = pendingRegistrations.reduce((sum, reg) => {
      return sum + (reg.amount || reg.registrationFee || 0);
    }, 0);

    return {
      pendingPaymentsCount: pendingRegistrations.length,
      pendingPaymentsAmount: pendingPaymentsAmount,
    };
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    return { pendingPaymentsCount: 0, pendingPaymentsAmount: 0 };
  }
}

async function getPendingRefundsData() {
  try {
    console.log('🔍 Searching for pending refunds in Payment collection...');

    const paymentsWithPendingRefunds = await Payment.find({
      'refunds.status': 'pending',
    }).lean();

    console.log(
      `📋 Found ${paymentsWithPendingRefunds.length} payments with pending refunds`
    );

    let pendingRefundsCount = 0;
    let pendingRefundsAmount = 0;
    const pendingRefundsList = [];

    paymentsWithPendingRefunds.forEach((payment) => {
      const pendingRefunds = payment.refunds.filter(
        (refund) => refund.status === 'pending'
      );

      pendingRefunds.forEach((refund) => {
        pendingRefundsCount++;
        pendingRefundsAmount += refund.amount;

        pendingRefundsList.push({
          refundId: refund.refundId || refund._id,
          amount: refund.amount,
          reason: refund.reason || 'No reason provided',
          requestedAt: refund.processedAt || payment.createdAt,
          cardBrand: payment.cardBrand,
          cardLastFour: payment.cardLastFour,
        });
      });
    });

    console.log(
      `🔄 Found ${pendingRefundsCount} pending refunds totaling $${pendingRefundsAmount}`
    );

    return {
      pendingRefundsCount,
      pendingRefundsAmount,
      pendingRefundsList: pendingRefundsList.slice(0, 10),
    };
  } catch (error) {
    console.error('Error fetching pending refunds:', error);
    return {
      pendingRefundsCount: 0,
      pendingRefundsAmount: 0,
      pendingRefundsList: [],
    };
  }
}

// Update getRegistrationStats to handle NULL status
async function getRegistrationStats() {
  try {
    const registrations = await Registration.find({}).lean();

    console.log('🔍 Registration Analysis:');
    console.log(`   Total Registrations: ${registrations.length}`);

    // Count by paymentStatus including null/undefined
    const statusCounts = {};
    registrations.forEach((reg) => {
      const status = reg.paymentStatus || 'NULL/UNDEFINED';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    console.log('   Payment Status Breakdown:', statusCounts);

    return {
      total: registrations.length,
      paid: registrations.filter((reg) => reg.paymentStatus === 'paid').length,
      pending: registrations.filter((reg) => reg.paymentStatus === 'pending')
        .length,
      other: registrations.filter(
        (reg) =>
          !reg.paymentStatus ||
          (reg.paymentStatus !== 'paid' && reg.paymentStatus !== 'pending')
      ).length,
      bySeason: {},
    };
  } catch (error) {
    console.error('Error fetching registration stats:', error);
    return { total: 0, paid: 0, pending: 0, other: 0, bySeason: {} };
  }
}

router.get('/dashboard', async (req, res) => {
  try {
    console.log('\n🔄 Building dashboard...');

    const [
      players,
      parents,
      internalTeams,
      pendingData,
      refundsData,
      registrationStats,
      recentPayments,
    ] = await Promise.all([
      Player.find({}).lean(),
      Parent.find({}).lean(),
      InternalTeam.find({}).lean(),
      getPendingPaymentsData(),
      getPendingRefundsData(),
      getRegistrationStats(),
      getRecentPayments(),
    ]);

    // Calculate total adults (parents + additional guardians)
    const totalParents = parents.length;
    const totalAdditionalGuardians = parents.reduce((total, parent) => {
      return total + (parent.additionalGuardians?.length || 0);
    }, 0);

    const totalAdults = totalParents + totalAdditionalGuardians;

    // ONLY count coaches from main parent accounts, NOT from additional guardians
    const totalCoaches = parents.filter((p) => p.isCoach).length;

    console.log('👨‍👩‍👧‍👦 ADULT ACCOUNT STATISTICS:');
    console.log(`   Primary Parents: ${totalParents}`);
    console.log(`   Additional Guardians: ${totalAdditionalGuardians}`);
    console.log(`   Total Adults: ${totalAdults}`);
    console.log(`   Coaches (from Parents only): ${totalCoaches}`);

    // Get coach information for teams using DIRECT coach assignments
    const teamDetailsWithCoaches = internalTeams.map((team) => {
      const teamPlayerIds = team.playerIds || [];
      const teamCoachIds = team.coachIds || [];

      console.log(`\n🔍 Analyzing team: ${team.name}`);
      console.log(`   Team player IDs: ${teamPlayerIds.length} players`);
      console.log(`   Team coach IDs: ${teamCoachIds.length} coaches`);

      // Find coaches by their IDs from the coachIds array
      const teamCoaches = parents.filter((parent) =>
        teamCoachIds.some(
          (coachId) => coachId.toString() === parent._id.toString()
        )
      );

      console.log(
        `   Found ${teamCoaches.length} coaches for team ${team.name}`
      );
      if (teamCoaches.length > 0) {
        console.log(
          `   Coaches:`,
          teamCoaches.map((c) => c.fullName)
        );
      }

      return {
        name: team.name,
        grade: team.grade,
        gender: team.gender,
        playerCount: teamPlayerIds.length,
        coachCount: teamCoaches.length,
        coaches: teamCoaches.map((coach) => ({
          name: coach.fullName,
          email: coach.email,
        })),
      };
    });

    const responseData = {
      players: players.slice(0, 6),
      coaches: parents.filter((p) => p.isCoach).slice(0, 6),
      recentPayments: recentPayments,
      pendingRefunds: refundsData.pendingRefundsList,
      financialStats: {
        pendingPayments: pendingData.pendingPaymentsCount,
        pendingPaymentsAmount: pendingData.pendingPaymentsAmount,
        pendingRefunds: refundsData.pendingRefundsCount,
        pendingRefundsAmount: refundsData.pendingRefundsAmount,
      },
      playerStats: {
        total: players.length,
        active: players.filter((p) => p.paymentStatus === 'paid').length,
        inactive: players.filter((p) => p.paymentStatus !== 'paid').length,
        byGender: {
          male: players.filter((p) => p.gender === 'Male').length,
          female: players.filter((p) => p.gender === 'Female').length,
        },
        byGrade: {},
      },
      teamStats: {
        total: internalTeams.length,
        active: internalTeams.length,
        internalTeams: internalTeams.length,
        internalTeamDetails: teamDetailsWithCoaches,
      },
      registrationStats: registrationStats,
      adultStats: {
        total: totalAdults,
        parents: totalParents,
        additionalGuardians: totalAdditionalGuardians,
        coaches: totalCoaches,
      },
      summary: {
        totalPlayers: players.length,
        totalCoaches: totalCoaches,
        totalTeams: internalTeams.length,
        activeRegistrations: registrationStats.paid,
        totalAdults: totalAdults,
        totalParents: totalParents,
        totalRegistrations: registrationStats.total,
        pendingPayments: pendingData.pendingPaymentsCount,
        pendingRefunds: refundsData.pendingRefundsCount,
      },
      lastUpdated: new Date().toISOString(),
    };

    console.log('✅ Dashboard ready!');
    console.log(
      `📊 Total Adults: ${totalAdults} (${totalParents} parents + ${totalAdditionalGuardians} guardians)`
    );
    console.log(`👨‍🏫 Coaches: ${totalCoaches}`);

    res.json(responseData);
  } catch (error) {
    console.error('💥 Dashboard error:', error);
    res.status(500).json({
      error: 'Failed to load dashboard',
      details: error.message,
    });
  }
});

module.exports = router;
