const axios = require('axios');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const paystackApi = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Initialize payment
exports.initializePayment = async (paymentData) => {
  try {
    const response = await paystackApi.post('/transaction/initialize', {
      email: paymentData.email,
      amount: paymentData.amount,
      reference: paymentData.reference,
      metadata: paymentData.metadata,
      callback_url: `${process.env.FRONTEND_URL}/payment/callback`
    });
    
    return response.data;
  } catch (error) {
    console.error('Paystack initialization error:', error.response?.data || error.message);
    throw new Error('Payment initialization failed');
  }
};

// Verify payment
exports.verifyPayment = async (reference) => {
  try {
    const response = await paystackApi.get(`/transaction/verify/${reference}`);
    return response.data;
  } catch (error) {
    console.error('Paystack verification error:', error.response?.data || error.message);
    throw new Error('Payment verification failed');
  }
};