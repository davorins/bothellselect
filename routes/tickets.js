const express = require('express');
const router = express.Router();
const FormSubmission = require('../models/FormSubmission');
const Form = require('../models/Form');
const TicketPurchase = require('../models/TicketPurchase');
const { sendEmail } = require('../utils/email');

// Get tickets by email - UPDATED
router.get('/email/:email', async (req, res) => {
  try {
    const { email } = req.params;

    // Use TicketPurchase model instead of FormSubmission
    const ticketPurchases = await TicketPurchase.find({
      customerEmail: email,
      status: 'completed',
    })
      .populate('formId', 'title')
      .sort({ createdAt: -1 })
      .lean();

    const tickets = ticketPurchases.map((purchase) => ({
      _id: purchase._id,
      ticketId: purchase._id,
      formId: purchase.formId?._id,
      formTitle: purchase.formId?.title || 'Unknown Form',
      paymentId: purchase.paymentId,
      squarePaymentId: purchase.squarePaymentId,
      amount: purchase.amount,
      currency: purchase.currency || 'USD',
      status: purchase.status,
      purchasedAt: purchase.processedAt || purchase.createdAt,
      packageName: purchase.packageName,
      quantity: purchase.quantity,
      receiptUrl: purchase.receiptUrl,
      customerEmail: purchase.customerEmail,
      customerName: purchase.customerName,
      unitPrice: purchase.unitPrice,
      totalAmount: purchase.totalAmount,
    }));

    res.json({
      success: true,
      data: tickets,
    });
  } catch (err) {
    console.error('Error fetching tickets by email:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch tickets',
    });
  }
});

// Get tickets by user ID
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const submissions = await FormSubmission.find({
      submittedBy: userId,
      'payment.status': 'completed',
    })
      .populate('formId', 'title')
      .sort({ createdAt: -1 })
      .lean();

    const tickets = submissions.map((submission) => ({
      _id: submission._id,
      submissionId: submission._id,
      formId: submission.formId?._id,
      formTitle: submission.formId?.title || 'Unknown Form',
      paymentId: submission.payment?.id,
      amount: submission.payment?.amount || 0,
      currency: submission.payment?.currency || 'USD',
      status: submission.payment?.status || 'unknown',
      purchasedAt: submission.completedAt || submission.createdAt,
      packageName: submission.data?.selectedPackage,
      quantity: submission.data?.quantity || 1,
      receiptUrl: submission.payment?.receiptUrl,
      formData: submission.data,
    }));

    res.json({
      success: true,
      data: tickets,
    });
  } catch (err) {
    console.error('Error fetching tickets by user:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch tickets',
    });
  }
});

// NEW: Get ticket purchase by ID
router.get('/purchase/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const purchase = await TicketPurchase.findById(id)
      .populate('formId', 'title description')
      .lean();

    if (!purchase) {
      return res.status(404).json({
        success: false,
        error: 'Ticket purchase not found',
      });
    }

    res.json({
      success: true,
      data: purchase,
    });
  } catch (err) {
    console.error('Error fetching ticket purchase:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ticket purchase',
    });
  }
});

