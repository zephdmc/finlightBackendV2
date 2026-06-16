const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const Flutterwave = require('flutterwave-node-v3');

const flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);

// Get the underlying axios instance used by flutterwave-node-v3 (hacky but works)
const flwAxios = flw.Payment.constructor.axiosInstance || axios.create();
axiosRetry(flwAxios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    // Retry on network errors or 5xx responses
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
           (error.response && error.response.status >= 500);
  },
  onRetry: (retryCount, error, requestConfig) => {
    console.log(`Retrying Flutterwave request (${retryCount}/3): ${error.message}`);
  }
});

// Re‑assign the patched instance (depends on flutterwave-node-v3 internal)
// Alternative: create your own axios instance and pass to Flutterwave constructor? Not supported.
// Simpler: use the `flw` object as is, but wrap critical calls with manual retry.
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.response?.status >= 500 || error.code === 'ECONNRESET';
      if (!isRetryable) throw error;
      const delay = Math.pow(2, i) * 1000;
      console.log(`Flutterwave call failed, retrying in ${delay}ms... (${i+1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Use it in routes:
const response = await withRetry(() => flw.Payment.initiate(payload));