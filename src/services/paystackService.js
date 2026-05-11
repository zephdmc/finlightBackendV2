// backend/src/services/paystackService.js
const axios = require('axios');
const { getPaystackSubaccount, getPaystackConfig } = require('./organizationService');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const paystackApi = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Initialize a payment transaction with dynamic subaccount routing
 * @param {Object} params - Payment parameters
 * @param {string} params.email - Customer email
 * @param {number} params.amount - Amount in Naira (will be converted to kobo)
 * @param {string} params.organizationId - Organization ID (used to fetch subaccount)
 * @param {string} [params.reference] - Optional transaction reference (auto-generated if omitted)
 * @param {Object} [params.metadata] - Additional metadata (e.g., userId, purpose)
 * @returns {Promise<Object>} Paystack initialization response (contains authorization_url, reference)
 */
exports.initializePayment = async ({ email, amount, organizationId, reference, metadata = {} }) => {
  try {
    // Get the organization's Paystack subaccount code
    const subaccount = await getPaystackSubaccount(organizationId);
    
    // Convert amount to kobo (Paystack uses lowest currency unit)
    const amountInKobo = amount * 100;
    
    // Prepare request payload
    const payload = {
      email,
      amount: amountInKobo,
      subaccount,                     // Dynamic subaccount per organization
      metadata: {
        ...metadata,
        organizationId: organizationId.toString()  // Store for webhook handling
      },
      callback_url: `${process.env.FRONTEND_URL}/payment/callback`
    };
    
    // Add reference if provided, otherwise Paystack will generate one
    if (reference) {
      payload.reference = reference;
    }
    
    const response = await paystackApi.post('/transaction/initialize', payload);
    return response.data;
  } catch (error) {
    console.error('Paystack initialization error:', error.response?.data || error.message);
    throw new Error('Payment initialization failed: ' + (error.response?.data?.message || error.message));
  }
};

/**
 * Verify a payment transaction
 * @param {string} reference - Transaction reference from Paystack
 * @returns {Promise<Object>} Verification response
 */
exports.verifyPayment = async (reference) => {
  try {
    const response = await paystackApi.get(`/transaction/verify/${reference}`);
    return response.data;
  } catch (error) {
    console.error('Paystack verification error:', error.response?.data || error.message);
    throw new Error('Payment verification failed');
  }
};

/**
 * Optional: Create a subaccount for a new organization (admin only)
 * @param {Object} params - Subaccount details
 * @param {string} params.business_name - Organization name
 * @param {string} params.settlement_bank - Bank code (e.g., '058' for GTBank)
 * @param {string} params.account_number - Bank account number
 * @param {number} [params.percentage_charge] - Optional split percentage (0-100)
 * @returns {Promise<Object>} Created subaccount data
 */
exports.createSubaccount = async ({ business_name, settlement_bank, account_number, percentage_charge = 0 }) => {
  try {
    const response = await paystackApi.post('/subaccount', {
      business_name,
      settlement_bank,
      account_number,
      percentage_charge
    });
    return response.data;
  } catch (error) {
    console.error('Paystack subaccount creation error:', error.response?.data || error.message);
    throw new Error('Subaccount creation failed');
  }
};