// Email Receipt
router.post('/email-receipt', async (req, res) => {
  try {
    const { ticketId, email, ticketDetails } = req.body;

    // Find the ticket
    const ticket = await TicketPurchase.findById(ticketId)
      .populate('formId', 'title')
      .lean();

    if (!ticket) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found',
      });
    }

    // Format date
    const purchaseDate = new Date(ticket.processedAt || ticket.createdAt);
    const formattedDate = purchaseDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Email content
    const subject = `Receipt for ${ticket.formId?.title || 'Your Purchase'}`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Purchase Receipt</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f9fafb;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .header {
            background: #506ee4;
            color: white;
            padding: 30px 20px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
          }
          .content {
            padding: 30px;
          }
          .greeting {
            font-size: 16px;
            margin-bottom: 20px;
            color: #4b5563;
          }
          .receipt-details {
            background-color: #f8fafc;
            border-radius: 6px;
            padding: 20px;
            margin-bottom: 25px;
            border-left: 4px solid #667eea;
          }
          .receipt-details h3 {
            margin-top: 0;
            color: #374151;
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 15px;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 14px;
          }
          .detail-label {
            color: #6b7280;
            font-weight: 500;
          }
          .detail-value {
            color: #111827;
            font-weight: 600;
          }
          .action-section {
            text-align: center;
            margin: 25px 0;
            padding: 20px;
            background-color: #f0f9ff;
            border-radius: 6px;
            border: 1px solid #e0f2fe;
          }
          .btn-receipt {
            display: inline-block;
            background: #506ee4;
            color: white;
            text-decoration: none;
            padding: 12px 30px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
          }
          .btn-receipt:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
          }
          .note {
            margin-top: 15px;
            color: #6b7280;
            font-size: 14px;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #9ca3af;
            font-size: 12px;
            border-top: 1px solid #e5e7eb;
          }
          .info-box {
            background-color: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
          }
          .info-box h4 {
            margin: 0 0 8px 0;
            color: #92400e;
            font-size: 14px;
            font-weight: 600;
          }
          .info-box p {
            margin: 0;
            color: #92400e;
            font-size: 13px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Purchased Ticket Receipt</h1>
          </div>
          
          <div class="content">
            <div class="greeting">
              <p>Hello ${ticket.customerName || 'Valued Customer'},</p>
              <p>Here is your receipt for your recent purchase. Please keep this for your records.</p>
            </div>
            
            <div class="receipt-details">
              <h3>Purchase Details</h3>
              
              <div class="detail-row">
                <span class="detail-label">Event/Form:</span>
                <span class="detail-value">${ticket.formId?.title || 'Unknown Form'}</span>
              </div>
              
              <div class="detail-row">
                <span class="detail-label">Purchase Date:</span>
                <span class="detail-value">${formattedDate}</span>
              </div>
              
              ${
                ticket.packageName
                  ? `
              <div class="detail-row">
                <span class="detail-label">Package:</span>
                <span class="detail-value">${ticket.packageName}</span>
              </div>
              `
                  : ''
              }
              
              ${
                ticket.quantity > 1
                  ? `
              <div class="detail-row">
                <span class="detail-label">Quantity:</span>
                <span class="detail-value">${ticket.quantity}</span>
              </div>
              `
                  : ''
              }

              ${
                ticket.unitPrice
                  ? `
              <div class="detail-row">
                <span class="detail-label">Unit Price:</span>
                <span class="detail-value">$${ticket.unitPrice} ${ticket.currency}</span>
              </div>
              `
                  : ''
              }
              
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span class="detail-value">$${ticket.amount} ${ticket.currency}</span>
              </div>
            </div>
            
            <div class="action-section">
              <a href="${ticket.receiptUrl}" class="btn-receipt" target="_blank">
                📄 View & Download Receipt
              </a>
              <p class="note">
                Click above to view your receipt on Square's secure platform
              </p>
            </div>
            
            <div class="info-box">
              <h4>💡 Need Help?</h4>
              <p>If you have any questions about your purchase, please contact our support team at bothellselect@proton.me</p>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
              <p style="color: #6b7280; font-size: 14px; margin-bottom: 10px;">
                Thank you for your purchase! We appreciate your support.
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                This is an automated email. Please do not reply to this message.
              </p>
            </div>
          </div>
          
          <div class="footer">
            <p>© ${new Date().getFullYear()} Bothell Select Basketball. All rights reserved.</p>
            <p>bothellselect@proton.me</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email using your existing Resend setup
    const emailResult = await sendEmail({
      to: email,
      subject: subject,
      html: html,
    });

    console.log('Receipt email sent successfully:', {
      ticketId,
      email,
      formTitle: ticket.formId?.title,
    });

    res.json({
      success: true,
      message: 'Receipt email sent successfully',
      data: emailResult,
    });
  } catch (err) {
    console.error('Error sending receipt email:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to send receipt email',
    });
  }
});

module.exports = router;
