const express = require('express');
const router = express.Router();
const PageLayout = require('../models/PageLayout');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// ===================== PUBLIC ROUTES =====================

// GET page by slug (public)
router.get('/pages/:slug', async (req, res) => {
  try {
    console.log('🔍 ===== PAGE LOOKUP START =====');
    console.log('🔍 Looking for page with slug:', req.params.slug);

    // First, count total pages to verify DB connection
    const totalPages = await PageLayout.countDocuments({});
    console.log('📊 Total pages in database:', totalPages);

    // List all pages to see what's there
    const allPages = await PageLayout.find({}).select(
      'pageSlug pageTitle isActive isTemplate publishedAt -_id',
    );
    console.log('📋 All pages in database:', JSON.stringify(allPages, null, 2));

    // Try different queries to find the issue
    console.log('\n🔍 Trying different queries:');

    // Query 1: Exact match
    const query1 = await PageLayout.findOne({
      pageSlug: req.params.slug,
      isTemplate: false,
      isActive: true,
    });
    console.log(
      '1. Exact query (with isActive: true):',
      query1 ? 'FOUND' : 'NOT FOUND',
    );

    // Query 2: Without isActive filter
    const query2 = await PageLayout.findOne({
      pageSlug: req.params.slug,
      isTemplate: false,
    });
    console.log('2. Without isActive filter:', query2 ? 'FOUND' : 'NOT FOUND');

    // Query 3: Just by slug
    const query3 = await PageLayout.findOne({
      pageSlug: req.params.slug,
    });
    console.log('3. Just by slug:', query3 ? 'FOUND' : 'NOT FOUND');

    // Query 4: Case-insensitive
    const query4 = await PageLayout.findOne({
      pageSlug: { $regex: new RegExp('^' + req.params.slug + '$', 'i') },
      isTemplate: false,
    });
    console.log('4. Case-insensitive:', query4 ? 'FOUND' : 'NOT FOUND');

    // Use the page if any query found it
    const page = query1 || query2 || query3 || query4;

    if (!page) {
      console.log('❌ No page found with any query');
      console.log('🔍 ===== PAGE LOOKUP END =====');
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        debug: {
          requestedSlug: req.params.slug,
          totalPages: totalPages,
          availablePages: allPages.map((p) => p.pageSlug),
        },
      });
    }

    console.log('✅ Page found:', {
      id: page._id,
      slug: page.pageSlug,
      title: page.pageTitle,
      isActive: page.isActive,
      isTemplate: page.isTemplate,
      publishedAt: page.publishedAt,
      sectionsCount: page.sections ? page.sections.length : 0,
    });

    console.log('🔍 ===== PAGE LOOKUP END =====');

    // For development, return the page even if not published
    res.json({
      success: true,
      data: page,
    });
  } catch (error) {
    console.error('❌ Error fetching page:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
});

// ===================== ADMIN ROUTES =====================

// GET page by ID for editing (admin)
router.get(
  '/admin/pages/edit/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const page = await PageLayout.findById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      res.json({
        success: true,
        data: page,
      });
    } catch (error) {
      console.error('Error fetching page by ID:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
      });
    }
  },
);

