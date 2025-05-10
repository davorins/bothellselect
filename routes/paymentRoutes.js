const express = require('express');
const { submitPayment } = require('../services/square-payments');
const router = express.Router();

router.post('/square-payment', async (req, res) => {
  const {
    sourceId,
    amount,
    parentId,
    playerId,
    buyerEmailAddress,
    cardDetails,
    locationId,
  } = req.body;

  // Validate required fields
  if (!sourceId)
    return res.status(400).json({ error: 'Source ID is required' });
  if (!amount || isNaN(amount))
    return res.status(400).json({ error: 'Valid amount is required' });
  if (!parentId)
    return res.status(400).json({ error: 'Parent ID is required' });
  if (!buyerEmailAddress) {
    return res.status(400).json({ error: 'Email is required for receipt' });
  }

  try {
    const result = await submitPayment(sourceId, amount, {
      parentId,
      playerId,
      buyerEmailAddress,
      cardDetails,
      locationId,
    });

    res.json(result);
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({
      error: error.message || 'Payment failed',
      details: error.errors,
    });
  }
});

module.exports = router;
