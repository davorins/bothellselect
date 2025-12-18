// formPublic.js
const express = require('express');
const router = express.Router();
const Form = require('../models/Form');
const FormSubmission = require('../models/FormSubmission');
const { submitPayment } = require('../services/square-payments');
const TicketPurchase = require('../models/TicketPurchase');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  sendFormPaymentReceiptEmail,
  sendFormOwnerNotificationEmail,
} = require('../utils/email');

// Simple UUID v4 generator (replaces the uuid package)
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Configure multer for form file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const formId = req.params.id || req.body.formId;
    const uploadDir = `uploads/forms/${formId}/`;
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
      cb(new Error('File type not allowed'));
    }
  },
});

// Helper function to extract field value from request
function extractFieldValue(req, field, isFile = false) {
  // Try different possible keys in order of priority
  const possibleKeys = [
    field.id,
    field.name,
    field.label,
    field.id.toLowerCase(),
    field.name ? field.name.toLowerCase() : '',
    field.label ? field.label.toLowerCase() : '',
  ].filter((key) => key && key.trim());

  for (const key of possibleKeys) {
    if (isFile && req.files) {
      const file = req.files.find((f) => f.fieldname === key);
      if (file) return file;
    } else if (req.body[key] !== undefined) {
      return req.body[key];
    }
  }

  return isFile ? null : '';
}

// Helper function to extract email and name from form data
function extractEmailAndName(form, submissionData, req) {
  let email = '';
  let name = '';

  // Look for email field
  const emailField = form.fields.find((f) => f.type === 'email');
  if (emailField) {
    email =
      submissionData[emailField.id] ||
      submissionData[emailField.name] ||
      req.body.email ||
      req.body.userEmail ||
      req.user?.email ||
      '';
  } else {
    // Fallback: look for any value that looks like an email
    Object.values(submissionData).forEach((value) => {
      if (
        typeof value === 'string' &&
        value.includes('@') &&
        value.includes('.') &&
        !email
      ) {
        email = value;
      }
    });
  }

  // Look for name field
  const nameField = form.fields.find(
    (f) =>
      f.type === 'text' &&
      (f.label?.toLowerCase().includes('name') ||
        f.name?.toLowerCase().includes('name'))
  );

  if (nameField) {
    name =
      submissionData[nameField.id] ||
      submissionData[nameField.name] ||
      req.body.name ||
      req.body.userName ||
      req.user?.name ||
      '';
  } else {
    // Fallback: look for any field with 'name' in key
    Object.keys(submissionData).forEach((key) => {
      if (key.toLowerCase().includes('name') && !name) {
        name = submissionData[key];
      }
    });
  }

  return { email, name };
}

