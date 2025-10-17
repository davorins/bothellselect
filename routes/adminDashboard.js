// routes/adminDashboard.js - Fixed Square integration
const express = require('express');
const router = express.Router();
const { Client, Environment } = require('square');
const Player = require('../models/Player');
const Parent = require('../models/Parent');
const Payment = require('../models/Payment');
const Registration = require('../models/Registration');
const InternalTeam = require('../models/InternalTeam');

// Initialize Square Client
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const { paymentsApi } = squareClient;

/**
 * Get current year revenue directly from Square API
 */
async function getSquareCurrentYearRevenue() {
  try {
    console.log('Fetching current year revenue from Square...');

    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1); // January 1st
    const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59); // December 31st

    // Convert dates to ISO string format required by Square
    const beginTime = yearStart.toISOString();
    const endTime = yearEnd.toISOString();

    let allPayments = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const requestParams = {
        beginTime: beginTime,
        endTime: endTime,
        limit: 100,
      };

      if (cursor) {
        requestParams.cursor = cursor;
      }

      const { result } = await paymentsApi.listPayments(requestParams);

      if (result.payments && result.payments.length > 0) {
        allPayments = allPayments.concat(result.payments);
      }

      cursor = result.cursor;
      hasMore = !!cursor;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Filter for completed payments
    const completedPayments = allPayments.filter(
      (payment) =>
        payment.status === 'COMPLETED' && payment.totalMoney?.amount > 0
    );

    const currentYearRevenue = completedPayments.reduce((sum, payment) => {
      return sum + payment.totalMoney.amount / 100;
    }, 0);

    console.log(
      `Square current year revenue: $${currentYearRevenue} from ${completedPayments.length} completed payments`
    );
    return currentYearRevenue;
  } catch (error) {
    console.error('Error fetching Square current year revenue:', error.message);
    if (error.errors) {
      console.error('Square API errors:', error.errors);
    }
    return null;
  }
}

/**
 * Get current month revenue from Square
 */
async function getSquareCurrentMonthRevenue() {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59
    );

    // Convert dates to ISO string format required by Square
    const beginTime = monthStart.toISOString();
    const endTime = monthEnd.toISOString();

    let allPayments = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const requestParams = {
        beginTime: beginTime,
        endTime: endTime,
        limit: 100,
      };

      if (cursor) {
        requestParams.cursor = cursor;
      }

      const { result } = await paymentsApi.listPayments(requestParams);

      if (result.payments && result.payments.length > 0) {
        allPayments = allPayments.concat(result.payments);
      }

      cursor = result.cursor;
      hasMore = !!cursor;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Filter for completed payments
    const completedPayments = allPayments.filter(
      (payment) =>
        payment.status === 'COMPLETED' && payment.totalMoney?.amount > 0
    );

    const currentMonthRevenue = completedPayments.reduce((sum, payment) => {
      return sum + payment.totalMoney.amount / 100;
    }, 0);

    console.log(
      `Square current month revenue: $${currentMonthRevenue} from ${completedPayments.length} completed payments`
    );
    return currentMonthRevenue;
  } catch (error) {
    console.error(
      'Error fetching Square current month revenue:',
      error.message
    );
    if (error.errors) {
      console.error('Square API errors:', error.errors);
    }
    return null;
  }
}

/**
 * Get total lifetime revenue from Square for comparison
 */
async function getSquareTotalRevenue() {
  try {
    console.log('Fetching total lifetime revenue from Square...');

    let allPayments = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const requestParams = {
        limit: 100,
      };

      if (cursor) {
        requestParams.cursor = cursor;
      }

      const { result } = await paymentsApi.listPayments(requestParams);

      if (result.payments && result.payments.length > 0) {
        allPayments = allPayments.concat(result.payments);
      }

      cursor = result.cursor;
      hasMore = !!cursor;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Filter for completed payments
    const completedPayments = allPayments.filter(
      (payment) =>
        payment.status === 'COMPLETED' && payment.totalMoney?.amount > 0
    );

    const totalRevenue = completedPayments.reduce((sum, payment) => {
      return sum + payment.totalMoney.amount / 100;
    }, 0);

    console.log(
      `Square total lifetime revenue: $${totalRevenue} from ${completedPayments.length} completed payments`
    );
    return totalRevenue;
  } catch (error) {
    console.error('Error fetching Square total revenue:', error.message);
    return null;
  }
}

