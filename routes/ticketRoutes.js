// backend/routes/ticketRoutes.js
const express = require('express');
const router = express.Router();
const TicketPurchase = require('../models/TicketPurchase');
const Form = require('../models/Form');
const FormSubmission = require('../models/FormSubmission');
const { authenticate, isAdmin } = require('../utils/auth');

// Get all ticket purchases with filters
router.get('/ticket-purchases', [authenticate, isAdmin], async (req, res) => {
  try {
    const {
      season,
      year,
      status,
      package: packageName,
      customer,
      startDate,
      endDate,
      page = 1,
      limit = 20,
      sort = 'dateDesc',
    } = req.query;

    // Build query (same as before)
    const query = {};

    // Status filter
    if (status) {
      query.status = status;
    }

    // Package filter
    if (packageName) {
      query.packageName = { $regex: packageName, $options: 'i' };
    }

    // Customer filter
    if (customer) {
      query.$or = [
        { customerEmail: { $regex: customer, $options: 'i' } },
        { customerName: { $regex: customer, $options: 'i' } },
      ];
    }

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Season and year filters
    if (season || year) {
      const formQuery = {};
      if (season) {
        formQuery.name = { $regex: season, $options: 'i' };
      }
      if (year) {
        formQuery.name = { $regex: year.toString(), $options: 'i' };
      }

      const forms = await Form.find(formQuery).select('_id');
      const formIds = forms.map((form) => form._id);

      if (formIds.length > 0) {
        query.formId = { $in: formIds };
      } else if (season || year) {
        // If we're filtering by season/year but no forms match, return empty
        return res.json({
          tickets: [],
          pagination: {
            current: parseInt(page),
            pageSize: parseInt(limit),
            total: 0,
            totalPages: 0,
          },
          stats: {
            totalAmount: 0,
            totalTickets: 0,
            totalTransactions: 0,
            averageTicketPrice: 0,
          },
        });
      }
    }

    // Calculate skip for pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Sort handling
    let sortOption = { createdAt: -1 };
    if (sort === 'dateAsc') {
      sortOption = { createdAt: 1 };
    } else if (sort === 'amountDesc') {
      sortOption = { amount: -1 };
    } else if (sort === 'amountAsc') {
      sortOption = { amount: 1 };
    }

    // ============================================
    // CRITICAL: Get stats for ALL matching records
    // ============================================

    // Create query for completed purchases ONLY for stats
    const statsQuery = { ...query, status: 'completed' };

    const statsPipeline = [
      { $match: statsQuery },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalTickets: { $sum: '$quantity' },
          totalTransactions: { $sum: 1 },
        },
      },
    ];

    const statsResult = await TicketPurchase.aggregate(statsPipeline);
    const stats = statsResult[0] || {
      totalAmount: 0,
      totalTickets: 0,
      totalTransactions: 0,
    };

    // Calculate average ticket price
    stats.averageTicketPrice =
      stats.totalTickets > 0 ? stats.totalAmount / stats.totalTickets : 0;

    // Get total count for pagination
    const total = await TicketPurchase.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum);

    // Only fetch paginated data if there are results
    let ticketsWithDetails = [];

    if (total > 0 && skip < total) {
      // Get paginated ticket purchases
      const tickets = await TicketPurchase.find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .lean();

      // Get form details for each ticket
      ticketsWithDetails = await Promise.all(
        tickets.map(async (ticket) => {
          try {
            const form = await Form.findById(ticket.formId).lean();
            const submission = await FormSubmission.findById(
              ticket.submissionId
            ).lean();

            let season = '';
            let year = new Date(ticket.createdAt).getFullYear();

            if (form && form.name) {
              const seasonMatch = form.name.match(
                /(Spring|Summer|Fall|Winter|Autumn)\s*(\d{4})/i
              );
              if (seasonMatch) {
                season = seasonMatch[1];
                year = parseInt(seasonMatch[2]);
              }
            }

            return {
              ...ticket,
              formName: form?.name,
              tournamentName: submission?.tournamentInfo?.tournamentName,
              season,
              year,
            };
          } catch (err) {
            console.error('Error fetching ticket details:', err);
            return ticket;
          }
        })
      );
    }

    // ============================================
    // CRITICAL: Get unique customers for Active Customers stat
    // ============================================
    const uniqueCustomersPipeline = [
      { $match: { ...query, status: 'completed' } },
      { $group: { _id: '$customerEmail' } },
      { $count: 'uniqueCustomers' },
    ];

    const uniqueCustomersResult = await TicketPurchase.aggregate(
      uniqueCustomersPipeline
    );
    const uniqueCustomers = uniqueCustomersResult[0]?.uniqueCustomers || 0;

    res.json({
      tickets: ticketsWithDetails,
      pagination: {
        current: pageNum,
        pageSize: limitNum,
        total: total,
        totalPages: totalPages,
      },
      stats: {
        ...stats,
        uniqueCustomers: uniqueCustomers,
      },
    });
  } catch (error) {
    console.error('Error fetching ticket purchases:', error);
    res.status(500).json({ error: 'Failed to fetch ticket purchases' });
  }
});

