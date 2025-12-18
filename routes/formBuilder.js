// formBuilder.js
const express = require('express');
const router = express.Router();
const Form = require('../models/Form');
const FormSubmission = require('../models/FormSubmission');
const { authenticate, isAdmin } = require('../utils/auth');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Simple UUID v4 generator (replaces the uuid package)
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Form-specific admin check (doesn't affect other files)
const requireFormAdmin = (req, res, next) => {
  console.log('Form admin check - User role:', req.user?.role);

  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required for form builder',
    });
  }

  if (req.user.role !== 'admin') {
    console.log(
      `Form access denied - User role: ${req.user.role}, required: admin`
    );
    return res.status(403).json({
      success: false,
      error:
        'Form builder requires admin access. Current role: ' + req.user.role,
    });
  }

  next();
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/forms/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|csv|txt/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image, document, and text files are allowed'));
    }
  },
});

// Get all forms for builder
router.get('/builder/forms', authenticate, async (req, res) => {
  console.log('=== FORM BUILDER FETCH FORMS ===');
  console.log('User ID:', req.user?._id);
  console.log('User email:', req.user?.email);
  console.log('User role:', req.user?.role);

  try {
    const { status, search, page = 1, limit = 20 } = req.query;

    const query = {};

    // Check if user is admin - show only forms they created
    if (req.user.role !== 'admin') {
      console.log(
        '⚠️ Non-admin user accessing form builder. Role:',
        req.user.role
      );
      // Return only forms created by this user
      query.createdBy = req.user._id;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    // Use lean() for faster queries, populate with correct model name
    const forms = await Form.find(query)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Form.countDocuments(query);

    console.log(`✅ Found ${forms.length} forms for user ${req.user.email}`);

    res.json({
      success: true,
      data: forms,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching forms:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch forms',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get single form for editing
router.get('/builder/forms/:id', authenticate, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id).lean();

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Check if user has permission to edit this form
    if (
      req.user.role !== 'admin' &&
      form.createdBy.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to edit this form',
      });
    }

    res.json({ success: true, data: form });
  } catch (error) {
    console.error('Error fetching form:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch form' });
  }
});

// Create new form
router.post(
  '/builder/forms',
  authenticate,
  [
    body('name').trim().notEmpty().withMessage('Form name is required'),
    body('title').trim().notEmpty().withMessage('Form title is required'),
    body('status').optional().isIn(['draft', 'published', 'archived']),
    body('fields').optional().isArray(),
    body('settings').optional().isObject(),
    body('isTournamentForm').optional().isBoolean(),
    body('tournamentSettings').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Check if form name already exists
      const existingForm = await Form.findOne({ name: req.body.name });
      if (existingForm) {
        return res.status(400).json({
          success: false,
          error: 'Form name already exists',
        });
      }

      // Add order to fields if not present
      if (req.body.fields && Array.isArray(req.body.fields)) {
        req.body.fields = req.body.fields.map((field, index) => ({
          ...field,
          order: field.order || index,
        }));
      }

      const form = new Form({
        ...req.body,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      });

      await form.save();

      res.status(201).json({
        success: true,
        data: form,
        message: 'Form created successfully',
      });
    } catch (error) {
      console.error('Error creating form:', error);
      res.status(500).json({ success: false, error: 'Failed to create form' });
    }
  }
);

