// scripts/migrateAddresses.js
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
require('dotenv').config();

async function migrateAddresses() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const parents = await Parent.find({});
    console.log(`Found ${parents.length} parents`);

    let updatedCount = 0;

    for (const parent of parents) {
      let modified = false;

      // Check if address is a string
      if (typeof parent.address === 'string') {
        console.log(`Parent ${parent._id} has string address:`, parent.address);

        // Parse the string address
        const parts = parent.address.split(',').map((p) => p.trim());

        const street = parts[0] || '';
        let street2 = '';
        let city = '';
        let state = '';
        let zip = '';

        if (parts.length >= 3) {
          city = parts[parts.length - 2] || '';
          const stateZip = parts[parts.length - 1].split(' ');
          state = stateZip[0] || '';
          zip = stateZip[1] || '';

          // If there are more than 3 parts, the middle parts are street2
          if (parts.length > 3) {
            street2 = parts.slice(1, -2).join(', ');
          }
        }

        parent.address = {
          street,
          street2,
          city,
          state,
          zip,
        };
        modified = true;
      }
      // If it's already an object but missing street2
      else if (parent.address && typeof parent.address === 'object') {
        if (!parent.address.street2 && parent.address.street2 !== '') {
          parent.address.street2 = '';
          modified = true;
        }
      }

      if (modified) {
        await parent.save();
        updatedCount++;
        console.log(`Updated parent ${parent._id} address:`, parent.address);
      }
    }

    console.log(`Migration complete. Updated ${updatedCount} parents.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrateAddresses();
