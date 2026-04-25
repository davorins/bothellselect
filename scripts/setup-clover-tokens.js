// scripts/setup-clover-tokens.js
const mongoose = require('mongoose');
const axios = require('axios');
const PaymentConfiguration = require('../models/PaymentConfiguration');
require('dotenv').config();

// Get the redirect URI from environment or use default
const REDIRECT_URI =
  process.env.CLOVER_REDIRECT_URI || 'http://localhost:5001/callback';

async function setupCloverTokens() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if Clover configuration exists
    let config = await PaymentConfiguration.findOne({
      paymentSystem: 'clover',
      isActive: true,
    });

    // If no config exists, create one
    if (!config) {
      console.log('⚠️ No active Clover configuration found. Creating one...');

      const newConfig = new PaymentConfiguration({
        paymentSystem: 'clover',
        isActive: true,
        isDefault: true,
        cloverConfig: {
          merchantId: process.env.CLOVER_MERCHANT_ID || '',
          environment: 'production',
          apiBaseUrl: 'https://api.clover.com/v3',
        },
        settings: {
          currency: 'USD',
          taxRate: 0,
          enableAutomaticRefunds: true,
          enablePartialRefunds: true,
          defaultPaymentDescription: 'Payment for services',
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      config = await newConfig.save();
      console.log('✅ Created new Clover configuration with ID:', config._id);
    }

    console.log('✅ Found Clover configuration:', {
      id: config._id,
      merchantId: config.cloverConfig?.merchantId,
      hasAccessToken: !!config.cloverConfig?.accessToken,
      environment: config.cloverConfig?.environment,
    });

    // Get OAuth credentials from environment
    const clientId = process.env.CLOVER_CLIENT_ID;
    const clientSecret = process.env.CLOVER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error(
        '❌ Missing CLOVER_CLIENT_ID or CLOVER_CLIENT_SECRET in environment variables',
      );
      console.log(
        'Please add these to your Render environment variables or .env file',
      );
      process.exit(1);
    }

    // Determine URLs based on environment
    const environment = config.cloverConfig?.environment || 'production';

    // Build the Auth URL with redirect_uri parameter (THIS IS THE KEY FIX)
    const authUrl =
      environment === 'production'
        ? `https://www.clover.com/oauth/v2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
        : `https://sandbox.dev.clover.com/oauth/v2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const apiUrl =
      environment === 'production'
        ? 'https://api.clover.com'
        : 'https://apisandbox.dev.clover.com';

    console.log('\n' + '='.repeat(60));
    console.log('🔑 CLOVER OAUTH SETUP');
    console.log('='.repeat(60));
    console.log(`Environment: ${environment.toUpperCase()}`);
    console.log(`Redirect URI: ${REDIRECT_URI}`);
    console.log(`Auth URL: ${authUrl}`);
    console.log(`API URL: ${apiUrl}`);
    console.log('\n📝 FOLLOW THESE STEPS:');
    console.log('1. Open the Auth URL in your browser');
    console.log('2. Log in to your Clover account');
    console.log('3. Approve the app permissions');
    console.log('4. After redirect, look at the URL in your browser');
    console.log(
      '5. Find the "code" parameter (it looks like: ?code=abc123xyz...)',
    );
    console.log('6. Copy ONLY the code value (not the whole URL)');
    console.log('='.repeat(60) + '\n');

    // Ask for authorization code
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const getCode = () => {
      return new Promise((resolve) => {
        readline.question('📋 Paste the authorization code here: ', (code) => {
          resolve(code.trim());
        });
      });
    };

    const authorizationCode = await getCode();

    if (!authorizationCode) {
      console.error('❌ No authorization code provided');
      readline.close();
      process.exit(1);
    }

    console.log('\n🔄 Exchanging authorization code for tokens...');

    try {
      // Exchange code for tokens
      const response = await axios.post(
        `${apiUrl}/oauth/v2/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          code: authorizationCode,
          redirect_uri: REDIRECT_URI, // Required for token exchange too
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const { access_token, refresh_token, expires_in } = response.data;
      const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

      console.log('\n✅ Tokens received successfully!');
      console.log('='.repeat(60));
      console.log('ACCESS_TOKEN:', access_token);
      console.log('REFRESH_TOKEN:', refresh_token);
      console.log('EXPIRES_IN:', expires_in, 'seconds');
      console.log('EXPIRES_IN:', Math.floor(expires_in / 3600), 'hours');
      console.log('EXPIRES_AT:', new Date(expiresAt * 1000).toISOString());
      console.log('='.repeat(60));

      // Update the payment configuration with tokens
      console.log('\n💾 Updating database with tokens...');

      const updateResult = await PaymentConfiguration.updateOne(
        { _id: config._id },
        {
          $set: {
            'cloverConfig.accessToken': access_token,
            'cloverConfig.refreshToken': refresh_token,
            'cloverConfig.tokenExpiresAt': expiresAt,
            'cloverConfig.merchantId':
              process.env.CLOVER_MERCHANT_ID || config.cloverConfig?.merchantId,
            'cloverConfig.environment': environment,
            updatedAt: new Date(),
          },
        },
      );

      if (updateResult.modifiedCount > 0) {
        console.log('✅ Database updated successfully!');

        console.log('\n🎉 SETUP COMPLETE!');
        console.log('='.repeat(60));
        console.log('Your Clover integration is ready with:');
        console.log('  ✅ OAuth tokens (auto-refreshing)');
        console.log('  ✅ Merchant ID');
        console.log(
          '\n📋 IMPORTANT: You still need to add your Ecommerce API keys to .env:',
        );
        console.log(
          '  CLOVER_ECOMMERCE_PUBLIC_KEY=your_public_key_from_merchant_dashboard',
        );
        console.log(
          '  CLOVER_ECOMMERCE_PRIVATE_KEY=your_private_key_from_merchant_dashboard',
        );
        console.log('\n📍 Where to get Ecommerce keys:');
        console.log('  1. Go to your Merchant Dashboard');
        console.log('  2. Settings → Ecommerce API Tokens');
        console.log('  3. Create a new API token');
        console.log('  4. Copy the Public and Private keys');
        console.log('='.repeat(60));
      } else if (updateResult.matchedCount > 0) {
        console.log(
          '⚠️ Configuration matched but not modified (tokens may be the same)',
        );
      } else {
        console.log('❌ No configuration found to update');
      }
    } catch (error) {
      console.error('\n❌ Failed to exchange authorization code:');
      if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Data:', error.response.data);

        if (
          error.response.status === 400 &&
          error.response.data.includes('redirect_uri')
        ) {
          console.error(
            "\n💡 Tip: Make sure the redirect_uri matches exactly what's in your Clover app settings.",
          );
          console.log(`Your configured Site URL should be: ${REDIRECT_URI}`);
        }
      } else {
        console.error('Error:', error.message);
      }
      process.exit(1);
    }

    readline.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the setup
setupCloverTokens();
