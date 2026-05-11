// backend/src/controllers/webhookController.js
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const User = require('../models/User');

/**
 * Helper: handle partial payment (used internally)
 */
const handlePartialPayment = async (originalPayment, amountPaid, reference) => {
  const expectedAmount = originalPayment.expectedAmount || originalPayment.amount;
  const remainingAmount = expectedAmount - amountPaid;

  // Update original payment as partial
  originalPayment.paidAmount = amountPaid;
  originalPayment.remainingAmount = remainingAmount;
  originalPayment.isPartial = true;
  originalPayment.status = 'partial';
  originalPayment.paidAt = new Date();
  originalPayment.transactionReference = reference;
  await originalPayment.save();

  // Create outstanding payment record for remaining amount (same organization)
  const outstandingPayment = await Payment.create({
    user: originalPayment.user,
    name: `${originalPayment.name} (Outstanding Balance)`,
    type: originalPayment.type,
    amount: remainingAmount,
    expectedAmount: remainingAmount,
    paidAmount: 0,
    remainingAmount: remainingAmount,
    isPartial: false,
    parentPaymentId: originalPayment._id,
    paymentTypeId: originalPayment.paymentTypeId,
    organizationId: originalPayment.organizationId,
    description: `Remaining balance of ₦${remainingAmount.toLocaleString()} for ${originalPayment.name}`,
    status: 'unpaid',
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  });

  return {
    isPartial: true,
    paidAmount: amountPaid,
    remainingAmount: remainingAmount,
    outstandingPayment
  };
};

/**
 * @desc    Webhook handler for Paystack events (charge.success)
 * @route   POST /api/webhook/paystack
 * @access  Public (verified by signature)
 */
exports.handlePaystackWebhook = async (req, res, next) => {
  try {
    const event = req.body;

    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      // Invalid signature – return 200 anyway to prevent Paystack from retrying (by convention)
      return res.status(200).json({ success: false, message: 'Invalid signature' });
    }

    // Only handle successful charge events
    if (event.event !== 'charge.success') {
      return res.status(200).json({ success: true });
    }

    const { reference, amount, metadata } = event.data;
    const amountPaid = amount / 100;
    const organizationId = metadata?.organizationId;

    // Find payment by transaction reference, optionally scoped by organizationId
    let payment = await Payment.findOne({ transactionReference: reference });
    if (!payment && organizationId) {
      payment = await Payment.findOne({ transactionReference: reference, organizationId });
    }

    // Last resort: try to match a pending payment pattern
    if (!payment) {
      payment = await Payment.findOne({
        transactionReference: { $regex: `PENDING-.*${reference.substring(0, 10)}` }
      });
    }

    if (!payment) {
      // No matching payment found – log and acknowledge
      console.warn(`Webhook: No payment found for reference ${reference}`);
      return res.status(200).json({ success: true });
    }

    // Avoid double processing
    if (payment.status === 'paid' || payment.status === 'partial') {
      return res.status(200).json({ success: true });
    }

    const expectedAmount = payment.expectedAmount || payment.amount;

    // Handle partial payment
    if (amountPaid < expectedAmount) {
      await handlePartialPayment(payment, amountPaid, reference);

      await Income.create({
        amount: amountPaid,
        source: `${payment.type} - ${payment.description || 'Payment'} (Partial)`,
        date: new Date(),
        description: `Partial payment of ₦${amountPaid.toLocaleString()} for ${payment.name}. Remaining: ₦${(expectedAmount - amountPaid).toLocaleString()}`,
        paymentId: payment._id,
        paymentType: payment.type,
        userId: payment.user,
        organizationId: payment.organizationId,
        transactionReference: reference,
        isPartial: true
      });

      console.log(`Partial payment processed. Remaining: ${expectedAmount - amountPaid}`);
    } else {
      // Full payment
      payment.status = 'paid';
      payment.paidAmount = amountPaid;
      payment.remainingAmount = 0;
      payment.paidAt = new Date();
      payment.transactionReference = reference;
      await payment.save();

      await Income.create({
        amount: payment.amount,
        source: `${payment.type} - ${payment.description || 'Payment'}`,
        date: new Date(),
        description: payment.description || `${payment.type} payment via Paystack`,
        paymentId: payment._id,
        paymentType: payment.type,
        userId: payment.user,
        organizationId: payment.organizationId,
        transactionReference: reference
      });

      console.log(`Full payment processed for ${payment._id}`);
    }

    // If this was a registration payment, update user's registration status
    if (payment.type === 'registration') {
      await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    // Always return 200 to avoid Paystack retries
    res.status(200).json({ success: false, message: 'Webhook processed with error' });
  }
};