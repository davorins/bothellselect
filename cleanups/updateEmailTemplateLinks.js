const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const EmailTemplate = require('../models/EmailTemplate');

async function updateEmailTemplateLinks() {
  try {
    const mongoUri =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      'mongodb://localhost:27017/bothell-select';

    console.log(`🔗 Connecting to MongoDB...`);

    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });

    console.log('✅ Connected to MongoDB');

    // Find all email templates
    const templates = await EmailTemplate.find({});
    console.log(`📊 Found ${templates.length} email templates to check`);

    let updatedCount = 0;
    let alreadyUpdatedCount = 0;
    let errorCount = 0;

    for (const [index, template] of templates.entries()) {
      try {
        console.log(
          `\n🔍 [${index + 1}/${templates.length}] Checking template: "${template.title}"`,
        );

        let needsUpdate = false;

        // Check and update both content and completeContent fields
        const fieldsToCheck = ['content', 'completeContent'];

        for (const field of fieldsToCheck) {
          if (template[field]) {
            let fieldContent = template[field];
            let originalContent = fieldContent;

            // Check for old unsubscribe link and update
            if (
              fieldContent.includes(
                'href="https://bothellselect.com/unsubscribe"',
              )
            ) {
              fieldContent = fieldContent.replace(
                /href="https:\/\/bothellselect\.com\/unsubscribe"/g,
                'href="https://bothellselect.com/general-settings/notifications-settings"',
              );
              console.log(`   ↳ Updated unsubscribe link in ${field}`);
              needsUpdate = true;
            }

            // Check for old contact link and update
            if (
              fieldContent.includes('href="https://bothellselect.com/contact"')
            ) {
              fieldContent = fieldContent.replace(
                /href="https:\/\/bothellselect\.com\/contact"/g,
                'href="https://bothellselect.com/contact-us"',
              );
              console.log(`   ↳ Updated contact link in ${field}`);
              needsUpdate = true;
            }

            // Check for old website link and update
            if (
              fieldContent.includes('href="https://bothellselect.com/website"')
            ) {
              fieldContent = fieldContent.replace(
                /href="https:\/\/bothellselect\.com\/website"/g,
                'href="https://bothellselect.com"',
              );
              console.log(`   ↳ Updated website link in ${field}`);
              needsUpdate = true;
            }

            // Also check for any other variations of these links
            // Check for links without quotes
            if (
              fieldContent.includes(
                'href=https://bothellselect.com/unsubscribe',
              )
            ) {
              fieldContent = fieldContent.replace(
                /href=https:\/\/bothellselect\.com\/unsubscribe/g,
                'href="https://bothellselect.com/general-settings/notifications-settings"',
              );
              console.log(
                `   ↳ Updated unsubscribe link (no quotes) in ${field}`,
              );
              needsUpdate = true;
            }

            if (
              fieldContent.includes('href=https://bothellselect.com/contact')
            ) {
              fieldContent = fieldContent.replace(
                /href=https:\/\/bothellselect\.com\/contact/g,
                'href="https://bothellselect.com/contact-us"',
              );
              console.log(`   ↳ Updated contact link (no quotes) in ${field}`);
              needsUpdate = true;
            }

            // Update the field if changed
            if (fieldContent !== originalContent) {
              template[field] = fieldContent;
            }
          }
        }

        // Save the template if any updates were made
        if (needsUpdate) {
          await template.save();
          updatedCount++;
          console.log(`   ✅ Template updated successfully`);
        } else {
          alreadyUpdatedCount++;
          console.log(`   ✓ Template already has updated links`);
        }
      } catch (error) {
        errorCount++;
        console.error(`   ❌ Error updating template: ${error.message}`);
      }
    }

    console.log('\n🎉 Migration complete!');
    console.log('==================================');
    console.log(`✅ Updated templates: ${updatedCount}`);
    console.log(`✓ Already up-to-date: ${alreadyUpdatedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📊 Total templates checked: ${templates.length}`);
    console.log('==================================\n');

    // Show summary of changes
    if (updatedCount > 0) {
      console.log('Changes made:');
      console.log(
        '• Old unsubscribe link → https://bothellselect.com/general-settings/notifications-settings',
      );
      console.log('• Old contact link → https://bothellselect.com/contact-us');
      console.log('• Old website link → https://bothellselect.com');
    }

    mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);

    if (mongoose.connection.readyState === 1) {
      mongoose.disconnect();
    }
    process.exit(1);
  }
}

// Run the migration
updateEmailTemplateLinks();
