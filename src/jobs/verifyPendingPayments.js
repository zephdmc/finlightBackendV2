const cron = require('node-cron');
const Payment = require('../models/Payment');
const axios = require('axios');

// Your backend URL (use environment variable)
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

const verifyPendingPayments = async () => {

  // Consider only payments older than 10 minutes to give webhook time
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);


  const pendingPayments = await Payment.find({
    status: 'pending',
    transactionReference: { $exists: true, $ne: null }, // Also catches PENDING-...
    createdAt: { $lt: cutoff }
  }).limit(50);

  if (pendingPayments.length === 0) {
        return;
  }


  for (const payment of pendingPayments) {
    try {
      // Call your own verify endpoint (internal call)
      const verifyUrl = `${BACKEND_URL}/api/payment-gateway/verify/${payment.transactionReference}`;
      const response = await axios.get(verifyUrl, {
        timeout: 15000,
        // If your verify endpoint requires authentication, add an internal API key header
        // headers: { 'x-internal-key': process.env.INTERNAL_API_KEY }
      });

          } catch (error) {
      console.error(`❌ Verification failed for ${payment._id}:`, error.message);
      // Log more details if needed
    }
  }
};

// Schedule the job: run every 10 minutes
cron.schedule('*/10 * * * *', verifyPendingPayments);


// Export for manual triggering (optional)
module.exports = { verifyPendingPayments };
