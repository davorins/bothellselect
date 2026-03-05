// backend/routes/formFieldRoutes.js
const express = require('express');
const router = express.Router();
const FormFieldConfig = require('../models/FormFieldConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Get all field configurations (requires authentication)
router.get('/config', requireAuth, async (req, res) => {
  try {
    const fields = await FormFieldConfig.find().sort('displayOrder');
    res.json({
      success: true,
      data: fields,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get fields for a specific form type (parent/player/guardian)
router.get('/config/:type', requireAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const fields = await FormFieldConfig.find({
      appliesTo: type,
      isEnabled: true,
    }).sort('displayOrder');

    res.json({
      success: true,
      data: fields,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Update a field configuration (admin only)
router.patch('/config/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const field = await FormFieldConfig.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true },
    );

    if (!field) {
      return res.status(404).json({
        success: false,
        error: 'Field not found',
      });
    }

    res.json({
      success: true,
      data: field,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Reorder fields (admin only)
router.post('/config/reorder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { fields } = req.body;

    const bulkOps = fields.map((f) => ({
      updateOne: {
        filter: { _id: f._id },
        update: { displayOrder: f.displayOrder },
      },
    }));

    await FormFieldConfig.bulkWrite(bulkOps);

    res.json({
      success: true,
      message: 'Fields reordered successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
