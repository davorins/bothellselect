const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const EmailTemplate = require('../models/EmailTemplate');
const { authenticate } = require('../utils/auth');
const { upload } = require('../utils/fileUpload');
const { uploadToR2, deleteFromR2, isR2Url } = require('../utils/r2');
const crypto = require('crypto');

// 🔐 Middleware for admin-only routes
const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  next();
};

/**
 * Upload attachment to R2
 */
const uploadAttachmentToR2 = async (fileBuffer, filename, mimetype) => {
  try {
    const fileExtension = filename.split('.').pop();
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const key = `attachments/${uniqueId}-${Date.now()}.${fileExtension}`;

    const { url } = await uploadToR2(fileBuffer, 'attachments', filename);

    return {
      filename,
      url,
      size: fileBuffer.length,
      mimeType: mimetype,
      uploadedAt: new Date(),
    };
  } catch (error) {
    console.error('❌ Failed to upload attachment to R2:', error);
    throw error;
  }
};

// ─── SANITIZE: Remove base64 images from elements ───
const sanitizeElements = (elements) => {
  if (!elements || !Array.isArray(elements)) return elements;

  return elements.map((el) => {
    // Deep clone to avoid mutation
    const sanitized = { ...el };

    // Handle image elements
    if (
      sanitized.type === 'image' &&
      sanitized.src &&
      typeof sanitized.src === 'string' &&
      sanitized.src.startsWith('data:image')
    ) {
      sanitized.src = '';
    }

    // Handle features elements with images
    if (sanitized.type === 'features' && sanitized.features) {
      sanitized.features = sanitized.features.map((f) => ({
        ...f,
        image:
          f.image &&
          typeof f.image === 'string' &&
          f.image.startsWith('data:image')
            ? ''
            : f.image,
      }));
    }

    // Handle list elements with images
    if (sanitized.type === 'list' && sanitized.items) {
      sanitized.items = sanitized.items.map((item) => ({
        ...item,
        image:
          item.image &&
          typeof item.image === 'string' &&
          item.image.startsWith('data:image')
            ? ''
            : item.image,
      }));
    }

    // Handle nested columns
    if (sanitized.columns) {
      sanitized.columns = sanitizeElements(sanitized.columns);
    }

    return sanitized;
  });
};

// ─── Upload temp image ──────────────────────────────────────────────────

