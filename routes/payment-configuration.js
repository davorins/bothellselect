// payment-configuration.js
const express = require('express');
const router = express.Router();
const PaymentConfiguration = require('../models/PaymentConfiguration');
const { authenticate, isAdmin } = require('../utils/auth');
const { body, validationResult } = require('express-validator');

router.get('/frontend/config', async (req, res) => {
  try {
    const config = await PaymentConfiguration.findOne({
      isActive: true,
    }).sort({ isDefault: -1 });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'No active payment configuration found',
      });
    }

    // Return only non-sensitive information needed for frontend
    const frontendConfig = {
      paymentSystem: config.paymentSystem,
      environment:
        config[`${config.paymentSystem}Config`]?.environment || 'sandbox',
      currency: config.settings?.currency || 'USD',
      // Return only public config values
      squareConfig: config.squareConfig
        ? {
            applicationId: config.squareConfig.applicationId,
            locationId: config.squareConfig.locationId,
            environment: config.squareConfig.environment,
          }
        : null,
      cloverConfig: config.cloverConfig
        ? {
            merchantId: config.cloverConfig.merchantId,
            environment: config.cloverConfig.environment,
            accessToken: config.cloverConfig.accessToken,
          }
        : null,
      settings: {
        currency: config.settings?.currency || 'USD',
      },
    };

    res.json({
      success: true,
      ...frontendConfig,
    });
  } catch (error) {
    console.error('Error getting frontend payment configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get payment configuration',
    });
  }
});

// Get all payment configurations (NO organization needed!)
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const configurations = await PaymentConfiguration.find()
      .select(
        '-squareConfig.accessToken -squareConfig.webhookSignatureKey -cloverConfig.accessToken',
      )
      .sort({ isDefault: -1, updatedAt: -1 });

    res.json({
      success: true,
      data: configurations,
    });
  } catch (error) {
    console.error('Error fetching payment configurations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment configurations',
    });
  }
});

// Get specific payment configuration
router.get('/:configId', authenticate, isAdmin, async (req, res) => {
  try {
    const { configId } = req.params;

    const configuration = await PaymentConfiguration.findById(configId);

    if (!configuration) {
      return res.status(404).json({
        success: false,
        error: 'Payment configuration not found',
      });
    }

    // Return without sensitive data
    const safeConfig = configuration.toJSON();

    res.json({
      success: true,
      data: safeConfig,
    });
  } catch (error) {
    console.error('Error fetching payment configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment configuration',
    });
  }
});

