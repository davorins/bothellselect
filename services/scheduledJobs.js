// services/scheduledJobs.js
const cron = require('node-cron');
const { syncAllRefunds } = require('./syncRefunds');

// Sync refunds every day at 2 AM
cron.schedule('0 2 * * *', async () => {
  console.log('Running scheduled refund sync...');
  try {
    const result = await syncAllRefunds();
    console.log('Scheduled refund sync completed:', result);
  } catch (error) {
    console.error('Scheduled refund sync failed:', error);
  }
});

module.exports = { cron };