// Update form
router.put(
  '/builder/forms/:id',
  authenticate,
  [
    body('name').optional().trim().notEmpty(),
    body('title').optional().trim().notEmpty(),
    body('status').optional().isIn(['draft', 'published', 'archived']),
    body('fields').optional().isArray(),
    body('settings').optional().isObject(),
    body('version').optional().isInt({ min: 1 }),
    // Add these new validations for tournament settings
    body('isTournamentForm').optional().isBoolean(),
    body('tournamentSettings').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const form = await Form.findById(req.params.id);

      if (!form) {
        return res
          .status(404)
          .json({ success: false, error: 'Form not found' });
      }

      // Check if user has permission to edit this form
      if (
        req.user.role !== 'admin' &&
        form.createdBy.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to edit this form',
        });
      }

      // Check if name is being changed and if it already exists
      if (req.body.name && req.body.name !== form.name) {
        const existingForm = await Form.findOne({
          name: req.body.name,
          _id: { $ne: form._id },
        });
        if (existingForm) {
          return res.status(400).json({
            success: false,
            error: 'Form name already exists',
          });
        }
      }

      // Increment version if fields or settings changed
      const fieldsChanged =
        JSON.stringify(form.fields) !== JSON.stringify(req.body.fields);
      const settingsChanged =
        JSON.stringify(form.settings) !== JSON.stringify(req.body.settings);
      const tournamentSettingsChanged =
        JSON.stringify(form.tournamentSettings) !==
        JSON.stringify(req.body.tournamentSettings);

      if (fieldsChanged || settingsChanged || tournamentSettingsChanged) {
        req.body.version = (form.version || 1) + 1;
      }

      // Update form
      Object.keys(req.body).forEach((key) => {
        if (key !== '_id' && key !== 'createdAt' && key !== 'createdBy') {
          form[key] = req.body[key];
        }
      });

      form.updatedBy = req.user._id;
      form.updatedAt = new Date();

      // Set publishedAt if status changed to published
      if (req.body.status === 'published' && form.status !== 'published') {
        form.publishedAt = new Date();
      }

      await form.save();

      res.json({
        success: true,
        data: form,
        message: 'Form updated successfully',
      });
    } catch (error) {
      console.error('Error updating form:', error);
      res.status(500).json({ success: false, error: 'Failed to update form' });
    }
  }
);

// Duplicate form
router.post('/builder/forms/:id/duplicate', authenticate, async (req, res) => {
  try {
    const originalForm = await Form.findById(req.params.id);

    if (!originalForm) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Check if user has permission to duplicate this form
    if (
      req.user.role !== 'admin' &&
      originalForm.createdBy.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to duplicate this form',
      });
    }

    // Create new form with "Copy of" prefix
    const newFormData = originalForm.toObject();
    delete newFormData._id;
    delete newFormData.createdAt;
    delete newFormData.updatedAt;
    delete newFormData.publishedAt;

    newFormData.name = `Copy of ${originalForm.name}_${Date.now()}`;
    newFormData.title = `Copy of ${originalForm.title}`;
    newFormData.status = 'draft';
    newFormData.createdBy = req.user._id;
    newFormData.updatedBy = req.user._id;
    newFormData.views = 0;
    newFormData.submissions = 0;

    // Regenerate shortcode
    const prefix = 'form_';
    const random = Math.random().toString(36).substr(2, 8);
    newFormData.shortcode = `${prefix}${random}`;

    const newForm = new Form(newFormData);
    await newForm.save();

    res.status(201).json({
      success: true,
      data: newForm,
      message: 'Form duplicated successfully',
    });
  } catch (error) {
    console.error('Error duplicating form:', error);
    res.status(500).json({ success: false, error: 'Failed to duplicate form' });
  }
});

// Delete form
router.delete('/builder/forms/:id', authenticate, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Check if user has permission to delete this form
    if (
      req.user.role !== 'admin' &&
      form.createdBy.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to delete this form',
      });
    }

    // Also delete all submissions for this form
    await FormSubmission.deleteMany({ formId: form._id });

    await form.deleteOne();

    res.json({
      success: true,
      message: 'Form and its submissions deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting form:', error);
    res.status(500).json({ success: false, error: 'Failed to delete form' });
  }
});

// Export form data
router.get('/builder/forms/:id/export', authenticate, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id).lean();

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Check if user has permission to export this form
    if (
      req.user.role !== 'admin' &&
      form.createdBy.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to export this form',
      });
    }

    // Get submissions if requested
    let submissions = [];
    if (req.query.includeSubmissions === 'true') {
      submissions = await FormSubmission.find({ formId: form._id })
        .sort({ submittedAt: -1 })
        .limit(1000)
        .lean();
    }

    const exportData = {
      form,
      submissions,
      exportDate: new Date(),
      totalSubmissions: submissions.length,
    };

    res.json({
      success: true,
      data: exportData,
    });
  } catch (error) {
    console.error('Error exporting form:', error);
    res.status(500).json({ success: false, error: 'Failed to export form' });
  }
});

