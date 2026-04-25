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
      paymentSystem: paymentSystem || { $exists: true },
    };

    if (paymentSystem) {
      query.paymentSystem = paymentSystem;
    }

    console.log('Querying PaymentConfiguration with:', query);

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
      cloverAccessToken:
        config?.cloverConfig?.accessToken?.substring(0, 10) + '...',
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
        console.log('Square processPayment called with config:', {
          locationId: this.config.locationId,
          hasAccessToken: !!this.config.accessToken,
        });

        const { paymentsApi } = this.client;
        const paymentRequest = {
          idempotencyKey: `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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

        console.log('Square payment request:', {
          amount: paymentRequest.amountMoney.amount,
          locationId: paymentRequest.locationId,
          hasLocationId: !!paymentRequest.locationId,
        });

        const { result } = await paymentsApi.createPayment(paymentRequest);
        return result.payment;
      },

      async refundPayment(paymentId, amount, reason) {
        const { refundsApi } = this.client;
        const refundRequest = {
          idempotencyKey: `refund_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          paymentId,
          amountMoney: {
            amount,
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
        ? 'https://api.clover.com'
        : 'https://scl-sandbox.dev.clover.com';

    console.log('✅ Using Clover Ecommerce API at:', ecomBase);

    // Check if using Ecommerce API key (starts with sk_) vs OAuth token
    const accessToken = config.cloverConfig?.accessToken;
    const isEcommerceKey = accessToken && !config.cloverConfig?.refreshToken;

    if (isEcommerceKey) {
      console.log(
        '✅ Detected Ecommerce API key (sk_) - using direct authentication',
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

          const response = await axios.post(
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
            },
          );

          const result = response.data;

          // Log full response so we can see exact shape
          console.log(
            '🔍 Clover raw charge response:',
            JSON.stringify(result, null, 2),
          );

          // Clover /v1/charges returns { paid: true, id: "..." }
          // NOT { status: "succeeded" } — that's Stripe's shape
          const isPaid = result.paid === true || result.status === 'succeeded';

          return {
            id: result.id,
            status: isPaid ? 'PAID' : 'UNKNOWN',
            amount: result.amount,
            currency: result.currency,
            receiptUrl:
              result.receipt_url ||
              `https://www.clover.com/receipt/${result.id}`,
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

        async refundPayment(paymentId, amount, reason) {
          console.log('🔄 Processing Clover refund:', { paymentId, amount });

          const privateKey = this.config.accessToken;

          const response = await axios.post(
            `${this.ecomBase}/v1/refunds`,
            {
              charge: paymentId,
              amount: amount,
              reason: reason || 'requested_by_customer',
            },
            {
              headers: {
                Authorization: `Bearer ${privateKey}`,
                'Content-Type': 'application/json',
              },
            },
          );

          return response.data;
        },

        async getPaymentDetails(paymentId) {
          console.log('🔍 Getting Clover payment details:', paymentId);

          const privateKey = this.config.accessToken;

          const response = await axios.get(
            `${this.ecomBase}/v1/payments/${paymentId}`,
            {
              headers: {
                Authorization: `Bearer ${privateKey}`,
                'Content-Type': 'application/json',
              },
            },
          );

          return response.data;
        },
      };
    }

    // Original OAuth flow for non-Ecommerce keys (keep as fallback)
    console.log('Using OAuth token flow (non-Ecommerce key)');

    return {
      type: 'clover',
      config: config.cloverConfig,
      settings: config.settings,
      configuration: config,
      configurationId: config._id,
      ecomBase,

      async processPayment(paymentData) {
        console.log('💰 Processing Clover charge:', {
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
          console.log('✅ Got valid Clover token');
        } catch (tokenError) {
          console.error(
            '❌ Failed to get valid Clover token:',
            tokenError.message,
          );
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        const response = await axios.post(
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

        const result = response.data;

        console.log('✅ Clover payment result:', {
          id: result.id,
          paid: result.paid,
          status: result.status,
        });

        return {
          id: result.id,
          status: result.paid ? 'PAID' : result.status || 'UNKNOWN',
          amount: result.amount,
          currency: result.currency,
          orderId: result.order?.id || result.id,
          receiptUrl:
            result.receipt_url || `https://www.clover.com/receipt/${result.id}`,
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

      async refundPayment(paymentId, amount, reason) {
        console.log('🔄 Processing Clover refund:', { paymentId, amount });

        let validToken;
        try {
          validToken = await cloverTokenManager.getValidAccessToken(
            this.configurationId,
          );
        } catch (tokenError) {
          console.error(
            '❌ Failed to get valid Clover token for refund:',
            tokenError.message,
          );
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        const response = await axios.post(
          `${this.ecomBase}/v1/refunds`,
          {
            charge: paymentId,
            amount: amount,
            reason: reason || 'requested_by_customer',
          },
          {
            headers: {
              Authorization: `Bearer ${validToken}`,
              'Content-Type': 'application/json',
            },
          },
        );

        return response.data;
      },

      async getPaymentDetails(paymentId) {
        console.log('🔍 Getting Clover payment details:', paymentId);

        let validToken;
        try {
          validToken = await cloverTokenManager.getValidAccessToken(
            this.configurationId,
          );
        } catch (tokenError) {
          console.error(
            '❌ Failed to get valid Clover token for details:',
            tokenError.message,
          );
          throw new Error(
            'Clover authentication failed. Please check configuration.',
          );
        }

        const response = await axios.get(
          `${this.ecomBase}/v1/payments/${paymentId}`,
          {
            headers: {
              Authorization: `Bearer ${validToken}`,
              'Content-Type': 'application/json',
            },
          },
        );

        return response.data;
      },
    };
  }

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

      async refundPayment(paymentId, amount, reason) {
        const refund = await stripe.refunds.create({
          payment_intent: paymentId,
          amount,
          reason,
        });
        return refund;
      },

      async getPaymentDetails(paymentId) {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentId);
        return paymentIntent;
      },
    };
  }

  createPaypalService(config) {
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

      async refundPayment(captureId, amount, reason) {
        const request = new paypal.payments.CapturesRefundRequest(captureId);
        request.requestBody({
          amount: {
            currency_code: this.settings.currency || 'USD',
            value: (amount / 100).toFixed(2),
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