// GET all pages with filtering and pagination (admin)
router.get('/admin/pages', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      pageType,
      isActive,
      sortBy = 'updatedAt',
      sortOrder = 'desc',
    } = req.query;

    const query = { isTemplate: false };

    // Add search filter
    if (search && search.trim() !== '') {
      query.$or = [
        { pageTitle: { $regex: search, $options: 'i' } },
        { pageSlug: { $regex: search, $options: 'i' } },
        { metaDescription: { $regex: search, $options: 'i' } },
      ];
    }

    // Add page type filter
    if (pageType && pageType !== 'all') {
      query.pageType = pageType;
    }

    // Add active status filter
    if (isActive !== undefined && isActive !== 'all') {
      query.isActive = isActive === 'true';
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const pages = await PageLayout.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .select(
        'pageSlug pageTitle pageType isActive updatedAt publishedAt createdAt settings sections',
      )
      .lean();

    // Add sections count
    const pagesWithCount = pages.map((page) => ({
      ...page,
      sectionsCount: page.sections ? page.sections.length : 0,
    }));

    const total = await PageLayout.countDocuments(query);

    res.json({
      success: true,
      data: pagesWithCount,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching pages:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
});

// GET pages list for modal (simplified version)
router.get('/admin/pages/list', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { search = '' } = req.query;

    const query = { isTemplate: false, isActive: true };

    if (search && search.trim() !== '') {
      query.$or = [
        { pageTitle: { $regex: search, $options: 'i' } },
        { pageSlug: { $regex: search, $options: 'i' } },
      ];
    }

    const pages = await PageLayout.find(query)
      .sort({ pageTitle: 1 })
      .limit(50) // Limit for modal display
      .select('_id pageSlug pageTitle pageType isActive')
      .lean();

    res.json({
      success: true,
      data: pages,
    });
  } catch (error) {
    console.error('Error fetching pages list:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// POST create new page (admin)
router.post('/admin/pages', requireAuth, requireAdmin, async (req, res) => {
  try {
    console.log('📝 CREATE PAGE REQUEST RECEIVED');
    console.log('📦 Full request body:', JSON.stringify(req.body, null, 2));

    const {
      pageType,
      pageSlug,
      pageTitle,
      sections = [], // Default empty array
      settings = {}, // Default empty object
      metaDescription = '',
      metaKeywords = [],
    } = req.body;

    // Validate required fields
    if (!pageSlug || !pageTitle || !pageType) {
      console.log('❌ Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Page slug, title, and type are required',
        received: { pageSlug, pageTitle, pageType },
      });
    }

    // DEFAULT SETTINGS - Ensure all required fields are present
    const defaultSettings = {
      showHeader: true,
      showFooter: true,
      showSponsorBanner: true,
      sponsorBannerPosition: 'bottom',
      containerMaxWidth: '1200px',
      defaultSectionSpacing: '3rem',
      backgroundColor: '#ffffff',
      textColor: '#333333',
      accentColor: '#506ee4',
      canonicalUrl: '',
      openGraphImage: '',
      headerScripts: '',
      footerScripts: '',
    };

    // Merge with provided settings
    const mergedSettings = { ...defaultSettings, ...settings };

    // Prepare sections with defaults
    const preparedSections = sections.map((section, index) => ({
      id: section.id || `${section.type || 'section'}-${Date.now()}-${index}`,
      type: section.type || 'text',
      position: index,
      title: section.title || '',
      subtitle: section.subtitle || '',
      content: section.content || '',
      config: section.config || {},
      styles: section.styles || {},
      isActive: section.isActive !== undefined ? section.isActive : true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    console.log('✅ Preparing to create page with:', {
      pageSlug,
      pageTitle,
      pageType,
      sectionsCount: preparedSections.length,
      settings: Object.keys(mergedSettings),
    });

    // Create page object
    const page = new PageLayout({
      pageType,
      pageSlug: pageSlug.toLowerCase(),
      pageTitle,
      metaDescription,
      metaKeywords: Array.isArray(metaKeywords) ? metaKeywords : [],
      sections: preparedSections,
      settings: mergedSettings,
      version: '1.0.0',
      isTemplate: false,
      isActive: true,
      publishedAt: null,
      publishedBy: req.user.id,
      createdBy: req.user.id,
    });

    console.log('💾 Attempting to save page...');

    await page.save();

    console.log('✅ Page created successfully:', page._id);

    res.status(201).json({
      success: true,
      message: 'Page created successfully',
      data: {
        _id: page._id,
        pageSlug: page.pageSlug,
        pageTitle: page.pageTitle,
        pageType: page.pageType,
        isActive: page.isActive,
        sectionsCount: page.sections.length,
        createdAt: page.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ ERROR CREATING PAGE:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error code:', error.code);
    console.error('❌ Error message:', error.message);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach((key) => {
        errors[key] = error.errors[key].message;
      });
      console.error('❌ Validation errors:', errors);

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors,
      });
    }

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Page slug already exists',
        error: error.keyValue,
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while creating page',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString(),
    });
  }
});

// ========== HELPER FUNCTION FOR SIMILAR SLUG CHECK ==========
// Add this helper function at the bottom of your file

/**
 * Check if a slug is too similar to existing slugs
 * @param {string} slug - The slug to check
 * @param {string} excludeId - Page ID to exclude from check
 * @returns {Promise<{isSimilar: boolean, similarSlugs: Array}>}
 */
async function checkSimilarSlugs(slug, excludeId = null) {
  try {
    const query = {
      pageSlug: {
        $regex: `^${slug.slice(0, 4)}|${slug}$`,
        $options: 'i',
      },
      isTemplate: false,
    };

    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const similarSlugs = await PageLayout.find(query)
      .limit(5)
      .select('pageSlug pageTitle')
      .lean();

    return {
      isSimilar: similarSlugs.length > 0,
      similarSlugs: similarSlugs,
    };
  } catch (error) {
    console.error('Error checking similar slugs:', error);
    return { isSimilar: false, similarSlugs: [] };
  }
}

// PUT update page (admin)
router.put('/admin/pages/:id', requireAuth, requireAdmin, async (req, res) => {
  console.log('🔵 ===== BACKEND: PUT PAGE UPDATE START =====');
  console.log('🔵 Request ID:', req.params.id);
  console.log('🔵 Request body:', JSON.stringify(req.body, null, 2)); // ADD THIS LINE

  try {
    const {
      sections,
      settings,
      pageTitle,
      metaDescription,
      metaKeywords,
      isActive,
    } = req.body;

    console.log('🔵 Finding page in database...');
    const page = await PageLayout.findById(req.params.id);

    if (!page) {
      console.log('🔴 Page not found in database');
      console.log('🔵 ===== BACKEND: PUT PAGE UPDATE END =====');
      return res.status(404).json({
        success: false,
        message: 'Page not found',
      });
    }

    console.log('✅ Page found:', {
      id: page._id.toString(),
      title: page.pageTitle,
      currentSections: page.sections?.length || 0,
    });

    // Prepare update object
    const updateData = {
      updatedAt: new Date(),
    };

    // Handle sections update
    if (sections && Array.isArray(sections)) {
      console.log('🔵 Processing sections...');
      console.log('📋 Incoming sections:', sections.length);

      // Log each section with its title
      sections.forEach((section, index) => {
        console.log(
          `  ${index}: ${section.type} - "${section.title}" - id: ${section.id}`,
        );
        console.log(
          `     Content preview: ${section.content?.substring(0, 50)}...`,
        );
      });

      // Process sections - PRESERVE ALL FIELDS
      const processedSections = sections.map((section, index) => {
        // Find existing section
        const existingSection = page.sections?.find((s) => s.id === section.id);

        // Create new section with ALL fields from request
        const newSection = {
          ...section, // This includes title, content, config, styles, etc.
          position: index,
          id: section.id || `${section.type}-${Date.now()}-${index}`,
          type: section.type,
          isActive: section.isActive !== undefined ? section.isActive : true,
          createdAt: existingSection ? existingSection.createdAt : new Date(),
          updatedAt: new Date(),
        };

        // Log the processed section
        console.log(`✅ Processed section ${index}:`, {
          title: newSection.title,
          contentLength: newSection.content?.length || 0,
          hasConfig: !!newSection.config,
          hasStyles: !!newSection.styles,
        });

        return newSection;
      });

      updateData.sections = processedSections;
      console.log('✅ Sections processed:', processedSections.length);

      // Log first section details to verify
      if (processedSections.length > 0) {
        console.log('📝 First section after processing:', {
          id: processedSections[0].id,
          title: processedSections[0].title,
          content: processedSections[0].content?.substring(0, 100) + '...',
        });
      }
    }

    // Handle page title
    if (pageTitle !== undefined) {
      console.log('🔵 Updating pageTitle:', pageTitle);
      updateData.pageTitle = pageTitle;
    }

    // Handle other fields
    if (metaDescription !== undefined)
      updateData.metaDescription = metaDescription;
    if (metaKeywords !== undefined) updateData.metaKeywords = metaKeywords;
    if (isActive !== undefined) updateData.isActive = isActive;

    // Handle settings separately - merge with existing
    if (settings) {
      console.log('🔵 Updating settings...');
      updateData.settings = {
        ...page.settings,
        ...settings,
      };
    }

    console.log('📤 Final update data structure:', {
      sectionsCount: updateData.sections?.length || 0,
      hasSettings: !!updateData.settings,
      pageTitle: updateData.pageTitle,
      firstSectionTitle: updateData.sections?.[0]?.title || 'No sections',
    });

    // Perform the update
    console.log('💾 Saving to database...');
    const updateResult = await PageLayout.updateOne(
      { _id: req.params.id },
      { $set: updateData },
    );

    console.log('📊 MongoDB update result:', {
      matchedCount: updateResult.matchedCount,
      modifiedCount: updateResult.modifiedCount,
      acknowledged: updateResult.acknowledged,
    });

    if (updateResult.modifiedCount === 0 && updateResult.matchedCount > 0) {
      console.log('⚠️ No changes made - data might be identical');
    }

    // Fetch updated document
    console.log('🔍 Fetching updated page...');
    const updatedPage = await PageLayout.findById(req.params.id);

    if (!updatedPage) {
      console.log('🔴 Failed to fetch updated page');
      console.log('🔵 ===== BACKEND: PUT PAGE UPDATE END =====');
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch updated page',
      });
    }

    console.log('✅ Updated page fetched:', {
      id: updatedPage._id.toString(),
      title: updatedPage.pageTitle,
      sectionsCount: updatedPage.sections?.length || 0,
      firstSectionTitle: updatedPage.sections?.[0]?.title || 'No sections',
      updatedAt: updatedPage.updatedAt,
    });

    // Log all section titles
    if (updatedPage.sections?.length > 0) {
      console.log('📋 All section titles after save:');
      updatedPage.sections.forEach((section, index) => {
        console.log(`  ${index}: "${section.title}" (${section.type})`);
      });
    }

    console.log('🔵 ===== BACKEND: PUT PAGE UPDATE END =====');

    res.json({
      success: true,
      message: 'Page updated successfully',
      data: updatedPage,
    });
  } catch (error) {
    console.error('🔴 ===== BACKEND: PUT PAGE UPDATE ERROR =====');
    console.error('🔴 Error:', error.message);
    console.error('🔴 Stack:', error.stack);

    // Log Mongoose validation errors
    if (error.name === 'ValidationError') {
      console.error('🔴 Validation errors:');
      for (const field in error.errors) {
        console.error(`  ${field}: ${error.errors[field].message}`);
      }
    }

    console.log('🔵 ===== BACKEND: PUT PAGE UPDATE END =====');

    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// PATCH update page partial (for quick updates)
router.patch(
  '/admin/pages/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const updates = req.body;

      // Remove fields that shouldn't be updated directly
      delete updates._id;
      delete updates.createdAt;
      delete updates.pageSlug; // Slug should not be changed via PATCH
      delete updates.__v;

      // Add updated timestamp
      updates.updatedAt = new Date();

      const page = await PageLayout.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true, runValidators: true },
      );

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      res.json({
        success: true,
        message: 'Page updated successfully',
        data: page,
      });
    } catch (error) {
      console.error('Error updating page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// POST publish page (admin)
router.post(
  '/admin/pages/:id/publish',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const page = await PageLayout.findById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      // Update page with publish info
      const updateData = {
        publishedAt: new Date(),
        publishedBy: req.user.id,
        version: incrementVersion(page.version || '1.0.0'),
        updatedAt: new Date(),
      };

      const updatedPage = await PageLayout.findByIdAndUpdate(
        req.params.id,
        { $set: updateData },
        { new: true },
      );

      res.json({
        success: true,
        message: 'Page published successfully',
        data: updatedPage,
      });
    } catch (error) {
      console.error('Error publishing page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// POST unpublish page (admin)
router.post(
  '/admin/pages/:id/unpublish',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const page = await PageLayout.findById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      // Update page to unpublish
      const updateData = {
        publishedAt: null,
        version: incrementVersion(page.version || '1.0.0'),
        updatedAt: new Date(),
      };

      const updatedPage = await PageLayout.findByIdAndUpdate(
        req.params.id,
        { $set: updateData },
        { new: true },
      );

      res.json({
        success: true,
        message: 'Page unpublished successfully',
        data: updatedPage,
      });
    } catch (error) {
      console.error('Error unpublishing page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// DELETE page (admin)
router.delete(
  '/admin/pages/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const page = await PageLayout.findByIdAndDelete(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      res.json({
        success: true,
        message: 'Page deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// ===================== TEMPLATE ROUTES =====================

// GET templates (admin)
router.get('/admin/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    console.log('📋 Fetching templates');

    const templates = await PageLayout.find({
      isTemplate: true,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .select(
        'templateName name description category thumbnail sections settings',
      )
      .lean();

    console.log(`✅ Found ${templates.length} templates`);

    res.json({
      success: true,
      data: templates.map((template) => ({
        _id: template._id,
        name: template.templateName || template.name || 'Untitled Template',
        description: template.description || '',
        category: template.category || 'custom',
        thumbnail: template.thumbnail,
        sections: template.sections || [],
        settings: template.settings || {},
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })),
    });
  } catch (error) {
    console.error('❌ Error fetching templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load templates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// POST create template
router.post('/admin/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category = 'custom',
      thumbnail,
      sections = [],
      settings = {},
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Template name is required',
      });
    }

    // Generate unique slug for template
    const templateSlug = `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const template = new PageLayout({
      pageType: 'custom',
      pageSlug: templateSlug,
      pageTitle: name,
      templateName: name,
      description,
      category,
      thumbnail,
      sections: sections.map((section, index) => ({
        ...section,
        id: `${section.type}-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`,
        position: index,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      settings: {
        showHeader: true,
        showFooter: true,
        showSponsorBanner: true,
        sponsorBannerPosition: 'bottom',
        containerMaxWidth: '1200px',
        defaultSectionSpacing: '3rem',
        backgroundColor: '#ffffff',
        textColor: '#333333',
        accentColor: '#506ee4',
        ...settings,
      },
      version: '1.0.0',
      isTemplate: true,
      isActive: true,
      createdBy: req.user.id,
    });

    await template.save();

    console.log('✅ Template created:', template._id);

    res.status(201).json({
      success: true,
      message: 'Template created successfully',
      data: {
        _id: template._id,
        name: template.templateName,
        description: template.description,
        category: template.category,
        sectionsCount: template.sections.length,
        createdAt: template.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Error creating template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create template',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// POST create template from page (admin)
router.post(
  '/admin/templates/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        templateName,
        description,
        category = 'custom',
        thumbnail,
      } = req.body;

      if (!templateName) {
        return res.status(400).json({
          success: false,
          message: 'Template name is required',
        });
      }

      const page = await PageLayout.findById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      // Create template from page
      const template = new PageLayout({
        pageType: page.pageType,
        pageSlug: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        pageTitle: templateName,
        templateName,
        description,
        category,
        thumbnail,
        sections: page.sections.map((section) => ({
          ...section.toObject(),
          id: `${section.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        })),
        settings: page.settings,
        version: '1.0.0',
        isTemplate: true,
        isActive: true,
        createdBy: req.user.id,
      });

      await template.save();

      res.status(201).json({
        success: true,
        message: 'Template created successfully',
        data: template,
      });
    } catch (error) {
      console.error('Error creating template:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// DELETE template (admin)
router.delete(
  '/admin/templates/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const template = await PageLayout.findOneAndDelete({
        _id: req.params.id,
        isTemplate: true,
      });

      if (!template) {
        return res.status(404).json({
          success: false,
          message: 'Template not found',
        });
      }

      res.json({
        success: true,
        message: 'Template deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting template:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// ===================== UTILITY ROUTES =====================

// GET page stats (admin)
router.get(
  '/admin/pages/stats',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const totalPages = await PageLayout.countDocuments({ isTemplate: false });
      const publishedPages = await PageLayout.countDocuments({
        isTemplate: false,
        publishedAt: { $ne: null },
      });
      const activePages = await PageLayout.countDocuments({
        isTemplate: false,
        isActive: true,
      });

      // Get pages by type
      const pagesByType = await PageLayout.aggregate([
        { $match: { isTemplate: false } },
        { $group: { _id: '$pageType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);

      // Get recent activity
      const recentActivity = await PageLayout.find({ isTemplate: false })
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('pageTitle pageType updatedAt publishedAt')
        .lean();

      res.json({
        success: true,
        data: {
          total: totalPages,
          published: publishedPages,
          active: activePages,
          draft: totalPages - publishedPages,
          byType: pagesByType,
          recentActivity,
        },
      });
    } catch (error) {
      console.error('Error fetching page stats:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// POST duplicate page (admin)
router.post(
  '/admin/pages/:id/duplicate',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { newSlug, newTitle } = req.body;

      if (!newSlug || !newTitle) {
        return res.status(400).json({
          success: false,
          message: 'New slug and title are required',
        });
      }

      const originalPage = await PageLayout.findById(req.params.id);

      if (!originalPage) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      // Check if new slug already exists
      const existingPage = await PageLayout.findOne({
        pageSlug: newSlug.toLowerCase(),
        isTemplate: false,
      });

      if (existingPage) {
        return res.status(400).json({
          success: false,
          message: 'Page slug already exists',
        });
      }

      // Create duplicate page
      const duplicatePage = new PageLayout({
        pageType: originalPage.pageType,
        pageSlug: newSlug.toLowerCase(),
        pageTitle: newTitle,
        metaDescription: originalPage.metaDescription,
        metaKeywords: originalPage.metaKeywords,
        sections: originalPage.sections.map((section) => ({
          ...section.toObject(),
          id: `${section.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        })),
        settings: originalPage.settings,
        version: '1.0.0',
        isTemplate: false,
        isActive: false, // Start as inactive draft
        publishedAt: null,
        publishedBy: req.user.id,
        createdBy: req.user.id,
      });

      await duplicatePage.save();

      res.status(201).json({
        success: true,
        message: 'Page duplicated successfully',
        data: duplicatePage,
      });
    } catch (error) {
      console.error('Error duplicating page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// ===================== HELPER FUNCTIONS =====================

function incrementVersion(version) {
  try {
    const parts = version.split('.');
    if (parts.length >= 2) {
      const minor = parseInt(parts[1]) + 1;
      return `${parts[0]}.${minor}.${parts[2] || '0'}`;
    }
    return '1.0.1';
  } catch (error) {
    return '1.0.1';
  }
}

// ===================== EXPORT/IMPORT ROUTES =====================

// POST export page configuration
router.post(
  '/admin/pages/:id/export',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const page = await PageLayout.findById(req.params.id);

      if (!page) {
        return res.status(404).json({
          success: false,
          message: 'Page not found',
        });
      }

      const exportData = {
        meta: {
          exportedAt: new Date().toISOString(),
          version: '1.0',
          source: 'Page Builder',
        },
        page: {
          pageType: page.pageType,
          pageTitle: page.pageTitle,
          metaDescription: page.metaDescription,
          metaKeywords: page.metaKeywords,
          settings: page.settings,
        },
        sections: page.sections.map((section) => ({
          type: section.type,
          title: section.title,
          subtitle: section.subtitle,
          content: section.content,
          config: section.config,
          styles: section.styles,
          isActive: section.isActive,
        })),
      };

      res.json({
        success: true,
        data: exportData,
        filename: `${page.pageSlug}-export-${Date.now()}.json`,
      });
    } catch (error) {
      console.error('Error exporting page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

// POST import page configuration
router.post(
  '/admin/pages/import',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { importData, pageSlug, pageTitle, pageType = 'custom' } = req.body;

      if (!importData || !pageSlug || !pageTitle) {
        return res.status(400).json({
          success: false,
          message: 'Import data, slug, and title are required',
        });
      }

      // Check if slug already exists
      const existingPage = await PageLayout.findOne({
        pageSlug: pageSlug.toLowerCase(),
        isTemplate: false,
      });

      if (existingPage) {
        return res.status(400).json({
          success: false,
          message: 'Page slug already exists',
        });
      }

      // Validate import data structure
      if (!importData.sections || !Array.isArray(importData.sections)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid import data format',
        });
      }

      // Prepare sections from import data
      const preparedSections = importData.sections.map((section, index) => ({
        id: `${section.type || 'section'}-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`,
        type: section.type || 'text',
        position: index,
        title: section.title || '',
        subtitle: section.subtitle || '',
        content: section.content || '',
        config: section.config || {},
        styles: section.styles || {},
        isActive: section.isActive !== undefined ? section.isActive : true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      // Create new page from import
      const page = new PageLayout({
        pageType,
        pageSlug: pageSlug.toLowerCase(),
        pageTitle,
        metaDescription: importData.page?.metaDescription || '',
        metaKeywords: importData.page?.metaKeywords || [],
        sections: preparedSections,
        settings: importData.page?.settings || {
          showHeader: true,
          showFooter: true,
          showSponsorBanner: true,
          sponsorBannerPosition: 'bottom',
          containerMaxWidth: '1200px',
          defaultSectionSpacing: '3rem',
          backgroundColor: '#ffffff',
          textColor: '#333333',
          accentColor: '#506ee4',
        },
        version: '1.0.0',
        isTemplate: false,
        isActive: false,
        publishedAt: null,
        publishedBy: req.user.id,
        createdBy: req.user.id,
      });

      await page.save();

      res.status(201).json({
        success: true,
        message: 'Page imported successfully',
        data: page,
      });
    } catch (error) {
      console.error('Error importing page:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
      });
    }
  },
);

module.exports = router;