// Get form for embedding (public endpoint)
router.get('/embed/:id', async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    // Check if form is published
    if (form.status !== 'published') {
      return res
        .status(404)
        .json({ success: false, error: 'Form not available' });
    }

    // Check password protection
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

    // Check access roles
    if (form.allowedRoles && form.allowedRoles.length > 0) {
      const userRole = req.user?.role || 'guest';
      if (!form.allowedRoles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
        });
      }
    }

    // Return HTML for iframe
    res.set('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${form.title}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
          .form-container { max-width: 800px; margin: 0 auto; }
          .form-header { margin-bottom: 20px; }
          .form-title { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
          .form-description { color: #666; margin-bottom: 20px; }
          .form-field { margin-bottom: 20px; }
          .form-label { display: block; margin-bottom: 5px; font-weight: 500; }
          .form-label .required { color: #dc3545; }
          .form-input, .form-select, .form-textarea { 
            width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; 
            font-size: 14px; 
          }
          .form-textarea { min-height: 100px; resize: vertical; }
          .form-checkbox, .form-radio { margin-right: 10px; }
          .form-option { margin-bottom: 5px; display: flex; align-items: center; }
          .form-help { font-size: 12px; color: #666; margin-top: 5px; }
          .form-error { color: #dc3545; font-size: 12px; margin-top: 5px; }
          .form-section { border-bottom: 2px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
          .form-section-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; }
          .form-payment { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
          .form-payment-amount { font-size: 18px; font-weight: bold; color: #28a745; }
          .form-actions { margin-top: 30px; }
          .form-submit { 
            background-color: ${form.settings.submitButtonStyle.backgroundColor}; 
            color: ${form.settings.submitButtonStyle.textColor};
            border: none; padding: 12px 24px; border-radius: 4px; 
            font-size: 16px; cursor: pointer; width: 100%;
          }
          .form-submit:hover { opacity: 0.9; }
          .form-submit:disabled { opacity: 0.6; cursor: not-allowed; }
          .form-message { padding: 10px; border-radius: 4px; margin-bottom: 20px; }
          .form-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
          .form-error-message { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
          .file-upload { border: 2px dashed #ddd; padding: 20px; text-align: center; border-radius: 4px; }
          .file-upload input { display: none; }
          .file-upload label { cursor: pointer; color: #007bff; }
          .file-preview { margin-top: 10px; }
          .file-item { display: flex; align-items: center; margin-bottom: 5px; }
          .file-name { margin-left: 10px; }
          .remove-file { color: #dc3545; margin-left: 10px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="form-container" id="form-container">
          <div class="form-header">
            <h1 class="form-title">${form.title}</h1>
            ${form.description ? `<p class="form-description">${form.description}</p>` : ''}
          </div>
          
          <form id="dynamic-form" data-form-id="${form._id}">
            ${generateFormFieldsHTML(form.fields)}
            
            <div class="form-actions">
              <button type="submit" class="form-submit">
                ${form.settings.submitText}
              </button>
            </div>
          </form>
          
          <div id="form-message" class="form-message" style="display: none;"></div>
        </div>
        
        <script>
          // Form handling JavaScript
          const formId = "${form._id}";
          let uploadedFiles = {};
          
          // Square Payment Functions
          function initializeSquarePayment(fieldId, appId, locationId, amount, currency) {
            console.log('Initializing Square payment for field:', fieldId);
            
            // Load the correct SDK
            const paymentsSdkUrl = window.location.hostname === 'localhost' || 
                                  window.location.hostname.includes('sandbox') ||
                                  window.location.hostname.includes('127.0.0.1')
              ? 'https://sandbox.web.squarecdn.com/v1/square.js'
              : 'https://web.squarecdn.com/v1/square.js';

            // Check if SDK is already loaded
            const existingScript = document.querySelector('script[src*="squarecdn.com"]');
            if (existingScript) {
              // SDK already loaded, initialize now
              initSquareApp(fieldId, appId, locationId, amount, currency);
              return;
            }

            // Load SDK script
            const script = document.createElement('script');
            script.src = paymentsSdkUrl;
            script.type = 'text/javascript';
            script.onload = () => initSquareApp(fieldId, appId, locationId, amount, currency);
            script.onerror = () => {
              console.error('Failed to load Square SDK');
              document.getElementById(\`sq-card-errors-\${fieldId}\`).textContent = 
                'Payment system failed to load. Please refresh the page.';
            };
            
            document.head.appendChild(script);
          }

          function initSquareApp(fieldId, appId, locationId, amount, currency) {
            if (!window.Square) {
              console.error('Square SDK not available');
              document.getElementById(\`sq-card-errors-\${fieldId}\`).textContent = 
                'Payment system unavailable. Please try again later.';
              return;
            }

            try {
              const payments = window.Square.payments(appId, locationId);
              const card = payments.card({
                postalCode: 'optional'
              });

              card.attach(\`#sq-card-container-\${fieldId}\`).then(() => {
                console.log(\`Square card payment form attached for field \${fieldId}\`);
              }).catch(err => {
                console.error('Failed to attach Square card form:', err);
                document.getElementById(\`sq-card-errors-\${fieldId}\`).textContent = 
                  'Payment form failed to load. Please refresh.';
              });

              // Store card instance for later tokenization
              window.squareCardInstance = window.squareCardInstance || {};
              window.squareCardInstance[fieldId] = card;
              
            } catch (error) {
              console.error('Error initializing Square:', error);
              document.getElementById(\`sq-card-errors-\${fieldId}\`).textContent = 
                'Payment system error. Please contact support.';
            }
          }

          async function tokenizeSquarePayment(fieldId) {
            if (!window.squareCardInstance || !window.squareCardInstance[fieldId]) {
              throw new Error('Payment form not initialized');
            }

            const card = window.squareCardInstance[fieldId];
            const tokenResult = await card.tokenize();
            
            if (tokenResult.status === 'OK') {
              return tokenResult.token;
            } else {
              const errorMsg = tokenResult.errors ? 
                tokenResult.errors.map(e => e.detail).join(', ') : 
                'Payment tokenization failed';
              throw new Error(errorMsg);
            }
          }
          
          // File upload handlers
          document.querySelectorAll('input[type="file"]').forEach(input => {
            input.addEventListener('change', function(e) {
              const fieldId = this.id;
              const previewDiv = document.getElementById(\`preview-\${fieldId}\`);
              const errorDiv = document.getElementById(\`error-\${fieldId}\`);
              const maxSize = parseInt(this.dataset.maxSize) || 10485760;
              
              previewDiv.innerHTML = '';
              errorDiv.textContent = '';
              
              if (!uploadedFiles[fieldId]) {
                uploadedFiles[fieldId] = [];
              }
              
              Array.from(e.target.files).forEach(file => {
                // Check file size
                if (file.size > maxSize) {
                  errorDiv.textContent = \`File "\${file.name}" exceeds maximum size of \${Math.round(maxSize / 1024 / 1024)}MB\`;
                  return;
                }
                
                uploadedFiles[fieldId].push(file);
                
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                fileItem.innerHTML = \`
                  <span>📄</span>
                  <span class="file-name">\${file.name} (\${Math.round(file.size / 1024)}KB)</span>
                  <span class="remove-file" onclick="removeFile('\${fieldId}', '\${file.name}')">✕</span>
                \`;
                previewDiv.appendChild(fileItem);
              });
            });
          });
          
          function removeFile(fieldId, fileName) {
            if (uploadedFiles[fieldId]) {
              uploadedFiles[fieldId] = uploadedFiles[fieldId].filter(file => file.name !== fileName);
              const previewDiv = document.getElementById(\`preview-\${fieldId}\`);
              previewDiv.innerHTML = '';
              
              uploadedFiles[fieldId].forEach(file => {
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                fileItem.innerHTML = \`
                  <span>📄</span>
                  <span class="file-name">\${file.name} (\${Math.round(file.size / 1024)}KB)</span>
                  <span class="remove-file" onclick="removeFile('\${fieldId}', '\${file.name}')">✕</span>
                \`;
                previewDiv.appendChild(fileItem);
              });
            }
          }
          
          // Conditional logic
          function updateFieldVisibility(fieldId, condition) {
            const field = document.querySelector(\`[data-field-id="\${fieldId}"]\`);
            if (field) {
              field.style.display = condition ? 'block' : 'none';
              const inputs = field.querySelectorAll('input, select, textarea');
              inputs.forEach(input => {
                if (!condition) {
                  input.disabled = true;
                  input.required = false;
                } else {
                  input.disabled = false;
                  input.required = input.hasAttribute('data-required');
                }
              });
            }
          }
          
          function checkConditionalLogic(fieldId, dependsOnId) {
            const field = document.querySelector(\`[data-field-id="\${fieldId}"]\`);
            if (!field) return;
            
            const dependsOnField = document.getElementById(dependsOnId);
            if (!dependsOnField) return;
            
            const condition = field.getAttribute('data-condition');
            const expectedValue = field.getAttribute('data-value');
            const shouldShow = field.getAttribute('data-show') === 'true';
            
            let currentValue;
            if (dependsOnField.type === 'checkbox') {
              currentValue = dependsOnField.checked;
            } else if (dependsOnField.type === 'radio' && dependsOnField.name) {
              const selectedRadio = document.querySelector(\`input[name="\${dependsOnField.name}"]:checked\`);
              currentValue = selectedRadio ? selectedRadio.value : '';
            } else {
              currentValue = dependsOnField.value;
            }
            
            let conditionMet = false;
            
            switch (condition) {
              case 'equals':
                conditionMet = currentValue == expectedValue;
                break;
              case 'notEquals':
                conditionMet = currentValue != expectedValue;
                break;
              case 'contains':
                conditionMet = String(currentValue).includes(String(expectedValue));
                break;
              case 'greaterThan':
                conditionMet = parseFloat(currentValue) > parseFloat(expectedValue);
                break;
              case 'lessThan':
                conditionMet = parseFloat(currentValue) < parseFloat(expectedValue);
                break;
            }
            
            const shouldDisplay = shouldShow ? conditionMet : !conditionMet;
            updateFieldVisibility(fieldId, shouldDisplay);
          }
          
          // Form submission handler
          document.getElementById('dynamic-form').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const submitBtn = this.querySelector('.form-submit');
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Processing...';
            submitBtn.disabled = true;
            
            const messageDiv = document.getElementById('form-message');
            messageDiv.style.display = 'none';
            
            try {
              // 1. Collect all form data including email and name for validation
              const formData = new FormData(this);
              const allFormData = {};
              
              // Convert FormData to object
              for (let [key, value] of formData.entries()) {
                allFormData[key] = value;
              }
              
              // 2. Extract email and name for validation
              let userEmail = '';
              let userName = '';
              
              // Look for email field
              const emailInput = document.querySelector('input[type="email"]');
              if (emailInput) {
                userEmail = emailInput.value;
                allFormData['email'] = userEmail;
                allFormData['userEmail'] = userEmail;
              }
              
              // Look for name field
              const textInputs = document.querySelectorAll('input[type="text"]');
              textInputs.forEach(input => {
                const label = document.querySelector(\`label[for="\${input.id}"]\`);
                if (label && label.textContent.toLowerCase().includes('name')) {
                  userName = input.value;
                  allFormData['name'] = userName;
                  allFormData['userName'] = userName;
                }
              });
              
              // 3. Validate required fields on client side first
              const requiredFields = document.querySelectorAll('[required]');
              const errors = [];
              
              requiredFields.forEach(field => {
                if (!field.value.trim() && field.type !== 'file') {
                  const label = document.querySelector(\`label[for="\${field.id}"]\`);
                  errors.push(label ? label.textContent.trim() + ' is required' : 'Required field is missing');
                }
              });
              
              if (errors.length > 0) {
                throw new Error(errors.join(', '));
              }
              
              // 4. Process Square payments if any
              const paymentFields = ${JSON.stringify(form.fields.filter((f) => f.type === 'payment'))};
              let paymentToken = null;
              let paymentFieldId = null;
              
              if (paymentFields.length > 0 && window.squareCardInstance) {
                for (const field of paymentFields) {
                  if (window.squareCardInstance[field.id]) {
                    try {
                      const token = await tokenizeSquarePayment(field.id);
                      paymentToken = token;
                      paymentFieldId = field.id;
                      allFormData['paymentToken'] = token;
                      break;
                    } catch (paymentError) {
                      console.error('Payment error:', paymentError);
                      throw new Error(\`Payment failed: \${paymentError.message}\`);
                    }
                  }
                }
              }
              
              // 5. Add files to formData
              Object.keys(uploadedFiles).forEach(fieldId => {
                uploadedFiles[fieldId].forEach(file => {
                  formData.append(fieldId, file);
                });
              });
              
              // 6. Add metadata
              formData.append('formId', formId);
              formData.append('pageUrl', window.location.href);
              formData.append('referrer', document.referrer);
              formData.append('userEmail', userEmail);
              formData.append('userName', userName);
              
              // 7. Submit to server
              const response = await fetch('/forms/submit/${form._id}', {
                method: 'POST',
                body: formData
              });
              
              const result = await response.json();
              
              if (result.success) {
                messageDiv.className = 'form-message form-success';
                messageDiv.textContent = '${form.settings.successMessage}';
                messageDiv.style.display = 'block';
                
                // Reset form
                this.reset();
                uploadedFiles = {};
                
                // Clear Square instances
                if (window.squareCardInstance) {
                  Object.keys(window.squareCardInstance).forEach(key => {
                    window.squareCardInstance[key] = null;
                  });
                }
                
                // Redirect if configured
                ${
                  form.settings.redirectUrl
                    ? `
                  setTimeout(() => {
                    window.location.href = '${form.settings.redirectUrl}';
                  }, 2000);
                `
                    : ''
                }
              } else {
                throw new Error(result.error || 'Submission failed');
              }
            } catch (error) {
              console.error('Form submission error:', error);
              messageDiv.className = 'form-message form-error-message';
              messageDiv.textContent = error.message || 'An error occurred. Please try again.';
              messageDiv.style.display = 'block';
            } finally {
              submitBtn.textContent = originalText;
              submitBtn.disabled = false;
            }
          });
          
          // Initialize Square payment fields
          document.addEventListener('DOMContentLoaded', function() {
            const paymentFields = ${JSON.stringify(form.fields.filter((f) => f.type === 'payment'))};
            
            if (paymentFields.length > 0) {
              // Square credentials (should come from server-side)
              const SQUARE_APP_ID = '${process.env.SQUARE_APPLICATION_ID || 'sq0idp-jUCxKnO_i8i7vccQjVj_0g'}';
              const SQUARE_LOCATION_ID = '${process.env.SQUARE_LOCATION_ID || 'L26Q50FWRCQW5'}';
              
              paymentFields.forEach(field => {
                initializeSquarePayment(
                  field.id, 
                  SQUARE_APP_ID, 
                  SQUARE_LOCATION_ID,
                  field.paymentConfig.amount,
                  field.paymentConfig.currency || 'USD'
                );
              });
            }
            
            // Initialize all conditional fields
            const conditionalFields = document.querySelectorAll('[data-depends-on]');
            conditionalFields.forEach(field => {
              const fieldId = field.getAttribute('data-field-id');
              const dependsOnId = field.getAttribute('data-depends-on');
              checkConditionalLogic(fieldId, dependsOnId);
            });
          });
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error serving form embed:', error);
    res.status(500).send('<p>Error loading form. Please try again later.</p>');
  }
});

// Submit form (public endpoint)
router.post('/:id/submit', upload.any(), async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);

    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }

    if (form.status !== 'published') {
      return res
        .status(400)
        .json({ success: false, error: 'Form is not published' });
    }

    // Check password protection
    if (form.passwordProtected) {
      const formPassword =
        req.body.formPassword || req.cookies[`form_${form._id}_password`];
      if (formPassword !== form.formPassword) {
        return res.status(401).json({
          success: false,
          error: 'Invalid form password',
        });
      }
    }

    // Validate required fields
    const errors = [];
    const submissionData = {};

    // Collect all form data
    form.fields.forEach((field) => {
      const value = extractFieldValue(req, field);
      submissionData[field.id] = value;
      submissionData[field.name || field.id] = value;

      // Store email and name in special fields for validation
      if (field.type === 'email') {
        submissionData['email'] = value;
        submissionData['userEmail'] = value;
      }

      if (
        field.type === 'text' &&
        (field.label?.toLowerCase().includes('name') ||
          field.name?.toLowerCase().includes('name'))
      ) {
        submissionData['name'] = value;
        submissionData['userName'] = value;
      }

      // Validate required fields (skip payment fields)
      if (
        field.type !== 'payment' &&
        field.required &&
        (!value || (typeof value === 'string' && value.trim() === ''))
      ) {
        errors.push(`${field.label} is required`);
      }

      // Validate email format
      if (field.type === 'email' && value && value.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          errors.push(`${field.label} must be a valid email address`);
        }
      }

      // Validate number ranges
      if (field.type === 'number' && value) {
        const numValue = parseFloat(value);
        if (
          field.validation?.min !== undefined &&
          numValue < field.validation.min
        ) {
          errors.push(
            `${field.label} must be at least ${field.validation.min}`
          );
        }
        if (
          field.validation?.max !== undefined &&
          numValue > field.validation.max
        ) {
          errors.push(`${field.label} must be at most ${field.validation.max}`);
        }
      }
    });

    // Also check direct body fields for email and name
    if (!submissionData['email'] && req.body.email) {
      submissionData['email'] = req.body.email;
      submissionData['userEmail'] = req.body.email;
    }

    if (!submissionData['name'] && req.body.name) {
      submissionData['name'] = req.body.name;
      submissionData['userName'] = req.body.name;
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors,
        error: 'Validation failed',
      });
    }

    // Handle file uploads
    const files = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        const fieldId = file.fieldname;
        const field = form.fields.find(
          (f) => f.id === fieldId || f.name === fieldId
        );

        if (field && field.type === 'file') {
          // Validate file size
          if (
            field.fileConfig?.maxSize &&
            file.size > field.fileConfig.maxSize
          ) {
            throw new Error(
              `File ${file.originalname} exceeds maximum size of ${field.fileConfig.maxSize} bytes`
            );
          }

          files.push({
            fieldId,
            originalName: file.originalname,
            fileName: file.filename,
            path: file.path,
            size: file.size,
            mimeType: file.mimetype,
          });
        }
      });
    }

    // Extract email and name for submission
    const { email, name } = extractEmailAndName(form, submissionData, req);

    // Check for payment fields
    const paymentField = form.fields.find((f) => f.type === 'payment');
    const hasPaymentFields = !!paymentField;

    // Calculate initial status
    let submissionStatus = 'submitted';
    let requiresPayment = false;

    if (hasPaymentFields) {
      // Check if payment is being processed now or later
      if (req.body.paymentToken) {
        // Payment is being processed now (single-step flow)
        submissionStatus = 'completed';
        requiresPayment = true;
      } else {
        // Payment will be processed later (two-step flow)
        submissionStatus = 'pending';
        requiresPayment = true;
      }
    }

    // Create form submission
    const submission = new FormSubmission({
      formId: form._id,
      formVersion: form.version,
      data: {
        ...submissionData,
        // Don't add package info here for two-step flow
      },
      files,
      submittedBy: req.user?._id,
      userEmail: email || req.body.email || req.user?.email,
      userName: name || req.body.name || req.user?.name,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      referrer: req.body.referrer,
      pageUrl: req.body.pageUrl,
      status: submissionStatus,
    });

    // Process payment immediately if token is provided (single-step flow)
    if (hasPaymentFields && req.body.paymentToken) {
      // Validate payment info for immediate processing
      const paymentErrors = [];
      let totalAmount = 0;
      let selectedPackage = null;
      let quantity = 1;

      if (paymentField.paymentConfig?.pricingPackages?.length > 0) {
        // Handle pricing packages with quantity
        const packageName = req.body[`${paymentField.id}_package`];
        quantity = parseInt(req.body[`${paymentField.id}_quantity`]) || 1;

        selectedPackage = paymentField.paymentConfig.pricingPackages.find(
          (pkg) => pkg.name === packageName && pkg.isEnabled
        );

        if (selectedPackage) {
          if (
            selectedPackage.maxQuantity &&
            quantity > selectedPackage.maxQuantity
          ) {
            paymentErrors.push(
              `Maximum quantity for ${selectedPackage.name} is ${selectedPackage.maxQuantity}`
            );
          }
          totalAmount = selectedPackage.price * quantity;
        } else {
          paymentErrors.push('Please select a valid pricing package');
        }
      } else {
        // Fixed price (backward compatibility)
        totalAmount = paymentField.paymentConfig.amount;
      }

      if (paymentErrors.length > 0) {
        return res.status(400).json({
          success: false,
          errors: paymentErrors,
          error: 'Payment validation failed',
        });
      }

      // Add package info to submission data
      submission.data.selectedPackage = selectedPackage?.name;
      submission.data.quantity = quantity;
      submission.data.unitPrice = selectedPackage
        ? selectedPackage.price
        : paymentField?.paymentConfig?.amount;
      submission.data.totalAmount = totalAmount;

      // Process payment
      try {
        console.log('Processing immediate payment for form submission:', {
          formId: form._id,
          amount: totalAmount,
          package: selectedPackage?.name || 'fixed',
          quantity: quantity,
        });

        const paymentResult = await submitPayment(
          req.body.paymentToken,
          totalAmount,
          {
            parentId: req.user?._id || new mongoose.Types.ObjectId(),
            buyerEmailAddress:
              email || req.body.email || 'no-email@example.com',
            description:
              selectedPackage?.description ||
              paymentField.paymentConfig.description ||
              `Payment for ${form.title}`,
            currency: paymentField.paymentConfig?.currency || 'USD',
            metadata: {
              formId: form._id.toString(),
              formTitle: form.title,
              fieldId: paymentField.id,
              packageName: selectedPackage?.name,
              quantity: quantity,
              unitPrice: selectedPackage
                ? selectedPackage.price
                : paymentField.paymentConfig?.amount,
            },
          }
        );

        console.log('Payment result:', paymentResult);

        submission.payment = {
          id: paymentResult.payment?.squareId || paymentResult.payment?.id,
          amount: totalAmount,
          currency: paymentField.paymentConfig?.currency || 'USD',
          status: paymentResult.payment?.status || 'completed',
          gateway: 'square',
          transactionId:
            paymentResult.payment?.squareId || paymentResult.payment?.id,
          receiptUrl: paymentResult.payment?.receiptUrl,
          processedAt: new Date(),
          metadata: {
            packageName: selectedPackage?.name,
            quantity: quantity,
            unitPrice: selectedPackage
              ? selectedPackage.price
              : paymentField.paymentConfig?.amount,
          },
        };

        submission.status = 'completed';
        submission.completedAt = new Date();
      } catch (paymentError) {
        console.error('Payment processing error:', paymentError);
        return res.status(402).json({
          success: false,
          error: 'Payment processing failed',
          details: paymentError.message,
        });
      }
    } else if (hasPaymentFields) {
      // Two-step flow: mark as pending payment
      submission.payment = {
        status: 'pending',
        amount: 0,
        currency: paymentField.paymentConfig?.currency || 'USD',
        gateway: 'square',
      };
    }

    await submission.save();

    // Increment form submission count
    await Form.findByIdAndUpdate(form._id, { $inc: { submissions: 1 } });

    // Send email notification if configured
    if (
      form.settings.sendEmail &&
      form.settings.emailTo &&
      form.settings.emailTo.length > 0
    ) {
      await sendFormSubmissionEmail(form, submission, form.settings.emailTo);
    }

    // Send confirmation email to submitter
    if (submission.userEmail) {
      await sendConfirmationEmail(form, submission);
    }

    res.json({
      success: true,
      data: {
        submissionId: submission._id,
        status: submission.status,
        requiresPayment: requiresPayment,
        payment: submission.payment,
        message:
          submission.status === 'pending_payment'
            ? 'Form submitted successfully. Please complete payment.'
            : form.settings.successMessage || 'Form submitted successfully!',
      },
    });
  } catch (error) {
    console.error('Form submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit form',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Process form payment (for two-step flow)
router.post(
  '/:id/process-payment',
  [
    body('token').notEmpty().withMessage('Payment token is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('cardDetails').isObject().withMessage('Card details are required'),
    body('cardDetails.last_4')
      .optional()
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4 digits'),
    body('submissionId').notEmpty().withMessage('Submission ID is required'),
    body('selectedPackage').optional(),
    body('quantity').optional().isInt({ min: 1 }),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const {
        token,
        email,
        cardDetails,
        submissionId,
        selectedPackage,
        quantity = 1,
        metadata = {},
      } = req.body;

      // 1. Get the form
      const form = await Form.findById(req.params.id).session(session);
      if (!form) {
        return res.status(404).json({
          success: false,
          error: 'Form not found',
        });
      }

      // 2. Get the submission
      const submission =
        await FormSubmission.findById(submissionId).session(session);
      if (!submission) {
        return res.status(404).json({
          success: false,
          error: 'Submission not found',
        });
      }

      // Verify submission belongs to form
      if (submission.formId.toString() !== form._id.toString()) {
        return res.status(400).json({
          success: false,
          error: 'Submission does not belong to this form',
        });
      }

      // Verify submission is pending
      if (submission.status !== 'pending') {
        return res.status(400).json({
          success: false,
          error: `Submission is not pending payment. Current status: ${submission.status}`,
        });
      }

      // 3. Get payment field
      const paymentField = form.fields.find((f) => f.type === 'payment');
      if (!paymentField) {
        return res.status(400).json({
          success: false,
          error: 'Payment field not found',
        });
      }

      console.log('Processing payment for form:', {
        formId: form._id,
        formTitle: form.title,
        submissionId: submission._id,
        email: email.substring(0, 5) + '...',
      });

      // 4. Calculate amount based on pricing packages or fixed price
      let amount = 0;
      let packageInfo = null;
      let finalQuantity = parseInt(quantity) || 1;

      if (paymentField.paymentConfig?.pricingPackages?.length > 0) {
        // Use pricing packages
        if (selectedPackage) {
          const selectedPkg = paymentField.paymentConfig.pricingPackages.find(
            (pkg) => pkg.name === selectedPackage && pkg.isEnabled
          );

          if (!selectedPkg) {
            return res.status(400).json({
              success: false,
              error: 'Invalid package selected',
            });
          }

          packageInfo = {
            name: selectedPkg.name,
            description: selectedPkg.description,
            price: selectedPkg.price,
            quantity: finalQuantity,
            maxQuantity: selectedPkg.maxQuantity,
          };

          // Validate quantity
          if (
            selectedPkg.maxQuantity &&
            finalQuantity > selectedPkg.maxQuantity
          ) {
            return res.status(400).json({
              success: false,
              error: `Maximum quantity for this package is ${selectedPkg.maxQuantity}`,
            });
          }

          amount = selectedPkg.price * finalQuantity;
        } else {
          // Use default package
          const defaultPkg =
            paymentField.paymentConfig.pricingPackages.find(
              (pkg) => pkg.defaultSelected && pkg.isEnabled
            ) ||
            paymentField.paymentConfig.pricingPackages.find(
              (pkg) => pkg.isEnabled
            );

          if (defaultPkg) {
            packageInfo = {
              name: defaultPkg.name,
              description: defaultPkg.description,
              price: defaultPkg.price,
              quantity: finalQuantity,
              maxQuantity: defaultPkg.maxQuantity,
            };

            if (
              defaultPkg.maxQuantity &&
              finalQuantity > defaultPkg.maxQuantity
            ) {
              finalQuantity = defaultPkg.maxQuantity;
            }

            amount = defaultPkg.price * finalQuantity;
          } else {
            return res.status(400).json({
              success: false,
              error: 'No valid pricing package available',
            });
          }
        }
      } else {
        // Fixed price
        amount = paymentField.paymentConfig?.amount || 0;
      }

      if (amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payment amount',
        });
      }

      console.log('Payment amount calculated:', {
        amount: amount,
        amountInDollars: amount / 100,
        package: packageInfo?.name,
        quantity: finalQuantity,
      });

      // 5. IMPORTANT: Use the correct function - processFormPayment
      const { processFormPayment } = require('../services/form-payments');

      const paymentResult = await processFormPayment(
        token,
        amount, // amount is in cents
        paymentField.paymentConfig?.currency || 'USD',
        {
          formId: form._id.toString(),
          submissionId: submission._id.toString(),
          fieldId: paymentField.id,
          buyerEmail: email,
          selectedPackage: packageInfo?.name,
          quantity: finalQuantity,
          formTitle: form.title,
          fieldLabel: paymentField.label,
        }
      );

      console.log('Square payment result:', paymentResult);

      if (!paymentResult.success) {
        throw new Error(paymentResult.error || 'Payment processing failed');
      }

      // 6. Create TicketPurchase record
      const ticketPurchase = new TicketPurchase({
        formId: form._id,
        submissionId: submission._id,
        customerEmail: email,
        customerName: submission.userName || submission.data.get('name') || '',
        paymentId: paymentResult.payment.id,
        squarePaymentId: paymentResult.payment.id,
        locationId:
          process.env.SQUARE_LOCATION_ID ||
          paymentField.paymentConfig?.squareLocationId,
        cardLastFour: cardDetails.last_4 || '0000',
        cardBrand: cardDetails.card_brand || 'VISA',
        cardExpMonth: cardDetails.exp_month?.toString() || '12',
        cardExpYear: cardDetails.exp_year?.toString() || '2030',
        amount: amount / 100, // Store in dollars
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        packageName: packageInfo?.name,
        quantity: finalQuantity,
        unitPrice: packageInfo ? packageInfo.price / 100 : amount / 100,
        receiptUrl: paymentResult.payment.receiptUrl,
        processedAt: new Date(),
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      await ticketPurchase.save({ session });

      // 7. Update FormSubmission
      submission.payment = {
        id: paymentResult.payment.id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        gateway: 'square',
        transactionId: paymentResult.payment.id,
        receiptUrl: paymentResult.payment.receiptUrl,
        processedAt: new Date(),
        metadata: {
          ticketPurchaseId: ticketPurchase._id,
          fieldId: paymentField.id,
          cardLast4: cardDetails.last_4 || '0000',
          cardBrand: cardDetails.card_brand || 'VISA',
          selectedPackage: packageInfo?.name,
          quantity: finalQuantity,
        },
      };

      // Update submission data with package info
      if (packageInfo) {
        submission.data.set('selectedPackage', packageInfo.name);
        submission.data.set('quantity', finalQuantity);
        submission.data.set('unitPrice', packageInfo.price / 100);
        submission.data.set('totalAmount', amount / 100);
      }

      submission.status = 'completed';
      submission.completedAt = new Date();

      await submission.save({ session });

      await session.commitTransaction();

      // 8. Send payment confirmation email
      if (email) {
        try {
          // Prepare the data for the receipt email
          const formData = {
            formTitle: form.title,
            userName: submission.userName || submission.data.get('name') || '',
            userEmail: email,
            amount: amount / 100,
            currency: paymentField.paymentConfig?.currency || 'USD',
            transactionId: paymentResult.payment.id,
            receiptUrl: paymentResult.payment.receiptUrl,
            selectedPackage: packageInfo,
            quantity: finalQuantity,
            tournamentInfo: form.tournamentSettings,
            venues: form.tournamentSettings?.venues || [],
            formData: submission.data.toObject(),
          };

          const submissionData = {
            submissionId: submission._id,
            submittedAt: submission.createdAt,
            cardLast4: cardDetails?.last_4 || '0000',
            cardBrand: cardDetails?.card_brand || 'unknown',
            paymentStatus: 'completed',
          };

          // Use the new form payment receipt email function
          await sendFormPaymentReceiptEmail(formData, submissionData);

          // Also send notification to form owner(s) if they have email notifications enabled
          if (form.settings?.sendEmail && form.settings?.emailTo?.length > 0) {
            const ownerEmails = form.settings.emailTo.filter(
              (email) => typeof email === 'string' && email.includes('@')
            );

            if (ownerEmails.length > 0) {
              try {
                const paymentDetails = packageInfo
                  ? `${packageInfo.name} (Quantity: ${finalQuantity})`
                  : 'Fixed price';

                // Send to each form owner email using the new helper function
                for (const ownerEmail of ownerEmails) {
                  await sendFormOwnerNotificationEmail({
                    to: ownerEmail,
                    formTitle: form.title,
                    customerName: submission.userName || 'N/A',
                    customerEmail: email,
                    amount: amount / 100,
                    currency: paymentField.paymentConfig?.currency || 'USD',
                    transactionId: paymentResult.payment.id,
                    submissionId: submission._id,
                    paymentDetails,
                    tournamentInfo: form.tournamentSettings,
                  });
                }
              } catch (ownerEmailError) {
                console.error(
                  'Error sending owner notification email:',
                  ownerEmailError
                );
              }
            }
          }
        } catch (emailError) {
          console.error(
            'Error sending payment confirmation email:',
            emailError
          );
        }
      }

      res.json({
        success: true,
        ticketPurchaseId: ticketPurchase._id,
        squarePaymentId: paymentResult.payment.id,
        receiptUrl: paymentResult.payment.receiptUrl,
        submissionId: submission._id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        package: packageInfo?.name,
        quantity: finalQuantity,
        message: 'Payment processed successfully',
      });
    } catch (err) {
      await session.abortTransaction();
      console.error('Payment processing error:', err);
      res.status(400).json({
        success: false,
        error: err.message || 'Payment processing failed',
      });
    } finally {
      session.endSession();
    }
  }
);

// Helper function to process payment without requiring parentId
async function processFormPaymentWithoutParent(token, amount, options = {}) {
  // This is a simplified version of your submitPayment function
  // that doesn't require parentId for form payments

  try {
    // Import your square service
    const { processSquarePayment } = require('../services/square-payments');

    // Process with Square - assuming your square service can handle form payments
    const paymentResult = await processSquarePayment(token, amount, {
      ...options,
      // Don't pass parentId for form payments
    });

    return {
      success: true,
      payment: {
        id: paymentResult.paymentId || paymentResult.id,
        squareId: paymentResult.paymentId || paymentResult.id,
        receiptUrl: paymentResult.receiptUrl,
        status: 'COMPLETED',
      },
    };
  } catch (error) {
    console.error('Payment processing error:', error);
    return {
      success: false,
      error: error.message || 'Payment processing failed',
    };
  }
}

// Helper function for payment confirmation email
async function sendPaymentConfirmationEmail(form, submission, paymentData) {
  console.log(
    'Would send payment confirmation email to:',
    submission.userEmail
  );
  console.log('Payment amount:', paymentData.amount, paymentData.currency);
  console.log('Transaction ID:', paymentData.transactionId);

  // Implement your email sending logic here
  // Example:
  /*
  const emailData = {
    to: submission.userEmail,
    subject: `Payment Confirmation - ${form.title}`,
    html: `
      <h2>Payment Confirmation</h2>
      <p>Your payment has been successfully processed.</p>
      <p><strong>Form:</strong> ${form.title}</p>
      <p><strong>Amount:</strong> ${paymentData.amount} ${paymentData.currency}</p>
      <p><strong>Transaction ID:</strong> ${paymentData.transactionId}</p>
      <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      ${paymentData.receiptUrl ? `<p><a href="${paymentData.receiptUrl}">Download Receipt</a></p>` : ''}
      ${paymentData.package ? `<p><strong>Package:</strong> ${paymentData.package} (Quantity: ${paymentData.quantity})</p>` : ''}
    `,
  };
  
  await sendEmail(emailData);
  */
}

// Helper functions for form generation
function generateFormFieldsHTML(fields) {
  let html = '';

  fields
    .sort((a, b) => a.order - b.order)
    .forEach((field) => {
      const requiredMark = field.required
        ? '<span class="required">*</span>'
        : '';
      const helpText = field.helpText
        ? `<div class="form-help">${field.helpText}</div>`
        : '';

      switch (field.type) {
        case 'section':
          html += `
          <div class="form-section" data-field-id="${field.id}">
            <div class="form-section-title">${field.label}</div>
            ${field.helpText ? `<p class="form-help">${field.helpText}</p>` : ''}
          </div>
        `;
          break;

        case 'heading':
          html += `<h3 class="form-heading" data-field-id="${field.id}">${field.label}</h3>`;
          break;

        case 'divider':
          html += `<hr class="form-divider" data-field-id="${field.id}" />`;
          break;

        case 'text':
        case 'email':
        case 'number':
        case 'tel':
        case 'url':
        case 'password':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <input 
              type="${field.type}" 
              name="${field.name || field.id}" 
              id="${field.id}"
              class="form-input" 
              placeholder="${field.placeholder || ''}"
              ${field.defaultValue ? `value="${field.defaultValue}"` : ''}
              ${field.required ? 'required data-required="true"' : ''}
              ${field.validation?.pattern ? `pattern="${field.validation.pattern}"` : ''}
              ${field.validation?.min ? `min="${field.validation.min}"` : ''}
              ${field.validation?.max ? `max="${field.validation.max}"` : ''}
              ${field.validation?.minLength ? `minlength="${field.validation.minLength}"` : ''}
              ${field.validation?.maxLength ? `maxlength="${field.validation.maxLength}"` : ''}
            />
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'textarea':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <textarea 
              name="${field.name || field.id}" 
              id="${field.id}"
              class="form-textarea" 
              placeholder="${field.placeholder || ''}"
              ${field.required ? 'required data-required="true"' : ''}
              ${field.validation?.minLength ? `minlength="${field.validation.minLength}"` : ''}
              ${field.validation?.maxLength ? `maxlength="${field.validation.maxLength}"` : ''}
              rows="${field.style?.rows || 4}"
            >${field.defaultValue || ''}</textarea>
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'select':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <select 
              name="${field.name || field.id}" 
              id="${field.id}"
              class="form-select"
              ${field.required ? 'required data-required="true"' : ''}
            >
              <option value="">${field.placeholder || 'Select an option'}</option>
              ${(field.options || [])
                .map(
                  (option) => `
                <option value="${option.value}" ${option.selected ? 'selected' : ''}>
                  ${option.label}
                </option>
              `
                )
                .join('')}
            </select>
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'radio':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label">
              ${field.label} ${requiredMark}
            </label>
            ${(field.options || [])
              .map(
                (option) => `
              <div class="form-option">
                <input 
                  type="radio" 
                  name="${field.name || field.id}" 
                  id="${field.id}-${option.value}"
                  value="${option.value}"
                  class="form-radio"
                  ${option.selected ? 'checked' : ''}
                  ${field.required ? 'required data-required="true"' : ''}
                />
                <label for="${field.id}-${option.value}">
                  ${option.label}
                </label>
              </div>
            `
              )
              .join('')}
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'checkbox':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <div class="form-option">
              <input 
                type="checkbox" 
                name="${field.name || field.id}" 
                id="${field.id}"
                value="true"
                class="form-checkbox"
                ${field.defaultValue ? 'checked' : ''}
                ${field.required ? 'required data-required="true"' : ''}
              />
              <label for="${field.id}" class="form-label">
                ${field.label} ${requiredMark}
              </label>
            </div>
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'date':
        case 'time':
        case 'datetime-local':
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <input 
              type="${field.type}" 
              name="${field.name || field.id}" 
              id="${field.id}"
              class="form-input" 
              ${field.defaultValue ? `value="${field.defaultValue}"` : ''}
              ${field.required ? 'required data-required="true"' : ''}
            />
            ${helpText}
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'file':
          const accept = field.fileConfig?.accept || '';
          const multiple = field.fileConfig?.multiple ? 'multiple' : '';
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <div class="file-upload">
              <input 
                type="file" 
                name="${field.name || field.id}" 
                id="${field.id}"
                accept="${accept}"
                ${multiple}
                ${field.required ? 'required data-required="true"' : ''}
                data-max-size="${field.fileConfig?.maxSize || 10485760}"
              />
              <label for="${field.id}">Click to upload files</label>
              <div class="file-preview" id="preview-${field.id}"></div>
            </div>
            ${helpText}
            ${
              field.fileConfig?.maxSize
                ? `
              <div class="form-help">
                Maximum file size: ${Math.round(field.fileConfig.maxSize / 1024 / 1024)}MB
              </div>
            `
                : ''
            }
            <div class="form-error" id="error-${field.id}"></div>
          </div>
        `;
          break;

        case 'payment':
          const hasPackages = field.paymentConfig?.pricingPackages?.length > 0;
          const enabledPackages =
            field.paymentConfig?.pricingPackages?.filter(
              (pkg) => pkg.isEnabled
            ) || [];
          const defaultPackage =
            enabledPackages.find((pkg) => pkg.defaultSelected) ||
            enabledPackages[0];

          html += `
  <div class="form-field form-payment" data-field-id="${field.id}">
    <div class="form-section-title">${field.label}</div>
    ${field.helpText ? `<p class="form-help">${field.helpText}</p>` : ''}
    
    ${
      hasPackages
        ? `
      <!-- Pricing Packages -->
      <div class="pricing-packages mb-3">
        ${enabledPackages
          .map(
            (pkg, index) => `
          <div class="pricing-package card mb-2 ${pkg.defaultSelected ? 'selected border-primary' : 'border-light'}" 
               style="cursor: pointer; transition: all 0.2s ease;">
            <div class="card-body" onclick="selectPackage('${field.id}', ${index})">
              <div class="form-check">
                <input 
                  type="radio" 
                  name="${field.id}_package" 
                  id="${field.id}_package_${index}"
                  value="${pkg.name}"
                  class="form-check-input"
                  ${pkg.defaultSelected ? 'checked' : ''}
                  data-price="${pkg.price}"
                  style="display: none;"
                />
                <label class="form-check-label w-100" for="${field.id}_package_${index}">
                  <div class="d-flex justify-content-between align-items-center">
                    <div>
                      <strong>${pkg.name}</strong>
                      ${pkg.description ? `<p class="mb-1 small text-muted">${pkg.description}</p>` : ''}
                    </div>
                    <div class="text-end">
                      <span class="text-success fw-bold">
                        $${(pkg.price / 100).toFixed(2)} ${pkg.currency}
                      </span>
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>
          
          <!-- Quantity selector for this package -->
          <div class="quantity-selector mt-2 mb-3" id="${field.id}_quantity_${index}" 
               style="display: ${pkg.defaultSelected ? 'block' : 'none'};">
            <label class="form-label small">Quantity</label>
            <div class="input-group input-group-sm" style="max-width: 150px;">
              <button class="btn btn-outline-secondary" type="button" onclick="adjustQuantity('${field.id}', ${index}, -1)">-</button>
              <input 
                type="number" 
                class="form-control text-center quantity-input" 
                name="${field.id}_quantity"
                data-package-index="${index}"
                value="${pkg.quantity || 1}"
                min="1"
                ${pkg.maxQuantity ? `max="${pkg.maxQuantity}"` : ''}
                onchange="updateTotal('${field.id}')"
              />
              <button class="btn btn-outline-secondary" type="button" onclick="adjustQuantity('${field.id}', ${index}, 1)">+</button>
            </div>
            ${pkg.maxQuantity ? `<div class="form-text">Maximum: ${pkg.maxQuantity}</div>` : ''}
          </div>
        `
          )
          .join('')}
      </div>
      
      <!-- Total Display -->
      <div class="total-display mb-3">
        <div class="d-flex justify-content-between align-items-center border-top pt-2">
          <strong>Total:</strong>
          <span class="text-success fw-bold fs-4" id="${field.id}_total">
            $${(((defaultPackage?.price || 0) * (defaultPackage?.quantity || 1)) / 100).toFixed(2)}
            ${field.paymentConfig?.currency || 'USD'}
          </span>
        </div>
      </div>
    `
        : `
      <!-- Fixed Price -->
      <div class="form-payment-amount mb-3">
        <h4 class="text-success">$${((field.paymentConfig.amount || 0) / 100).toFixed(2)} ${field.paymentConfig.currency || 'USD'}</h4>
      </div>
      ${field.paymentConfig.description ? `<p>${field.paymentConfig.description}</p>` : ''}
    `
    }
    
    <!-- Container for Square's payment iframe -->
    <div id="sq-card-container-${field.id}"></div>
    <!-- Hidden input to store the payment token -->
    <input type="hidden" name="paymentToken" id="payment-token-${field.id}" />
    <div id="sq-card-errors-${field.id}" class="form-error"></div>
  </div>
  
  <script>
    // Package selection functions
    function selectPackage(fieldId, packageIndex) {
      // Update radio button
      document.getElementById(fieldId + '_package_' + packageIndex).checked = true;
      
      // Update visual selection
      document.querySelectorAll('.pricing-package').forEach(pkg => {
        pkg.classList.remove('selected', 'border-primary');
        pkg.classList.add('border-light');
      });
      event.currentTarget.closest('.pricing-package').classList.add('selected', 'border-primary');
      event.currentTarget.closest('.pricing-package').classList.remove('border-light');
      
      // Show/hide quantity selectors
      document.querySelectorAll('.quantity-selector').forEach(el => {
        el.style.display = 'none';
      });
      document.getElementById(fieldId + '_quantity_' + packageIndex).style.display = 'block';
      
      // Update total
      updateTotal(fieldId);
    }
    
    function adjustQuantity(fieldId, packageIndex, change) {
      const quantityInput = document.querySelector(\`input[data-package-index="\${packageIndex}"]\`);
      let quantity = parseInt(quantityInput.value) || 1;
      const maxQuantity = parseInt(quantityInput.max) || Infinity;
      
      quantity += change;
      if (quantity < 1) quantity = 1;
      if (quantity > maxQuantity) quantity = maxQuantity;
      
      quantityInput.value = quantity;
      updateTotal(fieldId);
    }
    
    function updateTotal(fieldId) {
      const selectedPackage = document.querySelector('input[name="' + fieldId + '_package"]:checked');
      if (!selectedPackage) return;
      
      const packageIndex = selectedPackage.id.split('_').pop();
      const quantityInput = document.querySelector(\`input[data-package-index="\${packageIndex}"]\`);
      const quantity = parseInt(quantityInput.value) || 1;
      const price = parseFloat(selectedPackage.dataset.price) || 0;
      const total = (price * quantity) / 100;
      
      document.getElementById(fieldId + '_total').textContent = 
        '\$' + total.toFixed(2) + ' ${field.paymentConfig?.currency || 'USD'}';
    }
  </script>
  `;
          break;

        default:
          html += `
          <div class="form-field" data-field-id="${field.id}">
            <label class="form-label" for="${field.id}">
              ${field.label} ${requiredMark}
            </label>
            <input 
              type="text" 
              name="${field.name || field.id}" 
              id="${field.id}"
              class="form-input" 
              placeholder="${field.placeholder || ''}"
              ${field.defaultValue ? `value="${field.defaultValue}"` : ''}
              ${field.required ? 'required data-required="true"' : ''}
              disabled
              title="Unsupported field type: ${field.type}"
            />
            ${helpText}
            <div class="form-error">Unsupported field type: ${field.type}</div>
          </div>
          `;
          break;
      }

      // Add conditional logic attributes if present
      if (field.conditionalLogic && field.conditionalLogic.dependsOn) {
        const fieldDiv = html.substring(
          html.lastIndexOf('<div class="form-field"')
        );
        const updatedDiv = fieldDiv.replace(
          '<div class="form-field"',
          `<div class="form-field" 
               data-depends-on="${field.conditionalLogic.dependsOn}"
               data-condition="${field.conditionalLogic.condition}"
               data-value="${JSON.stringify(field.conditionalLogic.value).replace(/"/g, '&quot;')}"
               data-show="${field.conditionalLogic.show}"
               data-field-id="${field.id}"`
        );
        html = html.replace(fieldDiv, updatedDiv);
      }
    });

  return html;
}

// Helper function to send form submission email
async function sendFormSubmissionEmail(form, submission, recipients) {
  // Implement email sending logic here
  console.log('Sending form submission email:', {
    form: form.title,
    submissionId: submission._id,
    recipients,
  });
}

// Helper function to send confirmation email
async function sendConfirmationEmail(form, submission) {
  console.log('Sending confirmation email:', {
    form: form.title,
    submissionId: submission._id,
    recipient: submission.userEmail,
  });
}

module.exports = router;