// Create new payment configuration
router.post(
  '/',
  authenticate,
  isAdmin,
  [
    body('paymentSystem')
      .isIn(['square', 'clover', 'stripe', 'paypal'])
      .withMessage('Valid payment system is required'),
    body('isActive').optional().isBoolean(),
    body('isDefault').optional().isBoolean(),
    // Square validation
    body('squareConfig.accessToken').optional().isString(),
    body('squareConfig.applicationId').optional().isString(),
    body('squareConfig.environment').optional().isIn(['sandbox', 'production']),
    body('squareConfig.locationId').optional().isString(),
    body('squareConfig.webhookSignatureKey').optional().isString(),
    // Clover validation
    body('cloverConfig.merchantId').optional().isString(),
    body('cloverConfig.accessToken').optional().isString(),
    body('cloverConfig.environment').optional().isIn(['sandbox', 'production']),
    // Settings validation
    body('settings.currency').optional().isIn(['USD', 'CAD', 'EUR', 'GBP']),
    body('settings.taxRate').optional().isFloat({ min: 0, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    try {
      const {
        paymentSystem,
        isActive = true,
        isDefault = false,
        squareConfig,
        cloverConfig,
        stripeConfig,
        paypalConfig,
        settings,
        webhookUrls,
      } = req.body;

      // Validate configuration based on payment system
      let validationError = null;
      switch (paymentSystem) {
        case 'square':
          if (!squareConfig?.accessToken || !squareConfig?.locationId) {
            validationError = 'Square requires accessToken and locationId';
          }
          break;
        case 'clover':
          if (!cloverConfig?.accessToken || !cloverConfig?.merchantId) {
            validationError = 'Clover requires accessToken and merchantId';
          }
          break;
        case 'stripe':
          if (!stripeConfig?.secretKey) {
            validationError = 'Stripe requires secretKey';
          }
          break;
        case 'paypal':
          if (!paypalConfig?.clientId || !paypalConfig?.clientSecret) {
            validationError = 'PayPal requires clientId and clientSecret';
          }
          break;
      }

      if (validationError) {
        return res.status(400).json({
          success: false,
          error: validationError,
        });
      }

      // If this is being set as default, unset any existing default
      if (isDefault) {
        await PaymentConfiguration.updateMany(
          { isDefault: true },
          { $set: { isDefault: false } },
        );
      }

      // Create the configuration (NO organizationId!)
      const configuration = new PaymentConfiguration({
        paymentSystem,
        isActive,
        isDefault,
        squareConfig: squareConfig || {},
        cloverConfig: cloverConfig || {},
        stripeConfig: stripeConfig || {},
        paypalConfig: paypalConfig || {},
        settings: settings || {},
        webhookUrls: webhookUrls || {},
        createdBy: req.user._id,
        lastModifiedBy: req.user._id,
      });

      await configuration.save();

      // Test the configuration
      let testResult = null;
      if (process.env.NODE_ENV !== 'test') {
        testResult = await testPaymentConfiguration(
          paymentSystem,
          configuration,
        );

        if (!testResult.success) {
          // Still save, but return warning
          return res.status(201).json({
            success: true,
            warning: 'Configuration saved but test failed',
            testResult: testResult,
            data: configuration.toJSON(),
          });
        }
      }

      // Return without sensitive data
      const safeConfig = configuration.toJSON();

      res.status(201).json({
        success: true,
        message: 'Payment configuration created successfully',
        data: safeConfig,
        testResult: testResult,
      });
    } catch (error) {
      console.error('Error creating payment configuration:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create payment configuration',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

// Update payment configuration
router.put(
  '/:configId',
  authenticate,
  isAdmin,
  [
    body('isActive').optional().isBoolean(),
    body('isDefault').optional().isBoolean(),
    body('squareConfig.accessToken').optional().isString(),
    body('squareConfig.applicationId').optional().isString(),
    body('squareConfig.environment').optional().isIn(['sandbox', 'production']),
    body('squareConfig.locationId').optional().isString(),
    body('squareConfig.webhookSignatureKey').optional().isString(),
    body('cloverConfig.merchantId').optional().isString(),
    body('cloverConfig.accessToken').optional().isString(),
    body('cloverConfig.environment').optional().isIn(['sandbox', 'production']),
    body('settings.currency').optional().isIn(['USD', 'CAD', 'EUR', 'GBP']),
    body('settings.taxRate').optional().isFloat({ min: 0, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    try {
      const { configId } = req.params;
      const updates = req.body;

      const configuration = await PaymentConfiguration.findById(configId);
      if (!configuration) {
        return res.status(404).json({
          success: false,
          error: 'Payment configuration not found',
        });
      }

      // Update fields
      const allowedUpdates = [
        'isActive',
        'isDefault',
        'squareConfig',
        'cloverConfig',
        'stripeConfig',
        'paypalConfig',
        'settings',
        'webhookUrls',
      ];

      allowedUpdates.forEach((field) => {
        if (updates[field] !== undefined) {
          if (
            field === 'squareConfig' ||
            field === 'cloverConfig' ||
            field === 'stripeConfig' ||
            field === 'paypalConfig'
          ) {
            // Merge configuration objects
            configuration[field] = {
              ...configuration[field],
              ...updates[field],
            };
          } else {
            configuration[field] = updates[field];
          }
        }
      });

      // If setting as default, unset other defaults
      if (updates.isDefault === true) {
        await PaymentConfiguration.updateMany(
          { _id: { $ne: configId }, isDefault: true },
          { $set: { isDefault: false } },
        );
      }

      configuration.lastModifiedBy = req.user._id;
      configuration.updatedAt = Date.now();

      await configuration.save();

      // Test configuration if sensitive data changed
      const sensitiveFields = [
        'accessToken',
        'secretKey',
        'clientSecret',
        'webhookSignatureKey',
      ];
      const hasSensitiveChanges = Object.keys(updates).some((key) =>
        sensitiveFields.some((field) => key.includes(field)),
      );

      let testResult = null;
      if (hasSensitiveChanges && process.env.NODE_ENV !== 'test') {
        testResult = await testPaymentConfiguration(
          configuration.paymentSystem,
          configuration,
        );
      }

      // Return without sensitive data
      const safeConfig = configuration.toJSON();

      res.json({
        success: true,
        message: 'Payment configuration updated successfully',
        data: safeConfig,
        testResult: testResult,
      });
    } catch (error) {
      console.error('Error updating payment configuration:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update payment configuration',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
);

// Delete payment configuration
router.delete('/:configId', authenticate, isAdmin, async (req, res) => {
  try {
    const { configId } = req.params;

    const configuration = await PaymentConfiguration.findById(configId);
    if (!configuration) {
      return res.status(404).json({
        success: false,
        error: 'Payment configuration not found',
      });
    }

    // Check if this is the only active configuration
    const activeConfigs = await PaymentConfiguration.countDocuments({
      isActive: true,
      _id: { $ne: configId },
    });

    if (activeConfigs === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete the only active payment configuration',
      });
    }

    // Delete the configuration
    await PaymentConfiguration.deleteOne({ _id: configId });

    res.json({
      success: true,
      message: 'Payment configuration deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting payment configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete payment configuration',
    });
  }
});

// Test payment configuration
router.post('/:configId/test', authenticate, isAdmin, async (req, res) => {
  try {
    const { configId } = req.params;

    const configuration = await PaymentConfiguration.findById(configId);
    if (!configuration) {
      return res.status(404).json({
        success: false,
        error: 'Payment configuration not found',
      });
    }

    const testResult = await testPaymentConfiguration(
      configuration.paymentSystem,
      configuration,
    );

    res.json({
      success: testResult.success,
      message: testResult.success
        ? 'Configuration test passed'
        : 'Configuration test failed',
      data: testResult,
    });
  } catch (error) {
    console.error('Error testing payment configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test payment configuration',
    });
  }
});

// Test all configurations
router.post('/test/all', authenticate, isAdmin, async (req, res) => {
  try {
    const configurations = await PaymentConfiguration.find({ isActive: true });

    const testResults = [];

    for (const config of configurations) {
      const testResult = await testPaymentConfiguration(
        config.paymentSystem,
        config,
      );

      testResults.push({
        configId: config._id,
        paymentSystem: config.paymentSystem,
        ...testResult,
      });
    }

    const allPassed = testResults.every((result) => result.success);

    res.json({
      success: true,
      allPassed,
      results: testResults,
    });
  } catch (error) {
    console.error('Error testing all configurations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test configurations',
    });
  }
});

// Get active payment system
router.get('/system/active', async (req, res) => {
  try {
    const config = await PaymentConfiguration.findOne({ isActive: true }).sort({
      isDefault: -1,
    });

    if (!config) {
      return res.json({
        success: true,
        active: false,
        message: 'No active payment configuration found',
      });
    }

    // Return the full configuration
    res.json({
      success: true,
      active: true,
      paymentSystem: config.paymentSystem,
      environment:
        config[`${config.paymentSystem}Config`]?.environment || 'sandbox',
      currency: config.settings?.currency || 'USD',
      // Include the specific payment system config
      squareConfig: config.squareConfig || null,
      cloverConfig: config.cloverConfig || null,
      stripeConfig: config.stripeConfig || null,
      paypalConfig: config.paypalConfig || null,
      // Include other settings
      settings: config.settings || {},
    });
  } catch (error) {
    console.error('Error getting active payment system:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active payment system',
    });
  }
});

// Helper function to test payment configuration
async function testPaymentConfiguration(paymentSystem, config) {
  try {
    switch (paymentSystem) {
      case 'square': {
        const { Client, Environment } = require('square');
        const client = new Client({
          accessToken: config.squareConfig.accessToken,
          environment:
            config.squareConfig.environment === 'production'
              ? Environment.Production
              : Environment.Sandbox,
        });

        // Test by fetching locations
        const { locationsApi } = client;
        const response = await locationsApi.listLocations();

        // Check if configured location exists
        const hasLocation = response.result.locations?.some(
          (loc) => loc.id === config.squareConfig.locationId,
        );

        return {
          success: true,
          message: 'Square connection successful',
          details: {
            locationsCount: response.result.locations?.length || 0,
            configuredLocationExists: hasLocation,
            environment: config.squareConfig.environment,
          },
        };
      }

      case 'clover': {
        const clover = require('clover-sdk');
        const cloverClient = new clover.ApiClient();

        cloverClient.basePath =
          config.cloverConfig.environment === 'production'
            ? 'https://api.clover.com/v3'
            : 'https://apisandbox.dev.clover.com/v3';
        cloverClient.authentications['oauth'].accessToken =
          config.cloverConfig.accessToken;

        const merchantApi = new clover.MerchantApi(cloverClient);

        // Test by fetching merchant info
        const response = await merchantApi.getMerchant(
          config.cloverConfig.merchantId,
        );

        return {
          success: true,
          message: 'Clover connection successful',
          details: {
            merchantName: response.data.name,
            merchantId: response.data.id,
            environment: config.cloverConfig.environment,
          },
        };
      }

      case 'stripe': {
        const stripe = require('stripe')(config.stripeConfig.secretKey);

        // Test by fetching balance
        const balance = await stripe.balance.retrieve();

        return {
          success: true,
          message: 'Stripe connection successful',
          details: {
            currency: balance.available[0]?.currency,
            available: balance.available[0]?.amount,
            pending: balance.pending[0]?.amount,
            livemode: balance.livemode,
          },
        };
      }

      case 'paypal': {
        const paypal = require('@paypal/checkout-server-sdk');

        let environment;
        if (config.paypalConfig.environment === 'production') {
          environment = new paypal.core.LiveEnvironment(
            config.paypalConfig.clientId,
            config.paypalConfig.clientSecret,
          );
        } else {
          environment = new paypal.core.SandboxEnvironment(
            config.paypalConfig.clientId,
            config.paypalConfig.clientSecret,
          );
        }

        const client = new paypal.core.PayPalHttpClient(environment);

        // Test by creating a simple access token request
        const request = new paypal.orders.OrdersCreateRequest();
        request.requestBody({
          intent: 'CAPTURE',
          purchase_units: [
            {
              amount: {
                currency_code: config.settings?.currency || 'USD',
                value: '1.00',
              },
            },
          ],
        });

        // This will test authentication
        await client.execute(request);

        return {
          success: true,
          message: 'PayPal connection successful',
          details: {
            environment: config.paypalConfig.environment,
            currency: config.settings?.currency || 'USD',
          },
        };
      }

      default:
        return {
          success: false,
          message: `Unsupported payment system: ${paymentSystem}`,
          error: `Unsupported payment system: ${paymentSystem}`,
        };
    }
  } catch (error) {
    console.error(
      `Payment configuration test failed for ${paymentSystem}:`,
      error,
    );
    return {
      success: false,
      message: `Connection failed: ${error.message}`,
      error: error.message,
      details: error.response?.data || error,
    };
  }
}

module.exports = router;
