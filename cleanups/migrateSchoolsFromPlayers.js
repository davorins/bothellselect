const mongoose = require('mongoose');
const Player = require('../models/Player');
const School = require('../models/School');
const normalizeSchoolName = require('../utils/normalizeSchoolName');

const MONGO_URI =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function migrateSchools() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Get all unique school names from players
    const players = await Player.find({
      schoolName: { $exists: true, $ne: '' },
    }).select('schoolName');

    const schoolSet = new Set(
      players.map((p) => normalizeSchoolName(p.schoolName))
    );

    for (const name of schoolSet) {
      // Check if school already exists
      const exists = await School.findOne({ name });
      if (!exists) {
        await School.create({ name });
        console.log('Added school:', name);
      }
    }

    console.log('Migration completed!');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrateSchools();