// Import form from JSON
router.post(
  '/builder/forms/import',
  authenticate,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const importData = JSON.parse(fileContent);

      // Clean up temp file
      fs.unlinkSync(filePath);

      if (!importData.form) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid form data format' });
      }

      const formData = importData.form;

      // Check if form name already exists
      const existingForm = await Form.findOne({ name: formData.name });
      if (existingForm) {
        return res.status(400).json({
          success: false,
          error: 'Form with this name already exists',
        });
      }

      // Prepare new form - include tournament settings if they exist
      const newForm = new Form({
        ...formData,
        _id: undefined,
        createdBy: req.user._id,
        updatedBy: req.user._id,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: formData.status === 'published' ? new Date() : undefined,
        views: 0,
        submissions: 0,
        // Ensure tournament settings are included if they exist in import
        isTournamentForm: formData.isTournamentForm || false,
        tournamentSettings: formData.tournamentSettings || undefined,
      });

      // Regenerate shortcode
      const prefix = 'form_';
      const random = Math.random().toString(36).substr(2, 8);
      newForm.shortcode = `${prefix}${random}`;

      await newForm.save();

      res.status(201).json({
        success: true,
        data: newForm,
        message: 'Form imported successfully',
      });
    } catch (error) {
      console.error('Error importing form:', error);

      // Clean up file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({ success: false, error: 'Failed to import form' });
    }
  }
);

// Get form preview (no auth required for embed)
router.get('/preview/:id', async (req, res) => {
  try {
    const form = await Form.findById(req.params.id).lean();

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Increment view count
    await Form.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json({
      success: true,
      data: form,
    });
  } catch (error) {
    console.error('Error fetching form preview:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch form' });
  }
});

// Get embed code for form
router.get('/embed-code/:id', async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    const embedData = {
      html: form.embedHtml,
      shortcode: form.shortcodeTag,
      iframeUrl: `/forms/embed/${form._id}`,
      directUrl: `/forms/view/${form._id}`,
      scriptTag: `<script src="/js/form-embed.js" data-form-id="${form._id}" async></script>`,
    };

    res.json({
      success: true,
      data: embedData,
    });
  } catch (error) {
    console.error('Error getting embed code:', error);
    res.status(500).json({ success: false, error: 'Failed to get embed code' });
  }
});

// Get published forms for public display
router.get('/preview-forms', async (req, res) => {
  console.log('=== PUBLIC FORM FETCH ===');

  try {
    const { search, limit = 50 } = req.query;

    const query = {
      status: 'published', // Only published forms
      passwordProtected: false, // Only non-password protected forms
    };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    // Only return minimal data for public display
    const forms = await Form.find(query)
      .select(
        '_id name title description status shortcode fields settings views submissions createdAt'
      )
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    console.log(`✅ Found ${forms.length} published forms for public display`);

    res.json({
      success: true,
      data: forms,
      count: forms.length,
    });
  } catch (error) {
    console.error('❌ Error fetching public forms:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch forms',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get latest published form
router.get('/preview-latest', async (req, res) => {
  try {
    const form = await Form.findOne({
      status: 'published',
      passwordProtected: false,
    })
      .select('_id name title description status fields settings shortcode')
      .sort({ createdAt: -1 })
      .lean();

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'No published forms found',
      });
    }

    res.json({
      success: true,
      data: form,
    });
  } catch (error) {
    console.error('Error fetching latest form:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch form' });
  }
});

// Get published forms for public display (no auth required)
router.get('/published', async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;

    const query = {
      status: 'published',
      passwordProtected: false,
    };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const forms = await Form.find(query)
      .select(
        '_id name title description status fields settings views submissions createdAt isTournamentForm tournamentSettings' // ADD tournament fields
      )
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    console.log(
      `✅ Found ${forms.length} published forms via /published endpoint`
    );

    res.json({
      success: true,
      data: forms,
      count: forms.length,
    });
  } catch (error) {
    console.error('❌ Error fetching published forms:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch forms',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get single published form by ID (public)
router.get('/published/:id', async (req, res) => {
  try {
    const form = await Form.findOne({
      _id: req.params.id,
      status: 'published',
    }).lean();

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found or not published',
      });
    }

    // If password protected, check password
    if (form.passwordProtected) {
      const formPassword =
        req.query.formPassword || req.cookies[`form_${form._id}_password`];
      if (formPassword !== form.formPassword) {
        return res.status(401).json({
          success: false,
          error: 'Password required',
          requiresPassword: true,
        });
      }
    }

    res.json({
      success: true,
      data: form,
    });
  } catch (error) {
    console.error('Error fetching published form:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch form',
    });
  }
});

module.exports = router;
