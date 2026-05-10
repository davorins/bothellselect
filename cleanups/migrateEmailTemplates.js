const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const EmailTemplate = require('../models/EmailTemplate');

// Helper function to clean existing template content
const cleanTemplateContent = (html) => {
  if (!html) return '';

  let content = html;

  // Check if it's already a complete email
  const isCompleteEmail =
    content.includes('<!DOCTYPE') ||
    content.includes('email-body') ||
    content.includes('Bothell Select Logo');

  if (!isCompleteEmail) {
    // It's just body content, return as-is
    return content;
  }

  // It's a complete email, extract just the body
  console.log('   Found complete email structure, extracting body content...');

  // Try to extract from email-body
  const emailBodyRegex =
    /<td[^>]*class="email-body"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/td>/i;
  const match = content.match(emailBodyRegex);

  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback: remove all wrapper elements
  content = content.replace(/<!DOCTYPE[^>]*>/i, '');
  content = content.replace(/<html[^>]*>/i, '');
  content = content.replace(/<\/html>/i, '');
  content = content.replace(/<head>[\s\S]*?<\/head>/i, '');
  content = content.replace(/<body[^>]*>/i, '');
  content = content.replace(/<\/body>/i, '');
  content = content.replace(
    /<table[^>]*role="presentation"[^>]*>[\s\S]*?<\/table>/gi,
    '',
  );
  content = content.replace(
    /<div[^>]*>\s*<img[^>]*alt="Bothell Select Logo"[^>]*>\s*<\/div>/i,
    '',
  );

  const footerRegex =
    /<div[^>]*>You're receiving this email because[^<]*<\/div>[\s\S]*?<\/div>/i;
  content = content.replace(footerRegex, '');

  content = content.replace(
    /<a[^>]*href="[^"]*unsubscribe[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
    '',
  );
  content = content.replace(
    /<a[^>]*href="[^"]*contact[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
    '',
  );
  content = content.replace(
    /<a[^>]*href="[^"]*website[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
    '',
  );
  content = content.replace(/<p[^>]*>&copy;[^<]*Bothell Select[^<]*<\/p>/i, '');

  return content.trim();
};

async function migrateTemplates() {
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

    const templates = await EmailTemplate.find({});
    console.log(`📊 Found ${templates.length} templates to process`);

    let cleanedCount = 0;
    let generatedCount = 0;
    let alreadyGoodCount = 0;
    let errorCount = 0;

    for (const [index, template] of templates.entries()) {
      try {
        console.log(
          `\n🔍 [${index + 1}/${templates.length}] "${template.title}"`,
        );

        // 1. Clean the content if it has headers/footers
        const cleanedContent = cleanTemplateContent(template.content);

        if (cleanedContent !== template.content) {
          template.content = cleanedContent;
          cleanedCount++;
          console.log(`   🧹 Cleaned content (removed headers/footers)`);
        }

        // 2. Generate completeContent if missing or needs update
        const originalCompleteContent = template.completeContent;
        const newCompleteContent = template.getCompleteEmailHTML();

        if (
          !originalCompleteContent ||
          originalCompleteContent.trim() === '' ||
          originalCompleteContent !== newCompleteContent
        ) {
          template.completeContent = newCompleteContent;
          await template.save();
          generatedCount++;
          console.log(`   ✅ Generated completeContent`);
        } else {
          alreadyGoodCount++;
          console.log(`   ✓ Already has correct completeContent`);
        }
      } catch (error) {
        errorCount++;
        console.error(`   ❌ Error: ${error.message}`);
      }
    }

    console.log('\n🎉 Migration complete!');
    console.log('==================================');
    console.log(`🧹 Cleaned content: ${cleanedCount} templates`);
    console.log(`✅ Generated completeContent: ${generatedCount} templates`);
    console.log(`✓ Already correct: ${alreadyGoodCount} templates`);
    console.log(`❌ Errors: ${errorCount} templates`);
    console.log(`📊 Total: ${templates.length} templates`);
    console.log('==================================');

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

migrateTemplates();
