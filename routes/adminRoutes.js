// backend/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const registrationRoutes = require('./registrationRoutes');

// Mount registration management routes
router.use('/admin', registrationRoutes);

// Other admin routes can be added here
router.get('/admin/refunds', (req, res) => {
  // Refund management logic
});

module.exports = router;