// Get ticket purchase statistics
router.get(
  '/ticket-purchases/stats',
  [authenticate, isAdmin],
  async (req, res) => {
    try {
      const { season, year } = req.query;

      const matchQuery = { status: 'completed' };

      if (season || year) {
        // Get forms matching season/year
        const formQuery = {};
        if (season) {
          formQuery.name = { $regex: season, $options: 'i' };
        }
        if (year) {
          formQuery.name = { $regex: year.toString(), $options: 'i' };
        }

        const forms = await Form.find(formQuery).select('_id');
        const formIds = forms.map((form) => form._id);

        matchQuery.formId = { $in: formIds };
      }

      const stats = await TicketPurchase.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$amount' },
            totalTickets: { $sum: '$quantity' },
            totalTransactions: { $sum: 1 },
            avgAmount: { $avg: '$amount' },
          },
        },
      ]);

      res.json(
        stats[0] || {
          totalAmount: 0,
          totalTickets: 0,
          totalTransactions: 0,
          avgAmount: 0,
        }
      );
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: 'Failed to fetch statistics' });
    }
  }
);

// Export ticket purchases to CSV
router.get(
  '/ticket-purchases/export',
  [authenticate, isAdmin],
  async (req, res) => {
    try {
      const tickets = await TicketPurchase.find({})
        .sort({ createdAt: -1 })
        .lean();

      const ticketsWithDetails = await Promise.all(
        tickets.map(async (ticket) => {
          const form = await Form.findById(ticket.formId).lean();
          return {
            ...ticket,
            formName: form?.name || 'N/A',
            date: new Date(ticket.createdAt).toISOString().split('T')[0],
            time: new Date(ticket.createdAt)
              .toISOString()
              .split('T')[1]
              .split('.')[0],
          };
        })
      );

      // Convert to CSV
      const headers = [
        'Date',
        'Time',
        'Customer Name',
        'Customer Email',
        'Package',
        'Quantity',
        'Unit Price',
        'Amount',
        'Currency',
        'Status',
        'Payment ID',
        'Form Name',
        'Created At',
      ];

      const rows = ticketsWithDetails.map((ticket) => [
        ticket.date,
        ticket.time,
        ticket.customerName || 'N/A',
        ticket.customerEmail,
        ticket.packageName || 'General Admission',
        ticket.quantity,
        ticket.unitPrice,
        ticket.amount,
        ticket.currency,
        ticket.status,
        ticket.paymentId,
        ticket.formName,
        new Date(ticket.createdAt).toISOString(),
      ]);

      const csv = [
        headers.join(','),
        ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
      ].join('\n');

      res.header('Content-Type', 'text/csv');
      res.attachment('ticket-purchases.csv');
      res.send(csv);
    } catch (error) {
      console.error('Error exporting tickets:', error);
      res.status(500).json({ error: 'Failed to export data' });
    }
  }
);

// Get ticket purchase metadata (seasons, years, packages)
router.get(
  '/ticket-purchases/metadata',
  [authenticate, isAdmin],
  async (req, res) => {
    try {
      // Get all forms to extract seasons and years
      const forms = await Form.find({}).lean();

      const seasons = new Set();
      const years = new Set();

      forms.forEach((form) => {
        if (form.name) {
          const seasonMatch = form.name.match(
            /(Spring|Summer|Fall|Winter|Autumn)/i
          );
          if (seasonMatch) {
            seasons.add(seasonMatch[1]);
          }

          const yearMatch = form.name.match(/\b(20\d{2})\b/);
          if (yearMatch) {
            years.add(parseInt(yearMatch[1]));
          }
        }
      });

      // Get unique packages
      const packages = await TicketPurchase.distinct('packageName');

      // Add current year if no years found
      if (years.size === 0) {
        years.add(new Date().getFullYear());
      }

      // Add default seasons if none found
      if (seasons.size === 0) {
        ['Spring', 'Summer', 'Fall', 'Winter'].forEach((season) =>
          seasons.add(season)
        );
      }

      res.json({
        seasons: Array.from(seasons).sort(),
        years: Array.from(years).sort((a, b) => b - a),
        packages: packages.filter((p) => p).sort(),
      });
    } catch (error) {
      console.error('Error fetching metadata:', error);
      res.status(500).json({ error: 'Failed to fetch metadata' });
    }
  }
);

module.exports = router;
