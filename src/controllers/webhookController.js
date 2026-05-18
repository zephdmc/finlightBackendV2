// backend/src/controllers/webhookController.js
const crypto = require('crypto');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const User = require('../models/User');
const Organization = require('../models/Organization'); // ✅ ADDED

// ✅ ADDED: Calculate Paystack fee based on Paystack's actual pricing
const calculatePaystackFee = (amount) => {
  const percentage = 1.5; // 1.5%
  const fixedFee = 100; // ₦100 for amounts >= ₦2,500
  const threshold = 2500;
  const maxFee = 2000;
  
  let fee = (amount * percentage) / 100;
  
  if (amount >= threshold) {
    fee += fixedFee;
  }
  
  return Math.min(fee, maxFee);
};

/**
 * Helper: handle partial payment with proper fee calculation
 */
const handlePartialPayment = async (originalPayment, amountPaid, reference, paystackFee, platformFee, netToOrg) => {
  const expectedAmount = originalPayment.expectedAmount || originalPayment.amount;
  const remainingAmount = expectedAmount - amountPaid;

  // Update original payment as partial with fee breakdown
  originalPayment.paidAmount = amountPaid;
  originalPayment.remainingAmount = remainingAmount;
  originalPayment.isPartial = true;
  originalPayment.status = 'partial';
  originalPayment.paidAt = new Date();
  originalPayment.transactionReference = reference;
  originalPayment.paystackFeeDeducted = paystackFee;
  originalPayment.platformFeeDeducted = platformFee;
  originalPayment.netToOrganization = netToOrg;
  originalPayment.actualAmountPaid = amountPaid;
  await originalPayment.save();

  // Create outstanding payment record for remaining amount
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
      return res.status(200).json({ success: false, message: 'Invalid signature' });
    }

    // Only handle successful charge events
    if (event.event !== 'charge.success') {
      return res.status(200).json({ success: true });
    }

    const { reference, amount, fees, metadata, subaccount } = event.data;
    const amountPaid = amount / 100;
    const paystackFee = fees / 100;
    const organizationId = metadata?.organizationId;

    console.log(`📨 Webhook received: ₦${amountPaid} for reference ${reference}`);

    // Find payment by transaction reference
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
      console.warn(`Webhook: No payment found for reference ${reference}`);
      return res.status(200).json({ success: true });
    }

    // Avoid double processing
    if (payment.status === 'paid' || payment.status === 'partial') {
      return res.status(200).json({ success: true });
    }

    const expectedAmount = payment.expectedAmount || payment.amount;
    
    // ✅ Calculate platform fee (4% of after-Paystack amount)
    const afterPaystack = amountPaid - paystackFee;
    const platformFee = afterPaystack * 0.04;
    const netToOrg = afterPaystack - platformFee;
    
    console.log(`💰 Transaction breakdown:`);
    console.log(`   Amount paid: ₦${amountPaid}`);
    console.log(`   Paystack fee: ₦${paystackFee.toFixed(2)}`);
    console.log(`   After Paystack: ₦${afterPaystack.toFixed(2)}`);
    console.log(`   Platform fee (4%): ₦${platformFee.toFixed(2)}`);
    console.log(`   Organization receives: ₦${netToOrg.toFixed(2)}`);

    // Handle partial payment
    if (amountPaid < expectedAmount) {
      const partialResult = await handlePartialPayment(payment, amountPaid, reference, paystackFee, platformFee, netToOrg);

      await Income.create({
        amount: amountPaid,
        expectedAmount: expectedAmount,
        source: `${payment.type} - ${payment.description || 'Payment'} (Partial)`,
        date: new Date(),
        description: `Partial payment of ₦${amountPaid.toLocaleString()} for ${payment.name}. Remaining: ₦${(expectedAmount - amountPaid).toLocaleString()}`,
        paymentId: payment._id,
        paymentType: payment.type,
        userId: payment.user,
        organizationId: payment.organizationId,
        transactionReference: reference,
        isPartial: true,
        metadata: {
          paystackFee: paystackFee,
          platformFee: platformFee,
          netToOrganization: netToOrg,
          afterPaystack: afterPaystack
        }
      });

      console.log(`⚠️ Partial payment processed. Remaining: ₦${expectedAmount - amountPaid}`);
    } else {
      // Full payment
      payment.status = 'paid';
      payment.paidAmount = amountPaid;
      payment.remainingAmount = 0;
      payment.paidAt = new Date();
      payment.transactionReference = reference;
      payment.actualAmountPaid = amountPaid;
      payment.expectedAmount = expectedAmount;
      payment.paystackFeeDeducted = paystackFee;
      payment.platformFeeDeducted = platformFee;
      payment.netToOrganization = netToOrg;
      payment.afterPaystackAmount = afterPaystack;
      await payment.save();

      await Income.create({
        amount: payment.amount,
        expectedAmount: expectedAmount,
        source: `${payment.type} - ${payment.description || 'Payment'}`,
        date: new Date(),
        description: payment.description || `${payment.type} payment via Paystack`,
        paymentId: payment._id,
        paymentType: payment.type,
        userId: payment.user,
        organizationId: payment.organizationId,
        transactionReference: reference,
        metadata: {
          paystackFee: paystackFee,
          platformFee: platformFee,
          netToOrganization: netToOrg,
          afterPaystack: afterPaystack
        }
      });

      console.log(`✅ Full payment processed for ${payment._id}`);
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