// Admin Dashboard Data - Keep your working logic but enhance with Square data
router.get('/dashboard', async (req, res) => {
  try {
    const { timeRange = 'monthly' } = req.query;

    console.log('Fetching dashboard data...');

    // Get Square revenue data in parallel with other data
    const [
      squareCurrentYearRevenue,
      squareCurrentMonthRevenue,
      squareTotalRevenue,
      players,
      parents,
      payments,
      registrations,
      internalTeams,
    ] = await Promise.all([
      getSquareCurrentYearRevenue(),
      getSquareCurrentMonthRevenue(),
      getSquareTotalRevenue(), // Get total for comparison
      Player.find({}).lean(),
      Parent.find({}).lean(),
      Payment.find({}).sort({ createdAt: -1 }).lean(),
      Registration.find({}).lean(),
      InternalTeam.find({}).lean(),
    ]);

    console.log(
      `Data found: ${players.length} players, ${parents.length} parents, ${payments.length} payments, ${registrations.length} registrations, ${internalTeams.length} teams`
    );

    // Calculate player stats
    const activePlayers = players.filter((player) => {
      if (player.seasons && player.seasons.length > 0) {
        return player.seasons.some((season) => season.paymentStatus === 'paid');
      }
      return player.paymentStatus === 'paid';
    }).length;

    const totalPlayers = players.length;

    // Calculate coach stats
    const activeCoaches = parents.filter(
      (parent) => parent.isCoach === true
    ).length;

    // Calculate financial data from payments
    const completedPayments = payments.filter((p) => p.status === 'completed');
    const pendingPaymentsFromCollection = payments.filter(
      (p) => p.status === 'pending'
    );
    const failedPayments = payments.filter((p) => p.status === 'failed');

    const totalRevenue = completedPayments.reduce(
      (sum, payment) => sum + (payment.amount || 0),
      0
    );
    const pendingRevenueFromPayments = pendingPaymentsFromCollection.reduce(
      (sum, payment) => sum + (payment.amount || 0),
      0
    );

    // Calculate revenue and pending payments from player seasons
    let seasonRevenue = 0;
    let pendingSeasonPayments = 0;
    let pendingSeasonCount = 0;

    players.forEach((player) => {
      if (player.seasons) {
        player.seasons.forEach((season) => {
          if (season.paymentStatus === 'paid') {
            seasonRevenue += season.amountPaid || 0;
          } else if (season.paymentStatus === 'pending') {
            pendingSeasonPayments += season.amountPaid || 0;
            pendingSeasonCount += 1;
          }
        });
      }
    });

    const finalRevenue = totalRevenue + seasonRevenue;

    // USE SQUARE DATA FOR REVENUE IF AVAILABLE
    const accurateTotalRevenue =
      squareTotalRevenue !== null ? squareTotalRevenue : finalRevenue;

    const accurateCurrentYearRevenue =
      squareCurrentYearRevenue !== null
        ? squareCurrentYearRevenue
        : finalRevenue;

    const accurateCurrentMonthRevenue =
      squareCurrentMonthRevenue !== null
        ? squareCurrentMonthRevenue
        : calculateCurrentMonthRevenueFromLocal(completedPayments, players);

    const totalExpenses = accurateTotalRevenue * 0.25;
    const netProfit = accurateTotalRevenue - totalExpenses;

    // Combine pending payments from both sources
    const totalPendingPayments =
      pendingPaymentsFromCollection.length + pendingSeasonCount;
    const totalPendingRevenue =
      pendingRevenueFromPayments + pendingSeasonPayments;

    // Calculate monthly revenue (use Square data if available, otherwise fallback to local calculation)
    const now = new Date();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const currentMonthRevenue = accurateCurrentMonthRevenue;

    const lastMonthRevenue = completedPayments
      .filter((p) => {
        const paymentDate = new Date(p.createdAt);
        return paymentDate >= lastMonthStart && paymentDate <= lastMonthEnd;
      })
      .reduce((sum, payment) => sum + (payment.amount || 0), 0);

    const revenueGrowth =
      lastMonthRevenue > 0
        ? ((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100
        : 0;

    // Calculate pending refunds
    const pendingRefunds = [];
    payments.forEach((payment) => {
      if (payment.refunds && payment.refunds.length > 0) {
        payment.refunds.forEach((refund) => {
          if (refund.status === 'pending') {
            pendingRefunds.push({
              paymentId: payment._id,
              refundId: refund._id,
              amount: refund.amount,
              reason: refund.reason,
              requestedAt: refund.processedAt || payment.createdAt,
              parentEmail: getParentEmail(payment.parentId, parents),
              playerCount: payment.playerIds ? payment.playerIds.length : 1,
              cardLastFour: payment.cardLastFour,
              cardBrand: payment.cardBrand,
            });
          }
        });
      }
    });

    // Get pending season payments for display
    const pendingSeasonDetails = [];
    players.forEach((player) => {
      if (player.seasons) {
        player.seasons.forEach((season) => {
          if (season.paymentStatus === 'pending') {
            pendingSeasonDetails.push({
              playerName: player.fullName,
              season: season.season,
              year: season.year,
              amount: season.amountPaid || 0,
              registrationDate: season.registrationDate,
              parentEmail: getParentEmail(player.parentId, parents),
            });
          }
        });
      }
    });

    // Sort pending refunds by date (most recent first) and limit to 5
    const recentPendingRefunds = pendingRefunds
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt))
      .slice(0, 5);

    // Sort pending season payments by date (most recent first) and limit to 5
    const recentPendingSeasonPayments = pendingSeasonDetails
      .sort(
        (a, b) => new Date(b.registrationDate) - new Date(a.registrationDate)
      )
      .slice(0, 5);

    const financialStats = {
      totalRevenue: accurateTotalRevenue, // Use accurate Square data for total
      thisYearRevenue: accurateCurrentYearRevenue, // Use accurate Square data for current year
      totalExpenses,
      netProfit,
      revenueThisMonth: currentMonthRevenue, // Use accurate Square data for current month
      revenueLastMonth: lastMonthRevenue,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      pendingPayments: totalPendingPayments,
      pendingPaymentsAmount: totalPendingRevenue,
      pendingPaymentsFromCollection: pendingPaymentsFromCollection.length,
      pendingPaymentsFromSeasons: pendingSeasonCount,
      failedPayments: failedPayments.length,
      totalTransactions: completedPayments.length,
      pendingRefunds: pendingRefunds.length,
      pendingRefundsAmount: pendingRefunds.reduce(
        (sum, refund) => sum + refund.amount,
        0
      ),
    };

    // Team stats - use actual InternalTeam data
    const teamStats = {
      total: internalTeams.length,
      active: internalTeams.filter(
        (team) => team.status === 'active' || !team.status
      ).length,
      internalTeams: internalTeams.length,
      internalTeamDetails: internalTeams.map((team) => ({
        name: team.name,
        year: team.year,
        grade: team.grade,
        gender: team.gender,
        playerCount: team.playerIds ? team.playerIds.length : 0,
        coachCount: team.coachIds ? team.coachIds.length : 0,
        status: team.status || 'active',
      })),
    };

    // Player stats
    const playerStats = {
      total: totalPlayers,
      active: activePlayers,
      inactive: totalPlayers - activePlayers,
      byGender: {
        male: players.filter((p) => p.gender === 'Male').length,
        female: players.filter((p) => p.gender === 'Female').length,
      },
      byGrade: groupByGrade(players),
    };

    // Registration stats
    const paidRegistrations = registrations.filter(
      (reg) => reg.paymentStatus === 'paid'
    );
    const registrationStats = {
      total: registrations.length,
      paid: paidRegistrations.length,
      pending: registrations.filter((reg) => reg.paymentStatus === 'pending')
        .length,
      bySeason: groupBySeason(registrations),
    };

    // Payment method stats
    const paymentMethods = calculatePaymentMethods(completedPayments);

    // Recent payments for display (include pending ones from both sources)
    const recentPayments = [
      ...completedPayments.slice(0, 5).map((payment) => ({
        _id: payment._id,
        amount: payment.amount,
        status: payment.status,
        createdAt: payment.createdAt,
        cardBrand: payment.cardBrand,
        cardLastFour: payment.cardLastFour,
        playerCount: payment.playerIds ? payment.playerIds.length : 1,
        parentEmail: getParentEmail(payment.parentId, parents),
        type: 'payment',
      })),
      ...pendingPaymentsFromCollection.slice(0, 3).map((payment) => ({
        _id: payment._id,
        amount: payment.amount,
        status: payment.status,
        createdAt: payment.createdAt,
        cardBrand: payment.cardBrand,
        cardLastFour: payment.cardLastFour,
        playerCount: payment.playerIds ? payment.playerIds.length : 1,
        parentEmail: getParentEmail(payment.parentId, parents),
        type: 'payment',
      })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 8);

    // Summary for quick display - include accurate revenue data
    const summary = {
      totalPlayers: playerStats.total,
      totalCoaches: activeCoaches,
      totalTeams: teamStats.total,
      totalRevenue: financialStats.totalRevenue,
      thisYearRevenue: financialStats.thisYearRevenue, // Add accurate year revenue
      thisMonthRevenue: financialStats.revenueThisMonth, // Add accurate month revenue
      activeRegistrations: registrationStats.paid,
      totalParents: parents.length,
      pendingPayments: financialStats.pendingPayments,
      pendingRefunds: financialStats.pendingRefunds,
    };

    const responseData = {
      players: players.slice(0, 6),
      coaches: parents.filter((p) => p.isCoach).slice(0, 6),
      recentPayments: recentPayments,
      pendingRefunds: recentPendingRefunds,
      pendingSeasonPayments: recentPendingSeasonPayments,
      financialStats,
      revenueData: generateRevenueData(timeRange, completedPayments, players),
      playerStats,
      registrationStats,
      teamStats,
      paymentMethods,
      summary,
      lastUpdated: new Date().toISOString(),
    };

    console.log('=== DASHBOARD REVENUE COMPARISON ===');
    console.log(`Local Database Total: $${finalRevenue}`);
    console.log(
      `Square Total Revenue: $${squareTotalRevenue !== null ? squareTotalRevenue : 'N/A'}`
    );
    console.log(
      `Square Current Year: $${squareCurrentYearRevenue !== null ? squareCurrentYearRevenue : 'N/A'}`
    );
    console.log(
      `Square Current Month: $${squareCurrentMonthRevenue !== null ? squareCurrentMonthRevenue : 'N/A'}`
    );
    console.log(`Final Used Total: $${financialStats.totalRevenue}`);
    console.log(`Final Used Current Year: $${financialStats.thisYearRevenue}`);
    console.log(
      `Final Used Current Month: $${financialStats.revenueThisMonth}`
    );
    console.log('=====================================');
    console.log(
      `Pending payments: ${financialStats.pendingPayments} (${financialStats.pendingPaymentsFromCollection} from payments, ${financialStats.pendingPaymentsFromSeasons} from seasons)`
    );

    res.json(responseData);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      error: 'Failed to load dashboard data',
      details: error.message,
    });
  }
});

