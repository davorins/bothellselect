const express = require('express');
const router = express.Router();
const School = require('../models/School');
const normalizeSchoolName = require('../utils/normalizeSchoolName');

// GET /api/schools?search=Ta
router.get('/', async (req, res) => {
  try {
    const search = req.query.search || '';

    const schools = await School.find({
      name: { $regex: search, $options: 'i' },
    })
      .sort({ name: 1 })
      .limit(20);

    res.json(schools);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load schools' });
  }
});

// POST /api/schools/addIfMissing
router.post('/addIfMissing', async (req, res) => {
  try {
    let { schoolName } = req.body;

    if (!schoolName || !schoolName.trim()) {
      return res.status(400).json({ error: 'Invalid school name' });
    }

    const cleaned = normalizeSchoolName(schoolName.trim());

    let school = await School.findOne({ name: cleaned });

    if (!school) {
      school = await School.create({ name: cleaned });
    }

    res.json({ success: true, school });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save school' });
  }
});

module.exports = router;
