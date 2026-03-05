// backend/scripts/runFormFieldSeeder.js
require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const seedFormFieldConfigs = require('../seeders/formFieldConfigSeeder');

const runSeeder = async () => {
  try {
    console.log('📦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    await seedFormFieldConfigs();

    console.log('✨ Seeding complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
};

runSeeder();
