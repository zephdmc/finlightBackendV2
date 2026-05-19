const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const ValidationMiddleware = require('../middleware/validation');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const Organization = require('../models/Organization');
const { body, param } = require('express-validator');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PLATFORM_SUBACCOUNT = process.env.PLATFORM_SUBACCOUNT;
const PAYSTACK_CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL || 'https://finlightv2.web.app/payment/callback';


console.log('✅ Payment Gateway loaded');
console.log('   Paystack Key:', PAYSTACK_SECRET_KEY ? 'Configured' : 'MISSING');
console.log('   Platform Subaccount:', PLATFORM_SUBACCOUNT ? 'Configured' : 'MISSING');

// ==================== RATE LIMITING ====================

const paymentInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many payment initialization attempts.' },
  keyGenerator: (req) => req.user?.id || req.ip
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many webhook requests' }
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true
});

const statusCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many status check requests' }
});

// ==================== HELPER FUNCTIONS ====================

const generateIdempotencyKey = (paymentId) => {
  return `pay_${paymentId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
};

const validateAmount = (amount) => {
  const numAmount = Number(amount);
  return !isNaN(numAmount) && numAmount > 0 && numAmount <= 10000000;
};

// ==================== VALIDATION RULES ====================

const validatePaymentInit = [
  body('paymentId').isMongoId().withMessage('Invalid payment ID format'),
  body('idempotencyKey').optional().isString().trim().isLength({ min: 10, max: 100 }),
  ValidationMiddleware.validate
];

const validatePaymentVerification = [
  param('reference').notEmpty().withMessage('Transaction reference is required')
    .matches(/^PAY-[a-f0-9]+-\d+-[a-z0-9]+$/i).withMessage('Invalid reference format')
    .isLength({ min: 20, max: 100 }),
  ValidationMiddleware.validate
];

// ==================== PAYMENT INITIALIZATION ====================

router.post('/initialize', protect, paymentInitLimiter, validatePaymentInit, async (req, res) => {
  try {
    const { paymentId, idempotencyKey } = req.body;
    
    console.log('📦 Payment initialization:', { paymentId });
    
    const payment = await Payment.findById(paymentId).populate('user', 'name email organizationId');
    
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    if (payment.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Payment already completed' });
    }
    
    if (!validateAmount(payment.amount)) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount' });
    }
    
    // Fetch organization subaccount
    let organizationSubaccount = null;
    let organization = null;
    
    if (payment.user.organizationId) {
      organization = await Organization.findById(payment.user.organizationId);
      if (organization?.paystack?.subaccountCode) {
        organizationSubaccount = organization.paystack.subaccountCode;
        console.log(`✅ Organization subaccount: ${organizationSubaccount}`);
      } else {
        console.log(`⚠️ No subaccount for organization: ${payment.user.organizationId}`);
      }
    }
    
    if (!organizationSubaccount) {
      return res.status(400).json({
        success: false,
        message: 'Organization payment setup incomplete. Please contact admin.'
      });
    }
    
    if (!PLATFORM_SUBACCOUNT) {
      return res.status(500).json({
        success: false,
        message: 'Platform configuration error. Please contact support.'
      });
    }
    
    const uniqueRef = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    
    // Build Paystack request WITHOUT split (use subaccount directly)
    const requestBody = {
      email: payment.user.email,
      amount: Math.round(payment.amount * 100),
      reference: `PAY-${payment._id}-${uniqueRef}`,
      callback_url: PAYSTACK_CALLBACK_URL,
      subaccount: organizationSubaccount,
      bearer: 'subaccount',
      metadata: {
        paymentId: payment._id.toString(),
        userId: payment.user._id.toString(),
        type: payment.type,
        organizationId: payment.user.organizationId?.toString(),
        organizationName: organization?.name
      }
    };
    
    console.log('📤 Sending to Paystack...');
    
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey || generateIdempotencyKey(paymentId)
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();
    console.log('📥 Paystack response:', data.status ? 'Success' : 'Failed', data.message);
    
    if (!data.status) {
      return res.status(400).json({ success: false, message: data.message || 'Failed to initialize payment' });
    }
    
    payment.transactionReference = data.data.reference;
    payment.paymentUrl = data.data.authorization_url;
    await payment.save();
    
    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference
      }
    });
    
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ==================== PAYMENT VERIFICATION ====================

router.get('/verify/:reference', verifyLimiter, validatePaymentVerification, async (req, res) => {
  try {
    const { reference } = req.params;
    
    console.log('🔍 Verifying payment:', reference);
    
    let payment = await Payment.findOne({ transactionReference: reference });
    
    if (!payment) {
      const match = reference.match(/PAY-([a-f0-9]+)-/);
      if (match && match[1]) {
        payment = await Payment.findById(match[1]);
      }
    }
    
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.status === 'paid') {
      return res.status(200).json({
        success: true,
        data: { status: payment.status, amount: payment.amount },
        message: 'Payment already verified'
      });
    }
    
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    
    const data = await response.json();
    
    if (data.status && data.data && data.data.status === 'success') {
      const amountPaid = data.data.amount / 100;
      const paystackFee = data.data.fees / 100;
      const afterPaystack = amountPaid - paystackFee;
      const platformFee = afterPaystack * 0.04;
      const netToOrg = afterPaystack - platformFee;
      
      payment.status = 'paid';
      payment.paidAt = new Date();
      payment.actualAmountPaid = amountPaid;
      payment.paystackFeeDeducted = paystackFee;
      payment.afterPaystackAmount = afterPaystack;
      payment.platformFeeDeducted = platformFee;
      payment.netToOrganization = netToOrg;
      await payment.save();
      
      if (payment.type === 'registration') {
        await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
      }
      
      await Income.create({
        amount: payment.amount,
        source: `${payment.type} payment`,
        date: new Date(),
        description: payment.description || `${payment.type} payment via Paystack`,
        paymentId: payment._id,
        paymentType: payment.type,
        transactionReference: reference,
        organizationId: payment.user.organizationId,
        metadata: { paystackFees: data.data.fees, platformFee, netToOrg }
      });
      
      console.log(`✅ Payment verified: ₦${amountPaid}, Org gets: ₦${netToOrg.toFixed(2)}`);
      
      res.status(200).json({
        success: true,
        data: { status: payment.status, amount: payment.amount },
        message: 'Payment verified successfully'
      });
    } else {
      res.status(400).json({ success: false, message: data.message || 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PAYMENT WEBHOOK ====================

router.post('/webhook', express.raw({ type: 'application/json' }), webhookLimiter, async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ success: false });
    }
    
    const event = req.body;
    
    if (event.event === 'charge.success') {
      const { reference, amount, fees } = event.data;
      const payment = await Payment.findOne({ transactionReference: reference });
      
      if (payment && payment.status !== 'paid') {
        // ✅ Calculate fees here too
        const amountPaid = amount / 100;
        const paystackFee = fees / 100;
        const afterPaystack = amountPaid - paystackFee;
        const platformFee = afterPaystack * 0.04;
        const netToOrg = afterPaystack - platformFee;
        
        payment.status = 'paid';
        payment.paidAt = new Date();
        payment.actualAmountPaid = amountPaid;
        payment.paystackFeeDeducted = paystackFee;
        payment.afterPaystackAmount = afterPaystack;
        payment.platformFeeDeducted = platformFee;
        payment.netToOrganization = netToOrg;
        
        await payment.save();
        
        // Also create Income record
        await Income.create({
          amount: payment.amount,
          source: `${payment.type} payment`,
          date: new Date(),
          description: payment.description,
          paymentId: payment._id,
          paymentType: payment.type,
          transactionReference: reference,
          organizationId: payment.user?.organizationId,
          metadata: { paystackFee, platformFee, netToOrg }
        });
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ success: false });
  }
});
// ==================== PAYMENT STATUS CHECK ====================

router.get('/status/:paymentId', protect, statusCheckLimiter, ValidationMiddleware.idParam, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const payment = await Payment.findById(paymentId).populate('user', 'name email');
    
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    res.status(200).json({
      success: true,
      data: {
        status: payment.status,
        amount: payment.amount,
        type: payment.type,
        paidAt: payment.paidAt,
        reference: payment.transactionReference
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== HEALTH CHECK ====================

router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'payment-gateway',
    paystack_configured: !!PAYSTACK_SECRET_KEY,
    platform_subaccount: !!PLATFORM_SUBACCOUNT,
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;