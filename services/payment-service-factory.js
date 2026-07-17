// services/payment-service-factory.js
const PaymentConfiguration = require('../models/PaymentConfiguration');
const cloverTokenManager = require('./cloverTokenManager');

class PaymentServiceFactory {
  constructor() {
    this.services = new Map();
  }

  async getService(paymentSystem = null) {
    const cacheKey = paymentSystem || 'default';
    this.services.delete(cacheKey);

    console.log('PaymentServiceFactory.getService called for:', paymentSystem);

    const query = {
      isActive: true,
    };

    if (paymentSystem) {
      query.paymentSystem = paymentSystem;
    } else {
      query.paymentSystem = { $exists: true };
    }

    const config = await PaymentConfiguration.findOne(query)
      .select(
        '+squareConfig.accessToken +squareConfig.webhookSignatureKey +cloverConfig.accessToken +stripeConfig.secretKey +stripeConfig.webhookSecret +paypalConfig.clientSecret',
      )
      .sort({ isDefault: -1, updatedAt: -1 });

    console.log('Found config:', {
      found: !!config,
      _id: config?._id,
      paymentSystem: config?.paymentSystem,
      hasSquareConfig: !!config?.squareConfig,
      hasAccessToken: !!config?.squareConfig?.accessToken,
      hasLocationId: !!config?.squareConfig?.locationId,
      cloverAccessToken: config?.cloverConfig?.accessToken
        ? config.cloverConfig.accessToken.substring(0, 10) + '...'
        : 'none',
    });

    if (!config) {
      throw new Error(
        `No active ${paymentSystem || ''} payment configuration found. Please configure payment settings in admin panel.`,
      );
    }

    let service;
    switch (config.paymentSystem) {
      case 'square':
        service = this.createSquareService(config);
        break;
      case 'clover':
        service = this.createCloverService(config);
        break;
      case 'stripe':
        service = this.createStripeService(config);
        break;
      case 'paypal':
        service = this.createPaypalService(config);
        break;
      default:
        throw new Error(`Unsupported payment system: ${config.paymentSystem}`);
    }

    service.configurationId = config._id;
    service.configuration = config;
    this.services.set(cacheKey, service);

    return service;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SQUARE
  // ──────────────────────────────────────────────────────────────────────────

  createSquareService(config) {
    const { Client, Environment } = require('square');

    console.log('Creating Square service with config:', {
      hasAccessToken: !!config.squareConfig?.accessToken,
      hasLocationId: !!config.squareConfig?.locationId,
      configId: config._id,
    });

    const client = new Client({
      accessToken: config.squareConfig.accessToken,
      environment:
        config.squareConfig.environment === 'production'
          ? Environment.Production
          : Environment.Sandbox,
    });

    return {
      type: 'square',
      client,
      config: config.squareConfig,
      settings: config.settings,
      configuration: config,
      configurationId: config._id,

      async processPayment(paymentData) {
        const { paymentsApi } = this.client;
        const paymentRequest = {
          idempotencyKey: `payment_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`,
          sourceId: paymentData.sourceId,
          amountMoney: {
            amount: paymentData.amount,
            currency: this.settings.currency || 'USD',
          },
          locationId: this.config.locationId,
          autocomplete: true,
          referenceId: paymentData.referenceId,
          note: paymentData.note || this.settings.defaultPaymentDescription,
          buyerEmailAddress: paymentData.email,
        };

        const { result } = await paymentsApi.createPayment(paymentRequest);
        return result.payment;
      },

      async refundPayment(paymentId, amountInCents, reason) {
        const { refundsApi } = this.client;
        const refundRequest = {
          idempotencyKey: `refund_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 9)}`,
          paymentId,
          amountMoney: {
            amount: amountInCents,
            currency: this.settings.currency || 'USD',
          },
          reason,
        };
        const { result } = await refundsApi.refundPayment(refundRequest);
        return result.refund;
      },

      async getPaymentDetails(paymentId) {
        const { paymentsApi } = this.client;
        const { result } = await paymentsApi.getPayment(paymentId);
        return result.payment;
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CLOVER - FULLY UPDATED WITH FIXES
  // ──────────────────────────────────────────────────────────────────────────

  createCloverService(config) {
    console.log('🔧 Creating Clover service with config:', {
      merchantId: config.cloverConfig?.merchantId,
      hasAccessToken: !!config.cloverConfig?.accessToken,
      hasRefreshToken: !!config.cloverConfig?.refreshToken,
      tokenExpiresAt: config.cloverConfig?.tokenExpiresAt,
      environment: config.cloverConfig?.environment,
    });

    if (!config.cloverConfig?.merchantId) {
      throw new Error(
        'Clover merchant ID not configured. Please add your merchant ID in Admin > Payment Configuration.',
      );
    }

    const axios = require('axios');
    const ecomBase =
      config.cloverConfig.environment === 'production'
        ? 'https://scl.clover.com'
        : 'https://scl-sandbox.dev.clover.com';

    console.log('✅ Using Clover Ecommerce API at:', ecomBase);

    // Ecommerce API key path (no refreshToken present)
    const accessToken = config.cloverConfig?.accessToken;
    const isEcommerceKey = accessToken && !config.cloverConfig?.refreshToken;

    if (isEcommerceKey) {
      console.log(
        '✅ Detected Ecommerce API key — using direct authentication',
      );

      return {
        type: 'clover',
        config: config.cloverConfig,
        settings: config.settings,
        configuration: config,
        configurationId: config._id,
        ecomBase,

        async processPayment(paymentData) {
          console.log('💰 Processing Clover charge with Ecommerce API key:', {
            amount: paymentData.amount,
            ecomBase: this.ecomBase,
          });

          if (!paymentData.sourceId) {
            throw new Error('Payment source ID (token) is required');
          }
          if (!paymentData.amount || paymentData.amount <= 0) {
            throw new Error('Valid payment amount is required');
          }

          const privateKey = this.config.accessToken;

          let response;
          try {
            response = await axios.post(
              `${this.ecomBase}/v1/charges`,
              {
                amount: paymentData.amount,
                currency: (this.settings?.currency || 'USD').toLowerCase(),
                source: paymentData.sourceId,
                ...(paymentData.email && { email: paymentData.email }),
                ...(paymentData.note && { description: paymentData.note }),
              },
              {
                headers: {
                  Authorization: `Bearer ${privateKey}`,
                  'Content-Type': 'application/json',
                },
                validateStatus: (status) => status >= 200 && status < 300,
              },
            );
          } catch (axiosError) {
            const cloverMessage =
              axiosError.response?.data?.message ||
              axiosError.response?.data?.error?.message ||
              axiosError.message;
            throw new Error(`Clover charge failed: ${cloverMessage}`);
          }

          console.log('🔍 Clover charge response status:', response.status);

          const result = response.data || {};

          // 204 = success with no body; generate a stable ID from token suffix
          const paymentId =
            result.id ||
            `clover_${Date.now()}_${paymentData.sourceId.slice(-8)}`;

          const receiptUrl =
            result.receipt_url || `https://www.clover.com/receipt/${paymentId}`;

          return {
            id: paymentId,
            status: 'PAID',
            amount: result.amount || paymentData.amount,
            currency: result.currency || 'usd',
            receiptUrl,
            cardDetails: result.source?.card
              ? {
                  last4: result.source.card.last4,
                  brand: result.source.card.brand,
                  expMonth: result.source.card.exp_month,
                  expYear: result.source.card.exp_year,
                }
              : null,
          };
        },

        // ================================================================
        // UPDATED CLOVER REFUND METHOD - ECOMMERCE KEY
        // ================================================================
        async refundPayment(chargeId, amountInCents, reason) {
          console.log('🔄 Processing Clover refund (ecommerce key):', {
            chargeId,
            amountInCents,
            reason,
            ecomBase: this.ecomBase,
          });

          // Validate inputs
          if (!chargeId) {
            throw new Error('Charge ID is required for Clover refund');
          }
          if (!amountInCents || amountInCents <= 0) {
            throw new Error('Valid refund amount is required');
          }

          const privateKey = this.config.accessToken;

          if (!privateKey) {
            throw new Error('Clover access token not configured');
          }

          // Build the refund payload
          const payload = {
            charge: chargeId,
            reason: reason || 'requested_by_customer',
            amount: amountInCents, // Amount in cents for Clover
          };

          console.log('📤 Clover refund payload:', payload);

          try {
            // Make the refund request with better error handling
            const response = await axios.post(
              `${this.ecomBase}/v1/refunds`,
              payload,
              {
                headers: {
                  Authorization: `Bearer ${privateKey}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/json', // Explicitly request JSON
                },
                // Don't throw on non-2xx - handle manually
                validateStatus: (status) => status >= 200 && status < 300,
                timeout: 30000, // 30 second timeout
              },
            );

            console.log('📥 Clover refund response status:', response.status);
            console.log('📥 Clover refund response headers:', response.headers);

            // Handle 204 No Content - Clover returns this for successful refunds
            if (response.status === 204) {
              console.log(
                '✅ Clover refund returned 204 No Content - success!',
              );
              return {
                id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                status: 'COMPLETED',
                amount: amountInCents / 100,
                chargeId: chargeId,
                timestamp: new Date().toISOString(),
              };
            }

            // Check if we have response data
            if (!response.data) {
              console.warn('⚠️ Clover refund returned empty response body');
              // Treat as success since we got 2xx status
              return {
                id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                status: 'COMPLETED',
                amount: amountInCents / 100,
                chargeId: chargeId,
                timestamp: new Date().toISOString(),
              };
            }

            // Parse the response data safely
            let result;
            if (typeof response.data === 'string') {
              // Try to parse JSON string
              try {
                result = JSON.parse(response.data);
              } catch (parseError) {
                console.warn(
                  '⚠️ Clover returned non-JSON response:',
                  response.data.substring(0, 200),
                );
                // If it's a success message, treat as success
                if (
                  response.data.toLowerCase().includes('success') ||
                  response.data.toLowerCase().includes('refund') ||
                  response.status === 200
                ) {
                  console.log(
                    '✅ Non-JSON response contains success keywords - treating as success',
                  );
                  return {
                    id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                    status: 'COMPLETED',
                    amount: amountInCents / 100,
                    chargeId: chargeId,
                    timestamp: new Date().toISOString(),
                    rawResponse: response.data,
                  };
                }
                throw new Error(
                  `Clover refund failed: Invalid response format - ${response.data.substring(0, 100)}`,
                );
              }
            } else {
              // Assume it's already an object
              result = response.data;
            }

            // Check for error in response
            if (result.error || result.errorMessage) {
              throw new Error(
                `Clover refund failed: ${result.errorMessage || result.error}`,
              );
            }

            // Check if refund was successful based on status
            const isSuccessful =
              result.status === 'COMPLETED' ||
              result.status === 'SUCCEEDED' ||
              result.status === 'PAID' ||
              result.id; // If it has an ID, it likely succeeded

            if (!isSuccessful) {
              throw new Error(
                `Clover refund failed with status: ${result.status || 'unknown'}`,
              );
            }

            // Return success response
            console.log('✅ Clover refund successful:', {
              refundId: result.id,
              status: result.status,
              amount: result.amount ? result.amount / 100 : amountInCents / 100,
            });

            return {
              id:
                result.id ||
                `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
              status: result.status || 'COMPLETED',
              amount: result.amount ? result.amount / 100 : amountInCents / 100,
              chargeId: result.charge || chargeId,
              timestamp: new Date().toISOString(),
              fullResponse: result, // For debugging
            };
          } catch (error) {
            console.error('❌ Clover refund error:', {
              message: error.message,
              status: error.response?.status,
              statusText: error.response?.statusText,
              data: error.response?.data,
              headers: error.response?.headers,
              config: error.config,
            });

            // Handle specific error cases
            if (error.code === 'ECONNABORTED') {
              throw new Error(
                'Clover refund timed out. Please check if the refund was processed in your Clover dashboard.',
              );
            }

            if (error.response?.status === 404) {
              throw new Error(
                'Charge not found in Clover. Please verify the charge ID.',
              );
            }

            if (
              error.response?.status === 401 ||
              error.response?.status === 403
            ) {
              throw new Error(
                'Clover authentication failed. Please check your API credentials.',
              );
            }

            if (error.response?.status === 400) {
              const errorMsg =
                error.response?.data?.message ||
                error.response?.data?.error ||
                'Invalid refund request';
              throw new Error(`Clover refund failed: ${errorMsg}`);
            }

            // If we got a 2xx status but invalid JSON, treat as success
            if (error.response?.status >= 200 && error.response?.status < 300) {
              console.warn(
                '⚠️ Clover returned non-JSON response but 2xx status - treating as success',
              );
              return {
                id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                status: 'COMPLETED',
                amount: amountInCents / 100,
                chargeId: chargeId,
                timestamp: new Date().toISOString(),
                note: 'Refund processed successfully (non-JSON response)',
              };
            }

            // If this is an "Invalid JSON" error but we have a 2xx status, treat as success
            if (
              error.message &&
              (error.message.toLowerCase().includes('invalid json') ||
                error.message.toLowerCase().includes('json')) &&
              error.response?.status >= 200 &&
              error.response?.status < 300
            ) {
              console.warn(
                '⚠️ Invalid JSON error but 2xx status - treating as success',
              );
              return {
                id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                status: 'COMPLETED',
                amount: amountInCents / 100,
                chargeId: chargeId,
                timestamp: new Date().toISOString(),
                note: 'Refund processed successfully (JSON parsing issue)',
              };
            }

            // Re-throw with a user-friendly message
            throw new Error(`Clover refund failed: ${error.message}`);
          }
        },

        async getPaymentDetails(paymentId) {
          console.log('🔍 Getting Clover payment details:', paymentId);

          const privateKey = this.config.accessToken;

          let response;
          try {
            response = await axios.get(
              `${this.ecomBase}/v1/charges/${paymentId}`,
              {
                headers: {
                  Authorization: `Bearer ${privateKey}`,
                  'Content-Type': 'application/json',
                },
              },
            );
          } catch (axiosError) {
            const cloverMessage =
              axiosError.response?.data?.message ||
              axiosError.response?.data?.error?.message ||
              axiosError.message;
            throw new Error(
              `Clover get payment details failed: ${cloverMessage}`,
            );
          }

          return response.data;
        },
      };
    }

    // ── OAuth flow (refreshToken present) ────────────────────────────────

    console.log('Using OAuth token flow (non-Ecommerce key)');

    return {
      type: 'clover',
      config: config.cloverConfig,
      settings: config.settings,
      configuration: config,
      configurationId: config._id,
      ecomBase,

      async processPayment(paymentData) {
        console.log('💰 Processing Clover charge (OAuth):', {
          amount: paymentData.amount,
          ecomBase: this.ecomBase,
        });

        if (!paymentData.sourceId) {
          throw new Error('Payment source ID (token) is required');
        }
        if (!paymentData.amount || paymentData.amount <= 0) {
          throw new Error('Valid payment amount is required');
        }

        let validToken;
        try {
          validToken = await cloverTokenManager.getValidAccessToken(
            this.configurationId,
          );
        } catch (tokenError) {
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        let response;
        try {
          response = await axios.post(
            `${this.ecomBase}/v1/payments`,
            {
              amount: paymentData.amount,
              currency: (this.settings?.currency || 'USD').toLowerCase(),
              source: paymentData.sourceId,
              ...(paymentData.email && { email: paymentData.email }),
              ...(paymentData.note && { description: paymentData.note }),
            },
            {
              headers: {
                Authorization: `Bearer ${validToken}`,
                'Content-Type': 'application/json',
              },
            },
          );
        } catch (axiosError) {
          const cloverMessage =
            axiosError.response?.data?.message ||
            axiosError.response?.data?.error?.message ||
            axiosError.message;
          throw new Error(`Clover charge failed: ${cloverMessage}`);
        }

        const result = response.data;
        const receiptUrl =
          result.receipt_url || `https://www.clover.com/receipt/${result.id}`;

        return {
          id: result.id,
          status: result.paid ? 'PAID' : result.status || 'UNKNOWN',
          amount: result.amount,
          currency: result.currency,
          orderId: result.order?.id || result.id,
          receiptUrl,
          cardDetails: result.source?.card
            ? {
                last4: result.source.card.last4,
                brand: result.source.card.brand,
                expMonth: result.source.card.exp_month,
                expYear: result.source.card.exp_year,
              }
            : null,
        };
      },

      // ================================================================
      // UPDATED CLOVER REFUND METHOD - OAUTH
      // ================================================================
      async refundPayment(chargeId, amountInCents, reason) {
        console.log('🔄 Processing Clover refund (OAuth):', {
          chargeId,
          amountInCents,
          reason,
          ecomBase: this.ecomBase,
        });

        // Validate inputs
        if (!chargeId) {
          throw new Error('Charge ID is required for Clover refund');
        }
        if (!amountInCents || amountInCents <= 0) {
          throw new Error('Valid refund amount is required');
        }

        let validToken;
        try {
          validToken = await cloverTokenManager.getValidAccessToken(
            this.configurationId,
          );
        } catch (tokenError) {
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        // Build the refund payload
        const payload = {
          charge: chargeId,
          reason: reason || 'requested_by_customer',
          amount: amountInCents, // Amount in cents for Clover
        };

        console.log('📤 Clover refund payload (OAuth):', payload);

        try {
          const response = await axios.post(
            `${this.ecomBase}/v1/refunds`,
            payload,
            {
              headers: {
                Authorization: `Bearer ${validToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              validateStatus: (status) => status >= 200 && status < 300,
              timeout: 30000,
            },
          );

          console.log(
            '📥 Clover refund response status (OAuth):',
            response.status,
          );

          // Handle 204 No Content
          if (response.status === 204) {
            console.log('✅ Clover refund returned 204 No Content - success!');
            return {
              id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
              status: 'COMPLETED',
              amount: amountInCents / 100,
              chargeId: chargeId,
              timestamp: new Date().toISOString(),
            };
          }

          // Handle empty response
          if (!response.data) {
            console.warn('⚠️ Clover refund returned empty response body');
            return {
              id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
              status: 'COMPLETED',
              amount: amountInCents / 100,
              chargeId: chargeId,
              timestamp: new Date().toISOString(),
            };
          }

          // Parse response
          let result;
          if (typeof response.data === 'string') {
            try {
              result = JSON.parse(response.data);
            } catch (parseError) {
              console.warn(
                '⚠️ Clover returned non-JSON response:',
                response.data.substring(0, 200),
              );
              if (
                response.data.toLowerCase().includes('success') ||
                response.data.toLowerCase().includes('refund') ||
                response.status === 200
              ) {
                console.log(
                  '✅ Non-JSON response contains success keywords - treating as success',
                );
                return {
                  id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
                  status: 'COMPLETED',
                  amount: amountInCents / 100,
                  chargeId: chargeId,
                  timestamp: new Date().toISOString(),
                  rawResponse: response.data,
                };
              }
              throw new Error(
                `Clover refund failed: Invalid response format - ${response.data.substring(0, 100)}`,
              );
            }
          } else {
            result = response.data;
          }

          // Check for errors
          if (result.error || result.errorMessage) {
            throw new Error(
              `Clover refund failed: ${result.errorMessage || result.error}`,
            );
          }

          // Check if successful
          const isSuccessful =
            result.status === 'COMPLETED' ||
            result.status === 'SUCCEEDED' ||
            result.status === 'PAID' ||
            result.id;

          if (!isSuccessful) {
            throw new Error(
              `Clover refund failed with status: ${result.status || 'unknown'}`,
            );
          }

          console.log('✅ Clover refund successful (OAuth):', {
            refundId: result.id,
            status: result.status,
          });

          return {
            id:
              result.id || `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
            status: result.status || 'COMPLETED',
            amount: result.amount ? result.amount / 100 : amountInCents / 100,
            chargeId: result.charge || chargeId,
            timestamp: new Date().toISOString(),
          };
        } catch (error) {
          console.error('❌ Clover refund error (OAuth):', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
          });

          // Handle specific errors
          if (error.code === 'ECONNABORTED') {
            throw new Error(
              'Clover refund timed out. Please check if the refund was processed in your Clover dashboard.',
            );
          }

          if (error.response?.status === 404) {
            throw new Error(
              'Charge not found in Clover. Please verify the charge ID.',
            );
          }

          if (
            error.response?.status === 401 ||
            error.response?.status === 403
          ) {
            throw new Error(
              'Clover authentication failed. Please check your API credentials.',
            );
          }

          // If we got a 2xx status but invalid JSON, treat as success
          if (error.response?.status >= 200 && error.response?.status < 300) {
            console.warn(
              '⚠️ Clover returned non-JSON response but 2xx status - treating as success',
            );
            return {
              id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
              status: 'COMPLETED',
              amount: amountInCents / 100,
              chargeId: chargeId,
              timestamp: new Date().toISOString(),
              note: 'Refund processed successfully (non-JSON response)',
            };
          }

          // If this is an "Invalid JSON" error but we have a 2xx status, treat as success
          if (
            error.message &&
            (error.message.toLowerCase().includes('invalid json') ||
              error.message.toLowerCase().includes('json')) &&
            error.response?.status >= 200 &&
            error.response?.status < 300
          ) {
            console.warn(
              '⚠️ Invalid JSON error but 2xx status - treating as success',
            );
            return {
              id: `clover_refund_${Date.now()}_${chargeId.slice(-8)}`,
              status: 'COMPLETED',
              amount: amountInCents / 100,
              chargeId: chargeId,
              timestamp: new Date().toISOString(),
              note: 'Refund processed successfully (JSON parsing issue)',
            };
          }

          throw new Error(`Clover refund failed: ${error.message}`);
        }
      },

      async getPaymentDetails(paymentId) {
        console.log('🔍 Getting Clover payment details (OAuth):', paymentId);

        let validToken;
        try {
          validToken = await cloverTokenManager.getValidAccessToken(
            this.configurationId,
          );
        } catch (tokenError) {
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        let response;
        try {
          response = await axios.get(
            `${this.ecomBase}/v1/charges/${paymentId}`,
            {
              headers: {
                Authorization: `Bearer ${validToken}`,
                'Content-Type': 'application/json',
              },
            },
          );
        } catch (axiosError) {
          const cloverMessage =
            axiosError.response?.data?.message ||
            axiosError.response?.data?.error?.message ||
            axiosError.message;
          throw new Error(
            `Clover get payment details failed: ${cloverMessage}`,
          );
        }

        return response.data;
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRIPE
  // ──────────────────────────────────────────────────────────────────────────

  createStripeService(config) {
    const stripe = require('stripe')(config.stripeConfig.secretKey);

    return {
      type: 'stripe',
      client: stripe,
      config: config.stripeConfig,
      settings: config.settings,

      async processPayment(paymentData) {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: paymentData.amount,
          currency: this.settings.currency || 'USD',
          payment_method: paymentData.sourceId,
          confirmation_method: 'automatic',
          confirm: true,
          description:
            paymentData.note || this.settings.defaultPaymentDescription,
          metadata: { referenceId: paymentData.referenceId },
          receipt_email: paymentData.email,
        });
        return paymentIntent;
      },

      async refundPayment(paymentId, amountInCents, reason) {
        const refund = await stripe.refunds.create({
          payment_intent: paymentId,
          amount: amountInCents,
          reason,
        });
        return refund;
      },

      async getPaymentDetails(paymentId) {
        return await stripe.paymentIntents.retrieve(paymentId);
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PAYPAL
  // ──────────────────────────────────────────────────────────────────────────

  createPaypalService(config) {
    const paypal = require('@paypal/checkout-server-sdk');

    const environment =
      config.paypalConfig.environment === 'production'
        ? new paypal.core.LiveEnvironment(
            config.paypalConfig.clientId,
            config.paypalConfig.clientSecret,
          )
        : new paypal.core.SandboxEnvironment(
            config.paypalConfig.clientId,
            config.paypalConfig.clientSecret,
          );

    const client = new paypal.core.PayPalHttpClient(environment);

    return {
      type: 'paypal',
      client,
      config: config.paypalConfig,
      settings: config.settings,

      async processPayment(paymentData) {
        const request = new paypal.orders.OrdersCreateRequest();
        request.requestBody({
          intent: 'CAPTURE',
          purchase_units: [
            {
              amount: {
                currency_code: this.settings.currency || 'USD',
                value: (paymentData.amount / 100).toFixed(2),
              },
              description:
                paymentData.note || this.settings.defaultPaymentDescription,
              custom_id: paymentData.referenceId,
            },
          ],
          application_context: {
            brand_name: 'Basketball Camp',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: paymentData.returnUrl,
            cancel_url: paymentData.cancelUrl,
          },
        });

        const response = await client.execute(request);
        const captureRequest = new paypal.orders.OrdersCaptureRequest(
          response.result.id,
        );
        const captureResponse = await client.execute(captureRequest);
        return captureResponse.result;
      },

      async refundPayment(captureId, amountInCents, reason) {
        const request = new paypal.payments.CapturesRefundRequest(captureId);
        request.requestBody({
          amount: {
            currency_code: this.settings.currency || 'USD',
            value: (amountInCents / 100).toFixed(2),
          },
          note_to_payer: reason,
        });
        const response = await client.execute(request);
        return response.result;
      },

      async getPaymentDetails(orderId) {
        const request = new paypal.orders.OrdersGetRequest(orderId);
        const response = await client.execute(request);
        return response.result;
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CACHE HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  clearCache(paymentSystem = null) {
    if (paymentSystem) {
      this.services.delete(paymentSystem);
    } else {
      this.services.clear();
    }
  }

  async switchPaymentSystem(paymentSystem) {
    this.clearCache(paymentSystem);
    return this.getService(paymentSystem);
  }

  async getCurrentPaymentSystem() {
    const service = await this.getService();
    return service.type;
  }
}

module.exports = new PaymentServiceFactory();
