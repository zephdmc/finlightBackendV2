const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const ValidationMiddleware = require('../middleware/validation');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const Organization = require('../models/Organization'); // ✅ ADDED
const { body, param } = require('express-validator');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PLATFORM_SUBACCOUNT = process.env.PLATFORM_SUBACCOUNT; // ✅ ADDED - Your platform's subaccount
const PAYSTACK_CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL || 'https://finlightv2.web.app/payment/callback';



// ==================== RATE LIMITING ====================

const paymentInitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many payment initialization attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many webhook requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
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

const logSecurityEvent = (event, details) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
    ip: details.ip,
    userAgent: details.userAgent
  }));
};

const validateAmount = (amount) => {
  const numAmount = Number(amount);
  return !isNaN(numAmount) && numAmount > 0 && numAmount <= 10000000;
};

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
    
    const session = await Payment.startSession();
    session.startTransaction();
    
    try {
      // Check for duplicate request
      if (idempotencyKey) {
        const existingPayment = await Payment.findOne({ 
          _id: paymentId,
          'metadata.idempotencyKey': idempotencyKey 
        }).session(session);
        
        if (existingPayment && existingPayment.transactionReference) {
          await session.commitTransaction();
          session.endSession();
          return res.status(200).json({
            success: true,
            data: {
              authorizationUrl: existingPayment.paymentUrl,
              reference: existingPayment.transactionReference
            },
            message: 'Payment already initialized'
          });
        }
      }
      
      const payment = await Payment.findById(paymentId)
        .populate('user', 'name email organizationId')
        .session(session);
      
      if (!payment) {
        await session.abortTransaction();
        session.endSession();
        logSecurityEvent('PAYMENT_NOT_FOUND', { paymentId, userId: req.user.id, ip: req.ip });
        return res.status(404).json({ success: false, message: 'Payment not found' });
      }
      
      // Verify ownership
      if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
        await session.abortTransaction();
        session.endSession();
        logSecurityEvent('UNAUTHORIZED_PAYMENT_INIT', { paymentId, userId: req.user.id, ip: req.ip });
        return res.status(403).json({ success: false, message: 'Not authorized to initialize this payment' });
      }
      
      if (payment.status === 'paid') {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Payment already completed' });
      }
      
      if (!validateAmount(payment.amount)) {
        await session.abortTransaction();
        session.endSession();
        logSecurityEvent('INVALID_PAYMENT_AMOUNT', { paymentId, amount: payment.amount });
        return res.status(400).json({ success: false, message: 'Invalid payment amount' });
      }
      
      // ✅ FETCH ORGANIZATION SUBACCOUNT
      let organizationSubaccount = null;
      let organization = null;
      
      if (payment.user.organizationId) {
        organization = await Organization.findById(payment.user.organizationId).session(session);
        if (organization?.paystack?.subaccountCode) {
          organizationSubaccount = organization.paystack.subaccountCode;
          console.log(`✅ Organization subaccount: ${organizationSubaccount}`);
        } else {
          console.log(`⚠️ No subaccount for organization: ${payment.user.organizationId}`);
        }
      }
      
      if (!organizationSubaccount) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: 'Organization payment setup incomplete. Please contact admin.'
        });
      }
      
      if (!PLATFORM_SUBACCOUNT) {
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({
          success: false,
          message: 'Platform configuration error. Please contact support.'
        });
      }
      
      // ✅ CALCULATE FEES
      const paystackFee = calculatePaystackFee(payment.amount);
      const afterPaystack = payment.amount - paystackFee;
      const platformFee = afterPaystack * 0.03; // 4% of after-Paystack amount
      const organizationAmount = afterPaystack - platformFee;
      
    
      
      const uniqueRef = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
      
      // ✅ BUILD PAYSTACK REQUEST WITH SPLIT
      const requestBody = {
        email: payment.user.email,
        amount: Math.round(payment.amount * 100),
        reference: `PAY-${payment._id}-${uniqueRef}`,
        callback_url: PAYSTACK_CALLBACK_URL,
        metadata: {
          paymentId: payment._id.toString(),
          userId: payment.user._id.toString(),
          type: payment.type,
          organizationId: payment.user.organizationId?.toString(),
          organizationName: organization?.name,
          feeBreakdown: {
            totalAmount: payment.amount,
            paystackFee: paystackFee,
            platformFee: platformFee,
            organizationAmount: organizationAmount
          }
        },
        split: {
          type: 'percentage',
          currency: 'NGN',
          subaccounts: [
            {
              subaccount: organizationSubaccount,
              share: 97  // Organization gets 96%
            },
            {
              subaccount: PLATFORM_SUBACCOUNT,
              share: 3   // Platform gets 4%
            }
          ],
          bearer_type: 'subaccount',
          bearer_subaccount: organizationSubaccount
        }
      };
      
      logSecurityEvent('PAYMENT_INIT_ATTEMPT', {
        paymentId,
        amount: payment.amount,
        userId: req.user.id,
        ip: req.ip,
        hasSubaccount: !!organizationSubaccount
      });
      
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
      
      if (!data.status) {
        await session.abortTransaction();
        session.endSession();
        logSecurityEvent('PAYSTACK_INIT_FAILED', { paymentId, error: data.message });
        throw new Error(data.message || 'Failed to initialize payment');
      }
      
      payment.transactionReference = data.data.reference;
      payment.paymentUrl = data.data.authorization_url;
      payment.metadata = {
        ...payment.metadata,
        idempotencyKey: idempotencyKey || generateIdempotencyKey(paymentId),
        initializedAt: new Date().toISOString(),
        initializedBy: req.user.id,
        organizationSubaccount: organizationSubaccount,
        platformSubaccount: PLATFORM_SUBACCOUNT,
        feeBreakdown: {
          totalAmount: payment.amount,
          paystackFee: paystackFee,
          afterPaystack: afterPaystack,
          platformFee: platformFee,
          organizationAmount: organizationAmount
        }
      };
      await payment.save({ session });
      
      await session.commitTransaction();
      session.endSession();
      
      logSecurityEvent('PAYMENT_INIT_SUCCESS', {
        paymentId,
        reference: data.data.reference,
        userId: req.user.id
      });
      
      res.status(200).json({
        success: true,
        data: {
          authorizationUrl: data.data.authorization_url,
          reference: data.data.reference
        }
      });
      
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
    
  } catch (error) {
    console.error('Payment initialization error:', error);
    logSecurityEvent('PAYMENT_INIT_ERROR', { error: error.message, userId: req.user?.id, ip: req.ip });
    res.status(500).json({ success: false, message: error.message || 'Failed to initialize payment' });
  }
});

