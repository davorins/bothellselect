const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      maxlength: 100,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    content: {
      type: String,
      required: true,
    },
    completeContent: {
      type: String,
    },
    status: {
      type: Boolean,
      default: true,
    },
    includeSignature: {
      type: Boolean,
      default: false,
    },
    signatureConfig: {
      organizationName: {
        type: String,
        default: 'Bothell Select',
        trim: true,
      },
      title: {
        type: String,
        trim: true,
        default: '',
      },
      fullName: {
        type: String,
        trim: true,
        default: '',
      },
      phone: {
        type: String,
        trim: true,
        default: '',
      },
      email: {
        type: String,
        trim: true,
        default: '',
      },
      website: {
        type: String,
        trim: true,
        default: 'https://bothellselect.com',
      },
      additionalInfo: {
        type: String,
        trim: true,
        default: '',
      },
    },
    variables: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        description: {
          type: String,
          required: true,
          trim: true,
        },
        defaultValue: {
          type: String,
          trim: true,
        },
      },
    ],
    category: {
      type: String,
      enum: ['system', 'marketing', 'transactional', 'notification', 'other'],
      default: 'system',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: true,
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    version: {
      type: Number,
      default: 1,
    },
    previousVersions: [
      {
        content: String,
        updatedAt: Date,
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Parent',
        },
      },
    ],
    predefinedVariables: {
      type: [String],
      default: [
        'parent.fullName',
        'parent.email',
        'parent.phone',
        'player.fullName',
        'player.grade',
        'player.schoolName',
      ],
    },
    attachments: [
      {
        filename: {
          type: String,
          trim: true,
        },
        url: {
          type: String,
          trim: true,
        },
        size: {
          type: Number,
        },
        mimeType: {
          type: String,
          trim: true,
        },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes
emailTemplateSchema.index({ tags: 1 });
emailTemplateSchema.index({ createdAt: -1 });
emailTemplateSchema.index({ updatedAt: -1 });
emailTemplateSchema.index({ title: 1, status: 1 });
emailTemplateSchema.index({ category: 1, status: 1 });
emailTemplateSchema.index({ includeSignature: 1 });

// Helper function to get R2 public URL from env
const getR2PublicUrl = () => {
  return (
    process.env.R2_PUBLIC_URL ||
    'https://pub-eab2790b2e94418f896b048a8e6658d0.r2.dev'
  );
};

// Helper function to get logo URL
const getLogoUrl = () => {
  const baseUrl = getR2PublicUrl();
  return `${baseUrl}/logo/logo.png`; // Using assets folder for logo, not attachments
};

// Helper function to extract JUST the body content (remove any existing headers/footers)
const extractBodyContent = (html) => {
  if (!html) return '';

  let content = html;

  // Try to extract content from email-body div
  const emailBodyRegex =
    /<td[^>]*class="email-body"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/td>/i;
  const match = content.match(emailBodyRegex);

  if (match && match[1]) {
    // Found email wrapper, extract just the body content
    content = match[1];
  }

  // If still contains full email structure, clean it
  if (
    content.includes('<!DOCTYPE') ||
    content.includes('<html') ||
    content.includes('email-body')
  ) {
    // Remove DOCTYPE and HTML tags
    content = content.replace(/<!DOCTYPE[^>]*>/i, '');
    content = content.replace(/<html[^>]*>/i, '');
    content = content.replace(/<\/html>/i, '');
    content = content.replace(/<head>[\s\S]*?<\/head>/i, '');
    content = content.replace(/<body[^>]*>/i, '');
    content = content.replace(/<\/body>/i, '');

    // Remove email wrapper tables
    content = content.replace(
      /<table[^>]*role="presentation"[^>]*>[\s\S]*?<\/table>/gi,
      '',
    );

    // Remove Bothell Select header
    content = content.replace(
      /<div[^>]*>\s*<img[^>]*alt="Bothell Select Logo"[^>]*>\s*<\/div>/i,
      '',
    );

    // Remove email footer
    const footerRegex =
      /<div[^>]*>You're receiving this email because[^<]*<\/div>[\s\S]*?<\/div>/i;
    content = content.replace(footerRegex, '');

    // Remove unsubscribe links
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

    // Remove copyright footer
    content = content.replace(
      /<p[^>]*>&copy;[^<]*Bothell Select[^<]*<\/p>/i,
      '',
    );

    // Clean up extra whitespace
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
  }

  return content.trim();
};

// Helper function to apply email styles
const addEmailStyles = (html) => {
  if (!html) return '';

  let styledHtml = html;

  // Add basic styles to paragraphs
  styledHtml = styledHtml.replace(
    /<p(\s[^>]*)?>/g,
    '<p style="margin: 0 0 16px; padding: 0; line-height: 1.6; color: #333;"$1>',
  );

  // Style headings
  styledHtml = styledHtml.replace(
    /<h1(\s[^>]*)?>/g,
    '<h1 style="font-size: 28px; font-weight: bold; margin: 0 0 20px; padding: 0; color: #222; line-height: 1.3;"$1>',
  );

  styledHtml = styledHtml.replace(
    /<h2(\s[^>]*)?>/g,
    '<h2 style="font-size: 24px; font-weight: bold; margin: 0 0 18px; padding: 0; color: #222; line-height: 1.3;"$1>',
  );

  styledHtml = styledHtml.replace(
    /<h3(\s[^>]*)?>/g,
    '<h3 style="font-size: 20px; font-weight: 600; margin: 0 0 16px; padding: 0; color: #222; line-height: 1.3;"$1>',
  );

  // Style lists
  styledHtml = styledHtml.replace(
    /<ul(\s[^>]*)?>/g,
    '<ul style="margin: 0 0 16px 20px; padding: 0; color: #333; line-height: 1.6;"$1>',
  );

  styledHtml = styledHtml.replace(
    /<ol(\s[^>]*)?>/g,
    '<ol style="margin: 0 0 16px 20px; padding: 0; color: #333; line-height: 1.6;"$1>',
  );

  styledHtml = styledHtml.replace(
    /<li(\s[^>]*)?>/g,
    '<li style="margin: 0 0 8px; padding: 0;"$1>',
  );

  // Style links
  styledHtml = styledHtml.replace(
    /<a(\s[^>]*)?>/g,
    '<a style="color: #506ee4; text-decoration: none; border-bottom: 1px solid #506ee4; padding-bottom: 1px;"$1>',
  );

  // Style bold and italic
  styledHtml = styledHtml.replace(
    /<strong(\s[^>]*)?>/g,
    '<strong style="font-weight: bold;"$1>',
  );

  styledHtml = styledHtml.replace(
    /<em(\s[^>]*)?>/g,
    '<em style="font-style: italic;"$1>',
  );

  // Style blockquotes
  styledHtml = styledHtml.replace(
    /<blockquote(\s[^>]*)?>/g,
    '<blockquote style="margin: 20px 0; padding: 15px 20px; background-color: #f8f9fa; border-left: 4px solid #506ee4; color: #555; font-style: italic;"$1>',
  );

  return styledHtml;
};

// Get file icon based on MIME type
emailTemplateSchema.methods.getFileIcon = function (mimeType) {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet'))
    return '📊';
  if (mimeType === 'text/plain') return '📃';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
  return '📎';
};

// Format file size
emailTemplateSchema.methods.formatFileSize = function (bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Generate attachments HTML section
emailTemplateSchema.methods.generateAttachmentsHTML = function () {
  if (!this.attachments || this.attachments.length === 0) {
    return '';
  }

  console.log(
    '📎 Generating attachments HTML for',
    this.attachments.length,
    'attachment(s)',
  );

  const attachmentItems = this.attachments
    .map((attachment) => {
      if (!attachment || !attachment.filename) return '';

      const fileSize = this.formatFileSize(attachment.size);
      const fileIcon = this.getFileIcon(attachment.mimeType);
      const fileType = attachment.mimeType || 'File';

      return `
      <div style="margin: 12px 0; padding: 12px; background: #f8f9fa; border-radius: 6px; border-left: 4px solid #506ee4;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="font-size: 24px; line-height: 1;">${fileIcon}</div>
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #333; margin-bottom: 4px;">${attachment.filename}</div>
            <div style="font-size: 12px; color: #666;">
              ${fileSize} • ${fileType}
            </div>
          </div>
        </div>
        ${
          attachment.url
            ? `
          <div style="margin-top: 8px; font-size: 13px;">
            <a href="${attachment.url}" 
               style="color: #506ee4; text-decoration: none; border-bottom: 1px solid #506ee4; padding-bottom: 1px;"
               target="_blank">
              🔗 Direct download link
            </a>
          </div>
        `
            : ''
        }
      </div>
    `;
    })
    .filter((item) => item !== '')
    .join('');

  if (!attachmentItems) return '';

  return `
    <div style="margin-top: 30px; padding-top: 25px; border-top: 2px solid #eaeaea;">
      <h3 style="color: #333; margin-bottom: 20px; font-size: 18px;">
        📎 Attachments (${this.attachments.length})
      </h3>
      <div style="background: #f9fafb; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
        ${attachmentItems}
      </div>
      <div style="font-size: 13px; color: #666; background: #fff9e6; padding: 10px; border-radius: 4px; border-left: 4px solid #ffc107;">
        <p style="margin: 0;">
          <strong>Note:</strong> These files are also attached to this email. 
          If you don't see them as attachments, you can download them using the links above.
        </p>
      </div>
    </div>
  `;
};

// Helper method to generate signature HTML
emailTemplateSchema.methods.generateSignatureHTML = function () {
  if (!this.includeSignature || !this.signatureConfig) {
    return '';
  }

  const {
    organizationName = 'Bothell Select',
    title = '',
    fullName = '',
    phone = '',
    email = '',
    website = 'https://bothellselect.com',
    additionalInfo = '',
  } = this.signatureConfig;

  return `
<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eaeaea;">
  <table cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
    <tr>
      <td style="padding: 0; vertical-align: top;">
        <div style="color: #333; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
          <strong style="color: #222; font-size: 16px; display: block; margin-bottom: 8px;">${organizationName}</strong>
          
          ${fullName ? `<div style="margin-bottom: 4px;"><strong>${fullName}</strong></div>` : ''}
          
          ${title ? `<div style="margin-bottom: 4px; color: #666; font-size: 14px;">${title}</div>` : ''}
          
          <div style="margin-top: 12px; font-size: 14px;">
            ${phone ? `<div style="margin-bottom: 4px;"><span style="color: #666;">Phone:</span> <span style="color: #333;">${phone}</span></div>` : ''}
            ${email ? `<div style="margin-bottom: 4px;"><span style="color: #666;">Email:</span> <a href="mailto:${email}" style="color: #506ee4; text-decoration: none;">${email}</a></div>` : ''}
            ${website ? `<div style="margin-bottom: 4px;"><span style="color: #666;">Website:</span> <a href="${website}" style="color: #506ee4; text-decoration: none;">${website}</a></div>` : ''}
            ${additionalInfo ? `<div style="margin-top: 8px; color: #666; font-size: 13px;">${additionalInfo}</div>` : ''}
          </div>
        </div>
      </td>
    </tr>
  </table>
</div>`;
};

// Method to generate complete email HTML (same as frontend)
emailTemplateSchema.methods.getCompleteEmailHTML = function () {
  // Extract JUST the body content from whatever is stored
  const bodyContent = extractBodyContent(this.content);

  let styledContent = addEmailStyles(bodyContent);

  // ✅ ADD ATTACHMENTS
  if (this.attachments && this.attachments.length > 0) {
    styledContent += this.generateAttachmentsHTML();
  }

  // Add signature if enabled
  if (this.includeSignature) {
    styledContent += this.generateSignatureHTML();
  }

  // Generate the complete email HTML with header and footer
  // ONLY if the original content doesn't already have them
  if (
    this.content.includes('<!DOCTYPE') ||
    this.content.includes('email-body') ||
    this.content.includes('Bothell Select Logo')
  ) {
    // Content already has headers/footers, return it as-is
    return this.content;
  }

  const logoUrl = getLogoUrl();
  const baseUrl = getR2PublicUrl();

  // Otherwise, wrap with headers/footers
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.subject}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        padding: 10px !important;
      }
      .email-body {
        padding: 30px 40px 0 40px !important;
      }
      .header-img {
        height: 30px !important;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333333;
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
  </style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333333; margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="background-color: #f6f6f6; padding: 40px 0;">
    <tr>
      <td align="center" style="padding: 0;">
        <div class="container" style="max-width: 600px; margin: 0 auto;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden;">
            <tr>
              <td style="padding: 30px 30px 0;">
                <div style="text-align: left; border-bottom: 1px solid #eaeaea; padding-bottom: 20px;">
                  <img src="${logoUrl}" alt="Bothell Select Logo" height="30" style="display: block; margin: 0; height: 30px;" 
                       onerror="this.onerror=null; this.src='${baseUrl}/logo/logo.png';" />
                </div>
              </td>
            </tr>
            <tr>
              <td class="email-body" style="padding: 30px;">
                <div style="max-width: 100%;">
                  ${styledContent}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 30px;">
                <div style="text-align: center; font-size: 13px; color: #666; padding: 30px 0 20px; margin-top: 40px; border-top: 1px solid #eaeaea;">
                  <p style="margin: 0 0 8px;"> you're part of <strong style="color: #333;">Bothell Select</strong>.</p>
                  <p style="margin: 0;">
                    <a href="https://bothellselect.com/unsubscribe" style="color: #506ee4; text-decoration: none; border-bottom: 1px solid #506ee4; padding-bottom: 1px;">Unsubscribe</a> • 
                    <a href="https://bothellselect.com/contact" style="color: #506ee4; text-decoration: none; border-bottom: 1px solid #506ee4; padding-bottom: 1px;">Contact Us</a> • 
                    <a href="https://bothellselect.com" style="color: #506ee4; text-decoration: none; border-bottom: 1px solid #506ee4; padding-bottom: 1px;">Website</a>
                  </p>
                </div>
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top: 20px;">
            <tr>
              <td align="center" style="padding: 20px 0;">
                <p style="margin: 0; font-size: 12px; color: #999;">&copy; ${new Date().getFullYear()} Bothell Select. All rights reserved.</p>
              </td>
            </tr>
          </table>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// Versioning middleware - also generate completeContent
emailTemplateSchema.pre('save', function (next) {
  // Generate completeContent whenever content or signature changes
  if (
    this.isModified('content') ||
    this.isModified('includeSignature') ||
    this.isModified('signatureConfig') ||
    this.isModified('attachments')
  ) {
    this.completeContent = this.getCompleteEmailHTML();

    if (!this.isNew) {
      if (!this.previousVersions) {
        this.previousVersions = [];
      }
      this.previousVersions.push({
        content: this.content,
        updatedAt: new Date(),
        updatedBy: this.lastUpdatedBy,
      });
      this.version += 1;
    }
  }
  next();
});

const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

module.exports = EmailTemplate;
