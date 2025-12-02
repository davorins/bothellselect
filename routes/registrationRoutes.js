const express = require('express');
const {
  getSeasonEvents,
  createSeasonEvent,
  updateSeasonEvent,
  deleteSeasonEvent,
  getFormConfigs,
  getFormConfig,
  updateFormConfig,
  getActiveForms,
} = require('../controllers/registrationController');

const router = express.Router();

// Season Events
router.get('/season-events', getSeasonEvents);
router.post('/season-events', createSeasonEvent);
router.put('/season-events/:eventId', updateSeasonEvent);
router.delete('/season-events/:eventId', deleteSeasonEvent);

// Form Configurations
router.get('/form-configs', getFormConfigs);
router.get('/form-config', getFormConfig);
router.put('/form-configs', updateFormConfig);

// Active Forms
router.get('/active-forms', getActiveForms);

module.exports = router;