// Helper function to calculate current month revenue from local data (fallback)
function calculateCurrentMonthRevenueFromLocal(completedPayments, players) {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const paymentsThisMonth = completedPayments
    .filter((p) => new Date(p.createdAt) >= currentMonthStart)
    .reduce((sum, payment) => sum + (payment.amount || 0), 0);

  let seasonRevenueThisMonth = 0;
  players.forEach((player) => {
    if (player.seasons) {
      player.seasons.forEach((season) => {
        if (season.paymentStatus === 'paid' && season.paymentDate) {
          const paymentDate = new Date(season.paymentDate);
          if (paymentDate >= currentMonthStart) {
            seasonRevenueThisMonth += season.amountPaid || 0;
          }
        }
      });
    }
  });

  return paymentsThisMonth + seasonRevenueThisMonth;
}

// Keep all your existing helper functions exactly as they were
function getParentEmail(parentId, parents) {
  if (!parentId) return 'Unknown';
  const parent = parents.find((p) => p._id.toString() === parentId.toString());
  return parent ? parent.email : 'Unknown';
}

function generateRevenueData(timeRange, payments, players) {
  const data = {
    daily: [],
    weekly: [],
    monthly: [],
    yearly: [],
  };

  // Generate monthly data from payments and player seasons
  const monthlyData = {};

  // Process payments
  payments.forEach((payment) => {
    const date = new Date(payment.createdAt);
    const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = {
        period: monthKey,
        amount: 0,
        expenses: 0,
        transactions: 0,
      };
    }

    monthlyData[monthKey].amount += payment.amount || 0;
    monthlyData[monthKey].transactions += 1;
  });

  // Process player season payments
  players.forEach((player) => {
    if (player.seasons) {
      player.seasons.forEach((season) => {
        if (season.paymentStatus === 'paid' && season.paymentDate) {
          const date = new Date(season.paymentDate);
          const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

          if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = {
              period: monthKey,
              amount: 0,
              expenses: 0,
              transactions: 0,
            };
          }

          monthlyData[monthKey].amount += season.amountPaid || 0;
          monthlyData[monthKey].transactions += 1;
        }
      });
    }
  });

  // Calculate expenses (25% of revenue)
  Object.keys(monthlyData).forEach((monthKey) => {
    monthlyData[monthKey].expenses = monthlyData[monthKey].amount * 0.25;
  });

  // Convert to array and sort by period
  data.monthly = Object.values(monthlyData)
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-6); // Last 6 months

  // Generate sample data for other time ranges
  data.yearly = aggregateToYearly(data.monthly);
  data.weekly = generateWeeklyData(data.monthly);
  data.daily = generateDailyData(data.monthly);

  return data;
}

