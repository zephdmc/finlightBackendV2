const axios = require('axios');

/**
 * Paystack Payment Gateway Configuration
 * Handles all Paystack API interactions with retry logic and error handling
 */
class PaystackConfig {
  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY;
    this.publicKey = process.env.PAYSTACK_PUBLIC_KEY;
    this.baseURL = process.env.NODE_ENV === 'production' 
      ? 'https://api.paystack.co'
      : 'https://api.paystack.co';
    
    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      timeout: 30000 // 30 seconds timeout
    });

    // Add response interceptor for error handling
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          console.error('Paystack API Error:', {
            status: error.response.status,
            data: error.response.data,
            headers: error.response.headers
          });
          
          // Enhance error message
          const enhancedError = new Error(
            error.response.data.message || 'Paystack API request failed'
          );
          enhancedError.statusCode = error.response.status;
          enhancedError.data = error.response.data;
          throw enhancedError;
        } else if (error.request) {
          // The request was made but no response was received
          console.error('Paystack API No Response:', error.request);
          throw new Error('No response from Paystack. Please check your network connection.');
        } else {
          // Something happened in setting up the request
          console.error('Paystack API Request Error:', error.message);
          throw error;
        }
      }
    );
  }

  /**
   * Initialize a transaction
   * @param {Object} paymentData - Payment details
   * @returns {Promise<Object>} - Paystack response
   */
  async initializeTransaction(paymentData) {
    try {
      const response = await this.axiosInstance.post('/transaction/initialize', {
        email: paymentData.email,
        amount: paymentData.amount, // Amount in kobo
        reference: paymentData.reference,
        metadata: paymentData.metadata,
        callback_url: paymentData.callbackUrl || `${process.env.FRONTEND_URL}/payment/callback`,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
      });

      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Verify a transaction
   * @param {string} reference - Transaction reference
   * @returns {Promise<Object>} - Verification result
   */
  async verifyTransaction(reference) {
    try {
      const response = await this.axiosInstance.get(`/transaction/verify/${reference}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * List all transactions (for admin reports)
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} - List of transactions
   */
  async listTransactions(params = {}) {
    try {
      const response = await this.axiosInstance.get('/transaction', { params });
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Get transaction details
   * @param {string} id - Transaction ID
   * @returns {Promise<Object>} - Transaction details
   */
  async getTransaction(id) {
    try {
      const response = await this.axiosInstance.get(`/transaction/${id}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Create a refund
   * @param {Object} refundData - Refund details
   * @returns {Promise<Object>} - Refund response
   */
  async createRefund(refundData) {
    try {
      const response = await this.axiosInstance.post('/refund', {
        transaction: refundData.transactionId,
        amount: refundData.amount,
        currency: 'NGN',
        customer_note: refundData.reason
      });
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Handle Paystack errors
   * @param {Error} error - Error object
   * @returns {Error} - Enhanced error
   */
  handleError(error) {
    if (error.statusCode === 401) {
      return new Error('Invalid Paystack secret key. Please check your configuration.');
    }
    if (error.statusCode === 402) {
      return new Error('Payment failed. Please verify the transaction details.');
    }
    if (error.statusCode === 422) {
      return new Error('Invalid payment parameters. Please check your input.');
    }
    return error;
  }

  /**
   * Generate a unique transaction reference
   * @param {string} prefix - Optional prefix
   * @returns {string} - Unique reference
   */
  generateReference(prefix = 'PAY') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${prefix}_${timestamp}_${random}`;
  }

  /**
   * Format amount for Paystack (convert to kobo)
   * @param {number} amount - Amount in Naira
   * @returns {number} - Amount in kobo
   */
  formatAmount(amount) {
    return Math.round(amount * 100);
  }

  /**
   * Check if webhook signature is valid
   * @param {string} signature - Paystack signature header
   * @param {string} payload - Raw request body
   * @returns {boolean} - Whether signature is valid
   */
  verifyWebhookSignature(signature, payload) {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');
    
    return hash === signature;
  }
}

module.exports = new PaystackConfig();