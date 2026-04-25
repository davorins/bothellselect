// backend/services/cloverTokenManager.js
const axios = require('axios');
const PaymentConfiguration = require('../models/PaymentConfiguration');

class CloverTokenManager {
  /**
   * Get a valid access token (auto-refresh if expired)
   */
  async getValidAccessToken(configId) {
    try {
      const config = await PaymentConfiguration.findById(configId).select(
        '+cloverConfig.refreshToken +cloverConfig.accessToken',
      );

      if (!config || config.paymentSystem !== 'clover') {
        throw new Error('Invalid Clover configuration');
      }

      const { cloverConfig } = config;
      const now = Math.floor(Date.now() / 1000); // Current Unix timestamp in seconds
      const expiresAt = cloverConfig.tokenExpiresAt;

      // Check if token is expired or will expire in next 5 minutes (300 seconds)
      const needsRefresh = !expiresAt || expiresAt - now < 300;

      if (needsRefresh) {
        console.log('🔄 Token expired or expiring soon, refreshing...');
        return await this.refreshToken(configId);
      }

      console.log('✅ Token valid for another', expiresAt - now, 'seconds');
      return cloverConfig.accessToken;
    } catch (error) {
      console.error('Error getting Clover token:', error);
      throw error;
    }
  }

  /**
   * Refresh the token pair using refresh_token
   * Following Clover's OAuth v2 spec
   */
  async refreshToken(configId) {
    try {
      const config = await PaymentConfiguration.findById(configId).select(
        '+cloverConfig.refreshToken',
      );

      if (!config) {
        throw new Error('Configuration not found');
      }

      const { cloverConfig, _id } = config;

      // Determine the correct API URL based on environment
      const apiUrl =
        cloverConfig.environment === 'production'
          ? 'https://api.clover.com'
          : 'https://apisandbox.dev.clover.com';

      // Get client credentials from environment variables
      const clientId = process.env.CLOVER_CLIENT_ID;
      const clientSecret = process.env.CLOVER_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error(
          'CLOVER_CLIENT_ID and CLOVER_CLIENT_SECRET must be set in environment',
        );
      }

      if (!cloverConfig.refreshToken) {
        throw new Error('No refresh token available. Need to re-authenticate.');
      }

      console.log('🔄 Refreshing token pair...');
      console.log('📍 URL:', `${apiUrl}/oauth/v2/refresh`);

      // Make the refresh request as per Clover documentation
      const response = await axios.post(
        `${apiUrl}/oauth/v2/refresh`,
        {
          client_id: clientId,
          refresh_token: cloverConfig.refreshToken,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      // Response contains new access_token, refresh_token, and expires_in
      const { access_token, refresh_token, expires_in } = response.data;

      // Calculate expiration as Unix timestamp (seconds since epoch)
      const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

      console.log('✅ Token refresh successful!');
      console.log('📅 New token expires in:', expires_in, 'seconds');
      console.log('📅 Expires at Unix timestamp:', expiresAt);
      console.log('📅 Expires at:', new Date(expiresAt * 1000).toISOString());

      // Update database with new tokens
      await PaymentConfiguration.findByIdAndUpdate(_id, {
        'cloverConfig.accessToken': access_token,
        'cloverConfig.refreshToken': refresh_token,
        'cloverConfig.tokenExpiresAt': expiresAt,
        updatedAt: new Date(),
      });

      return access_token;
    } catch (error) {
      console.error('❌ Token refresh failed:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      // If refresh fails, we need to re-authenticate
      throw new Error(
        'Clover token refresh failed. Please re-authenticate the app.',
      );
    }
  }

  /**
   * Initial token setup using authorization code
   * This is a one-time setup to get the first token pair
   */
  async setupInitialTokens(configId, authorizationCode) {
    try {
      const config = await PaymentConfiguration.findById(configId);

      if (!config) {
        throw new Error('Configuration not found');
      }

      const { cloverConfig } = config;

      const apiUrl =
        cloverConfig.environment === 'production'
          ? 'https://api.clover.com'
          : 'https://apisandbox.dev.clover.com';

      const clientId = process.env.CLOVER_CLIENT_ID;
      const clientSecret = process.env.CLOVER_CLIENT_SECRET;

      console.log('🔄 Setting up initial tokens...');

      const response = await axios.post(
        `${apiUrl}/oauth/v2/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          code: authorizationCode,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const { access_token, refresh_token, expires_in } = response.data;
      const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

      await PaymentConfiguration.findByIdAndUpdate(configId, {
        'cloverConfig.accessToken': access_token,
        'cloverConfig.refreshToken': refresh_token,
        'cloverConfig.tokenExpiresAt': expiresAt,
        updatedAt: new Date(),
      });

      console.log('✅ Initial tokens setup complete');
      return { access_token, refresh_token, expiresAt };
    } catch (error) {
      console.error(
        'Failed to setup initial tokens:',
        error.response?.data || error.message,
      );
      throw error;
    }
  }
}

module.exports = new CloverTokenManager();
