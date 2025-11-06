// cleanupPayments.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function cleanPayments() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;
    const teams = db.collection('teams');

    // Remove outdated top-level fields
    const fieldsToUnset = {
      paymentComplete: '',
      paymentStatus: '',
      registrationYear: '',
    };

    const result = await teams.updateMany({}, { $unset: fieldsToUnset });

    console.log(`✅ Cleanup complete for 'teams' collection!`);
    console.log(`Modified ${result.modifiedCount} documents.`);
  } catch (err) {
    console.error('❌ Error during cleanup:', err);
  } finally {
    await mongoose.disconnect();
  }
}

cleanPayments();