// ==================== PAYMENT VERIFICATION ====================

router.get('/verify/:reference', verifyLimiter, validatePaymentVerification, async (req, res) => {
  try {
    const { reference } = req.params;
    
    logSecurityEvent('PAYMENT_VERIFY_ATTEMPT', { reference, ip: req.ip });
    
    let payment = await Payment.findOne({ transactionReference: reference });
    
    if (!payment) {
      const match = reference.match(/PAY-([a-f0-9]+)-/);
      if (match && match[1]) {
        payment = await Payment.findById(match[1]).populate('user', 'name email organizationId');
      }
    }
    
    if (!payment) {
      logSecurityEvent('PAYMENT_VERIFY_NOT_FOUND', { reference });
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (payment.status === 'paid') {
      payment.actualAmountPaid = amountPaid;
payment.paystackFeeDeducted = data.data.fees / 100;
payment.afterPaystackAmount = amountPaid - (data.data.fees / 100);
payment.platformFeeDeducted = payment.afterPaystackAmount * 0.03;
payment.netToOrganization = payment.afterPaystackAmount - payment.platformFeeDeducted;
      return res.status(200).json({
        success: true,
        data: { status: payment.status, amount: payment.amount, paidAt: payment.paidAt },
        message: 'Payment already verified'
      });
    }
    
    const attempts = payment.metadata?.verificationAttempts || 0;
    if (attempts > 5) {
      return res.status(429).json({ success: false, message: 'Too many verification attempts. Please contact support.' });
    }
    
    payment.metadata = {
      ...payment.metadata,
      verificationAttempts: attempts + 1,
      lastVerificationAttempt: new Date().toISOString()
    };
    await payment.save();
    
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    
    if (data.status && data.data && data.data.status === 'success') {
      const expectedAmount = payment.amount * 100;
      const actualAmount = data.data.amount;
      
      if (Math.abs(expectedAmount - actualAmount) > 1) {
        logSecurityEvent('PAYMENT_AMOUNT_MISMATCH', { paymentId: payment._id, expectedAmount, actualAmount });
        return res.status(400).json({ success: false, message: 'Payment amount mismatch. Please contact support.' });
      }
      
      payment.status = 'paid';
      payment.paidAt = new Date();
      payment.metadata = {
        ...payment.metadata,
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'paystack',
        paystackData: {
          amount: data.data.amount,
          fees: data.data.fees,
          currency: data.data.currency,
          paidAt: data.data.paid_at,
          channel: data.data.channel
        }
      };
      await payment.save();
      
      if (payment.type === 'registration') {
        await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true, registrationPaidAt: new Date() });
      }
      
      try {
        await Income.create({
          amount: payment.amount,
          source: `${payment.type} payment - ${payment.description || payment.type}`,
          date: new Date(),
          description: `Paystack payment - ${payment.description || payment.type}`,
          paymentId: payment._id,
          paymentType: payment.type,
          transactionReference: reference,
          organizationId: payment.user.organizationId,
          metadata: {
            paystackFees: data.data.fees,
            paystackReference: reference,
            channel: data.data.channel,
            feeBreakdown: payment.metadata?.feeBreakdown
          }
        });
        
        logSecurityEvent('PAYMENT_VERIFY_SUCCESS', { paymentId: payment._id, reference, amount: payment.amount });
        
      } catch (incomeError) {
        console.error('Failed to record income:', incomeError);
        logSecurityEvent('PAYMENT_INCOME_RECORDING_FAILED', { paymentId: payment._id, error: incomeError.message });
      }
      
      res.status(200).json({
        success: true,
        data: { status: payment.status, amount: payment.amount, paidAt: payment.paidAt, reference: payment.transactionReference },
        message: 'Payment verified successfully'
      });
    } else {
      logSecurityEvent('PAYMENT_VERIFY_FAILED', { reference, paystackStatus: data.data?.status, message: data.message });
      res.status(400).json({ success: false, message: data.message || 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    logSecurityEvent('PAYMENT_VERIFY_ERROR', { reference: req.params.reference, error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Payment verification failed' });
  }
});

// ==================== PAYMENT WEBHOOK ====================

router.post('/webhook', express.raw({ type: 'application/json' }), webhookLimiter, async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    const signature = req.headers['x-paystack-signature'];
    
    if (!signature || hash !== signature) {
      logSecurityEvent('INVALID_WEBHOOK_SIGNATURE', { ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }
    
    const event = req.body;
    logSecurityEvent('WEBHOOK_RECEIVED', { event: event.event, reference: event.data?.reference });
    
    if (event.event === 'charge.success') {
      const { reference, amount, fees, customer, metadata } = event.data;
      
      const session = await Payment.startSession();
      session.startTransaction();
      
      try {
        let payment = await Payment.findOne({ transactionReference: reference }).session(session);
        
        if (!payment && metadata?.paymentId) {
          payment = await Payment.findById(metadata.paymentId).session(session);
        }
        
        if (payment && payment.status !== 'paid') {
          const expectedAmount = payment.amount * 100;
          
          if (Math.abs(expectedAmount - amount) <= 1) {
            payment.status = 'paid';
            payment.paidAt = new Date();
            payment.metadata = {
              ...payment.metadata,
              webhookVerifiedAt: new Date().toISOString(),
              webhookSignature: hash,
              paystackFees: fees,
              customerData: customer
            };
            await payment.save({ session });
            
            if (payment.type === 'registration') {
              await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true }, { session });
            }
            
            await Income.create([{
              amount: payment.amount,
              source: `${payment.type} payment - Webhook`,
              date: new Date(),
              description: `Paystack payment via webhook`,
              paymentId: payment._id,
              paymentType: payment.type,
              transactionReference: reference,
              organizationId: payment.user.organizationId,
              metadata: { source: 'webhook', fees, feeBreakdown: payment.metadata?.feeBreakdown }
            }], { session });
            
            await session.commitTransaction();
            logSecurityEvent('WEBHOOK_PAYMENT_PROCESSED', { paymentId: payment._id, reference, amount: payment.amount });
          } else {
            await session.abortTransaction();
            logSecurityEvent('WEBHOOK_AMOUNT_MISMATCH', { paymentId: payment._id, expectedAmount, actualAmount: amount });
          }
        } else {
          await session.abortTransaction();
        }
      } catch (error) {
        await session.abortTransaction();
        throw error;
      } finally {
        session.endSession();
      }
    }
    
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    logSecurityEvent('WEBHOOK_ERROR', { error: error.message, ip: req.ip });
    res.status(200).json({ success: false, message: error.message });
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
      logSecurityEvent('UNAUTHORIZED_STATUS_CHECK', { paymentId, userId: req.user.id, ip: req.ip });
      return res.status(403).json({ success: false, message: 'Not authorized to check this payment' });
    }
    
    res.status(200).json({
      success: true,
      data: {
        status: payment.status,
        amount: payment.amount,
        type: payment.type,
        paidAt: payment.paidAt,
        reference: payment.transactionReference,
        description: payment.description
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to check payment status' });
  }
});

// ==================== HEALTH CHECK ====================

router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'payment-gateway',
    paystack_configured: !!PAYSTACK_SECRET_KEY,
    platform_subaccount: !!PLATFORM_SUBACCOUNT,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;