function aggregateToYearly(monthlyData) {
  const yearlyData = {};

  monthlyData.forEach((month) => {
    const year = month.period.split('-')[0];
    if (!yearlyData[year]) {
      yearlyData[year] = {
        period: year,
        amount: 0,
        expenses: 0,
        transactions: 0,
      };
    }
    yearlyData[year].amount += month.amount;
    yearlyData[year].expenses += month.expenses;
    yearlyData[year].transactions += month.transactions;
  });

  return Object.values(yearlyData);
}

function generateWeeklyData(monthlyData) {
  if (monthlyData.length === 0) return [];

  const currentMonth = monthlyData[monthlyData.length - 1];
  const weeklyAmount = currentMonth.amount / 4;

  return [
    {
      period: 'Week 1',
      amount: weeklyAmount * 0.9,
      expenses: weeklyAmount * 0.9 * 0.25,
    },
    {
      period: 'Week 2',
      amount: weeklyAmount * 1.1,
      expenses: weeklyAmount * 1.1 * 0.25,
    },
    {
      period: 'Week 3',
      amount: weeklyAmount * 1.0,
      expenses: weeklyAmount * 1.0 * 0.25,
    },
    {
      period: 'Week 4',
      amount: weeklyAmount * 0.8,
      expenses: weeklyAmount * 0.8 * 0.25,
    },
  ];
}