router.post(
  '/upload-temp-image',
  authenticate,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: 'No image uploaded' });
      }

      // Validate file type
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
      ];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WEBP, SVG',
        });
      }

      // Validate file size (5MB max)
      if (req.file.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: 'File too large. Maximum size is 5MB',
        });
      }

      const attachment = await uploadAttachmentToR2(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      res.json({
        success: true,
        data: {
          url: attachment.url,
          filename: attachment.filename,
        },
      });
    } catch (error) {
      console.error('❌ Temp upload error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ✅ Create a new email template
router.post(
  '/',
  authenticate,
  authorizeAdmin,
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('content').notEmpty().withMessage('Content is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Sanitize builderConfig to remove any base64 images
      if (req.body.builderConfig && req.body.builderConfig.elements) {
        req.body.builderConfig.elements = sanitizeElements(
          req.body.builderConfig.elements,
        );
      }

      const templateData = {
        ...req.body,
        createdBy: req.user.id,
        lastUpdatedBy: req.user.id,
        attachments: req.body.attachments || [],
      };

      if (templateData.completeContent) {
        delete templateData.completeContent;
      }

      const template = new EmailTemplate(templateData);
      await template.save();

      res.status(201).json({ success: true, data: template });
    } catch (error) {
      console.error('❌ Create template error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ✅ Get all templates
router.get('/', authenticate, async (req, res) => {
  try {
    const templates = await EmailTemplate.find({});
    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Get template by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    if (!template.completeContent) {
      template.completeContent = template.getCompleteEmailHTML();
      await template.save();
    }

    res.json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Update template
router.put(
  '/:id',
  authenticate,
  authorizeAdmin,
  [
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Title cannot be empty'),
    body('subject')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Subject cannot be empty'),
    body('content')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Content cannot be empty'),
    body('status')
      .optional()
      .isBoolean()
      .withMessage('Status must be a boolean'),
    body('variables')
      .optional()
      .isArray()
      .withMessage('Variables must be an array'),
    body('category')
      .optional()
      .isIn(['system', 'marketing', 'transactional', 'notification', 'other'])
      .withMessage('Invalid category'),
    body('tags').optional().isArray().withMessage('Tags must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array(),
      });
    }

    try {
      const template = await EmailTemplate.findById(req.params.id);
      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      // ─── SANITIZE: Remove base64 images before processing ───
      if (req.body.builderConfig && req.body.builderConfig.elements) {
        req.body.builderConfig.elements = sanitizeElements(
          req.body.builderConfig.elements,
        );
      }

      req.body.lastUpdatedBy = req.user.id;

      if (req.body.attachments !== undefined) {
        template.attachments = req.body.attachments;
      }

      if (req.body.completeContent) {
        delete req.body.completeContent;
      }

      const updates = Object.keys(req.body);
      updates.forEach((update) => {
        template[update] = req.body[update];
      });

      await template.save();

      if (!template.completeContent) {
        template.completeContent = template.getCompleteEmailHTML();
        await template.save();
      }

      res.json({
        success: true,
        data: template,
      });
    } catch (error) {
      console.error('❌ Update template error:', error);
      res.status(400).json({
        success: false,
        error: error.message,
        ...(error.errors && {
          validationErrors: Object.keys(error.errors),
        }),
      });
    }
  },
);

// ✅ Delete template
router.delete('/:id', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    if (template.attachments && template.attachments.length > 0) {
      console.log(
        `🗑️ Deleting ${template.attachments.length} attachments from R2`,
      );

      for (const attachment of template.attachments) {
        if (attachment.url && isR2Url(attachment.url)) {
          try {
            await deleteFromR2(attachment.url);
            console.log(`✅ Deleted attachment: ${attachment.filename}`);
          } catch (deleteError) {
            console.error(
              `❌ Failed to delete attachment ${attachment.filename}:`,
              deleteError,
            );
          }
        }
      }
    }

    await EmailTemplate.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Template and attachments deleted successfully',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Generate complete HTML for a template (for testing)
router.get('/:id/generate-html', authenticate, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    const completeHTML = template.getCompleteEmailHTML();

    res.json({
      success: true,
      data: {
        html: completeHTML,
        hasCompleteContent: !!template.completeContent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Upload attachment for email template
router.post(
  '/:id/upload-attachment',
  authenticate,
  upload.single('attachment'),
  async (req, res) => {
    try {
      const template = await EmailTemplate.findById(req.params.id);

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
      }

      console.log('📁 Uploading attachment to R2:', {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });

      const attachment = await uploadAttachmentToR2(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      template.attachments.push(attachment);
      await template.save();

      template.completeContent = template.getCompleteEmailHTML();
      await template.save();

      res.json({
        success: true,
        data: {
          attachment,
          templateId: template._id,
        },
      });
    } catch (error) {
      console.error('❌ Upload error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ✅ Upload multiple attachments for email template
router.post(
  '/:id/upload-attachments',
  authenticate,
  upload.array('attachments', 10),
  async (req, res) => {
    try {
      const template = await EmailTemplate.findById(req.params.id);

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No files uploaded',
        });
      }

      console.log(`📁 Uploading ${req.files.length} attachments to R2`);

      const uploadedAttachments = [];

      for (const file of req.files) {
        try {
          const attachment = await uploadAttachmentToR2(
            file.buffer,
            file.originalname,
            file.mimetype,
          );

          template.attachments.push(attachment);
          uploadedAttachments.push(attachment);

          console.log(`✅ Uploaded: ${file.originalname} (${file.size} bytes)`);
        } catch (uploadError) {
          console.error(
            `❌ Failed to upload ${file.originalname}:`,
            uploadError,
          );
        }
      }

      await template.save();

      template.completeContent = template.getCompleteEmailHTML();
      await template.save();

      res.json({
        success: true,
        data: {
          attachments: uploadedAttachments,
          templateId: template._id,
          uploadedCount: uploadedAttachments.length,
          totalCount: req.files.length,
        },
      });
    } catch (error) {
      console.error('❌ Batch upload error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ✅ Remove attachment from email template
router.delete(
  '/:id/attachments/:attachmentId',
  authenticate,
  async (req, res) => {
    try {
      const template = await EmailTemplate.findById(req.params.id);

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      const attachmentIndex = template.attachments.findIndex(
        (att) => att._id.toString() === req.params.attachmentId,
      );

      if (attachmentIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Attachment not found',
        });
      }

      const attachment = template.attachments[attachmentIndex];

      if (attachment.url && isR2Url(attachment.url)) {
        try {
          await deleteFromR2(attachment.url);
          console.log(`✅ Deleted attachment from R2: ${attachment.filename}`);
        } catch (deleteError) {
          console.error(`❌ Failed to delete from R2:`, deleteError);
        }
      }

      template.attachments.splice(attachmentIndex, 1);
      await template.save();

      template.completeContent = template.getCompleteEmailHTML();
      await template.save();

      res.json({
        success: true,
        data: {
          removed: true,
          attachmentId: req.params.attachmentId,
          filename: attachment.filename,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ✅ Get all attachments for a template
router.get('/:id/attachments', authenticate, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Template not found',
      });
    }

    res.json({
      success: true,
      data: template.attachments || [],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Download attachment directly
router.get(
  '/:id/attachments/:attachmentId/download',
  authenticate,
  async (req, res) => {
    try {
      const template = await EmailTemplate.findById(req.params.id);

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      const attachment = template.attachments.id(req.params.attachmentId);

      if (!attachment) {
        return res.status(404).json({
          success: false,
          error: 'Attachment not found',
        });
      }

      res.redirect(attachment.url);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

module.exports = router;
