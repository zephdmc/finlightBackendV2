// src/services/paymentService.js
// Wrapper around Flutterwave checkout with mock mode support

export const PAYMENT_MODE = import.meta.env.VITE_PAYMENT_MODE || 'live';

/**
 * Initialize a payment. In mock mode, simulates success without calling Flutterwave.
 * @param {Object} options - Standard FlutterwaveCheckout options
 * @param {Function} navigate - React Router navigate function
 */
export const initiatePayment = (options, navigate) => {
    if (PAYMENT_MODE === 'mock') {
        console.log('[MOCK PAYMENT] Simulating successful payment:', options);
        // Optional: show a toast if you have toast imported
        // toast.success('Test payment — simulating success');

        const txRef = options.tx_ref || `MOCK-${Date.now()}`;
        setTimeout(() => {
            navigate(
                `/payment/callback?status=successful&tx_ref=${encodeURIComponent(txRef)}&transaction_id=MOCK_${Date.now()}&mock=true`,
                { replace: false }
            );
        }, 1200);
        return;
    }

    // REAL MODE — unchanged from your current setup
    // Assumes window.FlutterwaveCheckout is loaded via index.html script tag
    if (typeof window.FlutterwaveCheckout !== 'function') {
        console.error('FlutterwaveCheckout not loaded');
        return;
    }
    window.FlutterwaveCheckout(options);
};