function generateDailyData(monthlyData) {
  if (monthlyData.length === 0) return [];

  const currentMonth = monthlyData[monthlyData.length - 1];
  const dailyAmount = currentMonth.amount / 30;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return days.map((day) => ({
    period: day,
    amount: dailyAmount * (0.8 + Math.random() * 0.4),
    expenses: dailyAmount * (0.8 + Math.random() * 0.4) * 0.25,
  }));
}

function groupBySeason(registrations) {
  const seasonCounts = {};
  registrations.forEach((reg) => {
    const seasonKey = reg.season || 'Unknown';
    if (!seasonCounts[seasonKey]) {
      seasonCounts[seasonKey] = 0;
    }
    seasonCounts[seasonKey]++;
  });
  return seasonCounts;
}

function groupByGrade(players) {
  const gradeCounts = {};
  players.forEach((player) => {
    const grade = player.grade || 'Unknown';
    if (!gradeCounts[grade]) {
      gradeCounts[grade] = 0;
    }
    gradeCounts[grade]++;
  });
  return gradeCounts;
}

function calculatePaymentMethods(payments) {
  const methods = {
    VISA: 0,
    MASTERCARD: 0,
    AMERICAN_EXPRESS: 0,
    DISCOVER: 0,
    OTHER: 0,
  };

  payments.forEach((payment) => {
    const brand = payment.cardBrand || 'OTHER';
    if (methods[brand] !== undefined) {
      methods[brand]++;
    } else {
      methods.OTHER++;
    }
  });

  return Object.entries(methods)
    .filter(([_, count]) => count > 0)
    .map(([brand, count]) => ({
      brand,
      count,
      percentage: Math.round((count / payments.length) * 100),
    }));
}

module.exports = router;
