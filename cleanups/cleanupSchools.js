// cleanSchools.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  process.env.MONGO_URI ||
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function cleanSchools() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;

    // Use your actual collections
    const parents = db.collection('parents');
    const players = db.collection('players');

    console.log('🔍 Starting school name normalization...');

    /**
     * 1️⃣ DEFINE YOUR SCHOOL NAME NORMALIZATION RULES HERE
     *
     * 'preferred name': ['variants', 'different spellings', 'abbreviations']
     */
    const SCHOOL_MAP = {
      'Tambark Creek Elementary School': [
        'tambark',
        'tambark elementary',
        'tambark creek',
        'tambark creek elementary',
        'tambark creek elem',
        'tambark creek school',
      ],

      'Gateway Middle School': [
        'gateway',
        'gateway middle',
        'gateway middle schl',
        'gateway ms',
      ],

      'Hilltop Elementary School': ['Hilltop Elementary'],

      'Woodinville High School': ['Woodinville HS', 'Woodinville Highschool'],

      'Woodin Elementary School': ['Woodin Elementary', 'Woodin'],

      'Lockwood Elementary School': [
        'Lockwood Elementary',
        'Lockwood',
        'Lockwood EL',
      ],

      'Canyon Park Middle School': [
        'Canyon Park',
        'Canyon Park Middle',
        'Canyon Park MS',
        'Canyon Park Junior High',
        'cpms',
      ],

      'Maywood Hills Elementary School': [
        'Maywood Hills',
        'Maywood Hills Elementary',
        'Maywood Hills EL',
        'Maywood',
      ],

      'Westhill Elementary School': [
        'Westhill',
        'Westhill Elementary',
        'Westhill EL',
      ],

      'Kenmore Middle School': ['Kenmore', 'Kenmore Middle', 'Kenmore MS'],

      'Forest View Elementary School': [
        'Forest View',
        'Forest View Elementary',
        'Forest View EL',
      ],

      'Kokanee Elementary School': [
        'Kokanee',
        'Kokanee Elementary',
        'Kokanee EL',
      ],

      'Northshore Middle School': [
        'Northshore',
        'Northshore Middle',
        'Northshore MS',
      ],

      'Leota Middle School': ['Leota', 'Leota Middle', 'Leota MS'],

      'Maplewood Parent Cooperative School': [
        'Maplewood',
        'Maplewood coop',
        'Maplewood K-8',
      ],

      'Cedarwood Elementary School': [
        'Cedarwood',
        'Cedarwood Elementary',
        'Cedarwood El',
      ],

      'Skyview Middle School': [
        'Skyview',
        'Skyview Middle',
        'Skyview MS',
        'Skyview middle school Bothell',
        'SkyView middle school',
        'Skyview Middleschool',
        'Sky View Middle School',
      ],

      'Canyon Creek Elementary School': [
        'Canyon Creek',
        'Canyon Creek Elementary',
        'Canyon Creek EL',
      ],

      'Shelton View Elementary School': [
        'Shelton View',
        'Shelton View Elementary',
        'Shelton View EL',
      ],

      'Bothell High School': ['Bothell High', 'Bothell HS'],

      'Evergreen Academy Elementary School': [
        'Evergreen Academy Elementary',
        'Evergreen Academy',
        'Evergreen EL',
        'Evergreen Academy EL',
        'Evergreen',
      ],

      'Silver Firs Elementary School': [
        'Silver Firs',
        'Silver Firs Elementary',
        'Silver Firs EL',
      ],

      'Hollywood Hill Elementary School': [
        'Hollywood',
        'Hollywood Hill',
        'Hollywood Hill Elementary',
        'Hollywood Hill El',
      ],

      'Frank Love Elementary School': [
        'Frank Love',
        'Frank Love Elementary',
        'Frank Love El',
      ],

      'Providence Classical Christian School': ['Providence Classical'],

      'Heatherwood Middle School': [
        'Heatherwood',
        'Heatherwood Middle',
        'Heatherwood MS',
      ],

      'Robert Frost Elementary School': [
        'Robert Frost',
        'Robert Frost Elementary',
        'Robert Frost El',
      ],

      'Heritage Christian Academy': ['Heritage Christian'],

      'Valley View Christian School': ['Valley View', 'Valley View Christian'],

      'Harbour Pointe Middle School': [
        'Harbour Pointe',
        'Harbour Pointe Middle',
        'Harbour Pointe Ml',
      ],

      'Sky Valley Education Center ': ['SVEC'],

      'Timbercrest Middle School': [
        'Timbercrest',
        'Timbercrest Middle',
        'Timbercrest Ml',
      ],

      'Cedar Park Christian Schools': [
        'Cedar Park Christian Independent Studies',
      ],

      'Brighton Middle School': ['Brighton'],

      'Odysey Elementary School': ['Odysey', 'Odysey Elementary', 'Odysey El'],

      'Harbor Pointe Middle School': [
        'Harbor Pointe',
        'Harbor Pointe Middle',
        'Harbor Pointe Ml',
      ],

      'Fernwood Elementary School': [
        'Fernwood',
        'Fernwood Elementary',
        'Fernwood El',
      ],
    };

    const variantLookup = {};
    Object.entries(SCHOOL_MAP).forEach(([preferred, variants]) => {
      variants.forEach((v) => {
        const key = v
          .trim() // remove extra spaces at start/end
          .replace(/\s+/g, ' ') // replace multiple spaces with single space
          .toLowerCase();
        variantLookup[key] = preferred;
      });
    });

    // 3️⃣ Normalize school name helper
    const normalizeSchool = (name) => {
      if (!name) return null;

      const cleaned = name
        .trim()
        .replace(/\s+/g, ' ') // multiple spaces → single space
        .toLowerCase();

      const preferred = variantLookup[cleaned];
      if (preferred) return preferred; // use preferred name
      return toTitleCase(cleaned); // fallback: capitalize words
    };

    const toTitleCase = (str) =>
      str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
      );

    // 4️⃣ Process each collection
    const collections = [
      { name: 'parents', collection: parents },
      { name: 'players', collection: players },
    ];

    for (const { name, collection } of collections) {
      const docs = await collection
        .find({ schoolName: { $exists: true } })
        .toArray();

      let updatedCount = 0;

      for (const doc of docs) {
        const corrected = normalizeSchool(doc.schoolName);
        if (corrected && corrected.trim() !== doc.schoolName.trim()) {
          await collection.updateOne(
            { _id: doc._id },
            { $set: { schoolName: corrected } }
          );
          updatedCount++;
        }
      }

      console.log(
        `✔ ${name} collection updated: ${updatedCount} documents rewritten`
      );
    }

    console.log(`\n🎉 SCHOOL CLEANUP COMPLETE!`);
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

cleanSchools();
