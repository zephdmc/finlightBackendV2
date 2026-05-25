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
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
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

// Store for tracking verification in progress (in-memory, for distributed systems use Redis)
const verificationInProgress = new Map();

// ==================== FEE CALCULATION HELPERS ====================

/**
 * Calculate what member needs to pay so organization receives target amount
 * Fees are ADDED ON TOP for card payments
 */
/**
 * Calculate what member needs to pay so organization receives target amount
 * Fees are ADDED ON TOP for card payments
 */
const calculateMemberPayAmount = (targetOrganizationAmount) => {
  if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;
  
  let memberPays = targetOrganizationAmount;
  let iteration = 0;
  const maxIterations = 30;
  
  while (iteration < maxIterations) {
    // Calculate Paystack fee based on memberPays
    let paystackFee = memberPays * 0.015;
    if (memberPays >= 2500) paystackFee += 100;
    paystackFee = Math.min(paystackFee, 2000);
    
    const afterPaystack = memberPays - paystackFee;
    let platformFee = afterPaystack * 0.04;
    
    // Round platform fee
    platformFee = Math.round(platformFee * 100) / 100;
    
    const orgGets = Math.round(afterPaystack - platformFee);
    
    // If organization gets exactly what we want, we're done
    if (orgGets === targetOrganizationAmount) {
      break;
    }
    
    // If within 1 naira, adjust to exact amount
    if (Math.abs(orgGets - targetOrganizationAmount) <= 1) {
      const difference = targetOrganizationAmount - orgGets;
      memberPays += difference;
      break;
    }
    
    // Adjust memberPays based on the difference
    const difference = targetOrganizationAmount - orgGets;
    memberPays += difference;
    iteration++;
  }
  
  return Math.ceil(memberPays);
};

/**
 * Calculate fees for a given amount and return net to organization
 */
/**
 * Calculate fees for a given amount and return net to organization
 * Ensures organization receives exactly what they expect
 */
const calculateNetToOrganization = (amountPaid) => {
  // Calculate fees
  let paystackFee = amountPaid * 0.015;
  if (amountPaid >= 2500) paystackFee += 100;
  paystackFee = Math.min(paystackFee, 2000);
  
  const afterPaystack = amountPaid - paystackFee;
  let platformFee = afterPaystack * 0.04;
  
  // Round platform fee to nearest kobo
  platformFee = Math.round(platformFee * 100) / 100;
  
  let netToOrg = afterPaystack - platformFee;
  
  // Round net to nearest whole number
  netToOrg = Math.round(netToOrg);
  
  // Calculate total fees paid (rounded)
  const totalFees = amountPaid - netToOrg;
  
  return {
    amountPaid,
    paystackFee: Math.round(paystackFee),
    afterPaystack: Math.round(afterPaystack),
    platformFee: platformFee,
    netToOrg: netToOrg,
    totalFees: Math.round(totalFees)
  };
};

// ==================== PARTIAL PAYMENT HELPERS ====================

/**
 * Process a partial payment (bank transfer or card underpayment)
 * The organization amount remains the target, shortage becomes outstanding
 */
const processPartialPayment = async (originalPayment, amountPaid, reference, isManual = false) => {
  const targetOrgAmount = originalPayment.targetOrgAmount || originalPayment.amount;
  const totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;
  
  // Calculate what organization gets from THIS payment (after fees)
  const fees = calculateNetToOrganization(amountPaid);
  const netToOrgFromThisPayment = fees.netToOrg;
  
  // The organization's target amount remains the same (e.g., ₦5,000)
  // The remaining amount the organization still needs to receive
  const remainingOrgTarget = targetOrgAmount - totalPaidSoFar;
  
  // Update original payment
  originalPayment.totalPaidSoFar = totalPaidSoFar;
  originalPayment.remainingAmount = remainingOrgTarget;
  originalPayment.isPartial = remainingOrgTarget > 0;
  originalPayment.partialPayments = originalPayment.partialPayments || [];
  originalPayment.partialPayments.push({
    amount: amountPaid,
    netToOrg: netToOrgFromThisPayment,
    date: new Date(),
    transactionReference: reference,
    fees: {
      paystackFee: fees.paystackFee,
      platformFee: fees.platformFee,
      totalFees: fees.totalFees
    }
  });
  
  if (remainingOrgTarget <= 0) {
    originalPayment.status = 'paid';
    originalPayment.completedAt = new Date();
  } else {
    originalPayment.status = 'partial';
  }
  
  await originalPayment.save();
  
  // Record INCOME for this partial payment (what org actually gets from this transaction)
  await Income.create({
    amount: netToOrgFromThisPayment,
    source: `${originalPayment.type} payment (Partial - ₦${amountPaid.toLocaleString()} paid)`,
    date: new Date(),
    description: `Partial payment of ₦${amountPaid.toLocaleString()} received. Fees: ₦${fees.totalFees.toLocaleString()}. Organization target: ₦${targetOrgAmount.toLocaleString()}, Remaining: ₦${remainingOrgTarget.toLocaleString()}`,
    paymentId: originalPayment._id,
    paymentType: originalPayment.type,
    transactionReference: reference,
    organizationId: originalPayment.user?.organizationId,
    createdBy: originalPayment.user?._id,
    metadata: { 
      isPartial: true,
      partialAmount: amountPaid,
      netToOrg: netToOrgFromThisPayment,
      remainingTarget: remainingOrgTarget,
      fees: { paystackFee: fees.paystackFee, platformFee: fees.platformFee }
    }
  });
  
  // Create or update outstanding payment record for remaining target amount
  let outstandingPayment = null;
  if (remainingOrgTarget > 0) {
    outstandingPayment = await Payment.findOne({
      parentPaymentId: originalPayment._id,
      type: 'outstanding',
      status: 'unpaid'
    });
    
    if (outstandingPayment) {
      outstandingPayment.amount = remainingOrgTarget;
      outstandingPayment.targetOrgAmount = remainingOrgTarget;
      outstandingPayment.description = `Outstanding balance of ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}`;
      await outstandingPayment.save();
    } else {
      outstandingPayment = await Payment.create({
        name: `${originalPayment.name} (Outstanding Balance)`,
        type: 'outstanding',
        amount: remainingOrgTarget,
        targetOrgAmount: remainingOrgTarget,
        description: `Remaining balance of ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}. Original amount: ₦${targetOrgAmount.toLocaleString()}, Total paid so far: ₦${totalPaidSoFar.toLocaleString()}`,
        user: originalPayment.user,
        organizationId: originalPayment.organizationId,
        paymentTypeId: originalPayment.paymentTypeId,
        parentPaymentId: originalPayment._id,
        status: 'unpaid',
        isPartial: true,
        dueDate: originalPayment.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: originalPayment.user?._id
      });
    }
    console.log(`📝 Created outstanding record: ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}`);
  }
  
  console.log(`💰 Partial payment processed: Paid ₦${amountPaid.toLocaleString()} → Org net: ₦${netToOrgFromThisPayment.toLocaleString()}, Remaining target: ₦${remainingOrgTarget.toLocaleString()}`);
  
  return {
    amountPaid,
    netToOrg: netToOrgFromThisPayment,
    remainingTarget: remainingOrgTarget,
    outstandingPayment
  };
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
    
    const targetOrgAmount = payment.amount;
    const memberPayAmount = calculateMemberPayAmount(targetOrgAmount);
    
    console.log(`💰 Target org amount: ₦${targetOrgAmount} → Member should pay: ₦${memberPayAmount} (includes fees)`);
    
    if (!validateAmount(memberPayAmount)) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount calculation' });
    }
    
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
    
    const requestBody = {
      email: payment.user.email,
      amount: Math.round(memberPayAmount * 100),
      reference: `PAY-${payment._id}-${uniqueRef}`,
      callback_url: PAYSTACK_CALLBACK_URL,
      subaccount: organizationSubaccount,
      bearer: 'subaccount',
      metadata: {
        paymentId: payment._id.toString(),
        userId: payment.user._id.toString(),
        type: payment.type,
        organizationId: payment.user.organizationId?.toString(),
        organizationName: organization?.name,
        targetOrgAmount: targetOrgAmount,
        memberPayAmount: memberPayAmount
      }
    };
    
    console.log('📤 Sending to Paystack with amount:', memberPayAmount);
    
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
    payment.expectedAmount = memberPayAmount;
    payment.targetOrgAmount = targetOrgAmount;
    await payment.save();
    
    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference,
        memberPayAmount,
        targetOrgAmount
      }
    });
    
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ==================== PAYMENT VERIFICATION ====================

router.get('/verify/:reference', verifyLimiter, validatePaymentVerification, async (req, res) => {
  const { reference } = req.params;
  
  // Check if this reference is already being processed
  if (verificationInProgress.has(reference)) {
    console.log('⏳ Verification already in progress for:', reference);
    await verificationInProgress.get(reference);
    const payment = await Payment.findOne({ transactionReference: reference });
    if (payment && payment.status === 'paid') {
      return res.status(200).json({
        success: true,
        data: { 
          status: payment.status, 
          amount: payment.amount,
          remainingAmount: payment.remainingAmount
        },
        message: 'Payment already verified'
      });
    }
  }
  
  // Create a promise to track this verification
  let resolveVerification;
  const verificationPromise = new Promise((resolve) => {
    resolveVerification = resolve;
  });
  verificationInProgress.set(reference, verificationPromise);
  
  try {
    console.log('🔍 Verifying payment:', reference);
    
    let payment = await Payment.findOne({ transactionReference: reference })
      .populate('user', 'name email organizationId');
    
    if (!payment) {
      const match = reference.match(/PAY-([a-f0-9]+)-/);
      if (match && match[1]) {
        payment = await Payment.findById(match[1]).populate('user', 'name email organizationId');
      }
    }
    
    if (!payment) {
      verificationInProgress.delete(reference);
      resolveVerification();
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    // Check if already paid
    if (payment.status === 'paid') {
      console.log('✅ Payment already verified and marked as paid');
      verificationInProgress.delete(reference);
      resolveVerification();
      return res.status(200).json({
        success: true,
        data: { 
          status: payment.status, 
          amount: payment.amount,
          remainingAmount: payment.remainingAmount,
          isPartial: payment.isPartial
        },
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
      const expectedAmount = payment.expectedAmount || payment.amount;
      
      // Check if this is a partial payment (paid less than expected by more than 1 Naira)
      const isPartialPayment = amountPaid < (expectedAmount - 1);
      
      console.log(`💰 Amount paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Is Partial: ${isPartialPayment}`);
      console.log(`Current payment status before update: ${payment.status}, remaining: ${payment.remainingAmount}`);
      
      let result;
      
      if (isPartialPayment) {
        // Process partial payment
        result = await processPartialPayment(payment, amountPaid, reference, false);
        console.log(`⚠️ Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Remaining target: ₦${result.remainingTarget}`);
      } else {
        // Full payment - Use findOneAndUpdate to force the update
        const fees = calculateNetToOrganization(amountPaid);
        
        // Ensure the organization receives exactly the target amount
        const exactOrgAmount = payment.targetOrgAmount || payment.amount;
        
        // Force update using findOneAndUpdate
        const updatedPayment = await Payment.findOneAndUpdate(
          { _id: payment._id },
          {
            $set: {
              status: 'paid',
              paidAt: new Date(),
              actualAmountPaid: amountPaid,
              netToOrganization: exactOrgAmount, // Store exact intended amount
              totalPaidSoFar: amountPaid,
              remainingAmount: 0,
              isPartial: false,
              completedAt: new Date()
            }
          },
          { new: true }
        );
        
        console.log(`✅ Full payment recorded: Organization receives ₦${exactOrgAmount}`);
        
        // Record INCOME with exact amount
        await Income.create({
          amount: exactOrgAmount, // Use exact intended amount
          source: `${payment.type} payment`,
          date: new Date(),
          description: `Full payment received. Member paid ₦${amountPaid.toLocaleString()}, organization receives ₦${exactOrgAmount.toLocaleString()}`,
          paymentId: payment._id,
          paymentType: payment.type,
          transactionReference: reference,
          organizationId: payment.user?.organizationId,
          createdBy: payment.user?._id,
          metadata: { 
            grossAmount: amountPaid,
            netToOrg: exactOrgAmount,
            fees: { paystackFee: fees.paystackFee, platformFee: fees.platformFee }
          }
        });
        
        payment = updatedPayment;
        result = { remainingTarget: 0 };
      }
      
      if (payment.type === 'registration') {
        await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
      }
      
      console.log(`✅ Payment verified: Member paid ₦${amountPaid.toFixed(2)}, Final Status: ${payment.status}`);
      
      verificationInProgress.delete(reference);
      resolveVerification();
      
      res.status(200).json({
        success: true,
        data: { 
          status: payment.status, 
          amount: payment.amount,
          isPartial: isPartialPayment || false,
          remainingAmount: result?.remainingTarget || payment.remainingAmount || 0,
          totalPaidSoFar: payment.totalPaidSoFar || amountPaid
        },
        message: isPartialPayment ? `Partial payment of ₦${amountPaid.toLocaleString()} verified. Outstanding balance: ₦${result?.remainingTarget.toLocaleString()}` : 'Payment verified successfully'
      });
    } else {
      verificationInProgress.delete(reference);
      resolveVerification();
      res.status(400).json({ success: false, message: data.message || 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    verificationInProgress.delete(reference);
    resolveVerification();
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PAYMENT WEBHOOK ====================

router.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    let rawBody;
    if (req.rawBody) {
      rawBody = req.rawBody;
    } else {
      rawBody = JSON.stringify(req.body);
    }
    
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).json({ success: false });
    }
    
    const event = req.body;
    console.log('📨 Webhook received:', event.event);
    
    if (event.event === 'charge.success') {
      const { reference, amount } = event.data;
      
      const payment = await Payment.findOne({ 
        transactionReference: reference,
        status: { $ne: 'paid' }
      }).populate('user', 'organizationId');
      
      if (payment && payment.status !== 'paid') {
        const amountPaid = amount / 100;
        const expectedAmount = payment.expectedAmount || payment.amount;
        const isPartialPayment = amountPaid < (expectedAmount - 1);
        
        if (isPartialPayment) {
          await processPartialPayment(payment, amountPaid, reference, false);
          console.log(`⚠️ Webhook - Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}`);
        } else {
          const fees = calculateNetToOrganization(amountPaid);
          
          // Force update using findOneAndUpdate
          await Payment.findOneAndUpdate(
            { _id: payment._id },
            {
              $set: {
                status: 'paid',
                paidAt: new Date(),
                actualAmountPaid: amountPaid,
                netToOrganization: fees.netToOrg,
                totalPaidSoFar: amountPaid,
                remainingAmount: 0,
                isPartial: false,
                completedAt: new Date()
              }
            }
          );
          
          await Income.create({
            amount: fees.netToOrg,
            source: `${payment.type} payment`,
            date: new Date(),
            description: `Payment received via webhook. Member paid ₦${amountPaid.toLocaleString()}`,
            paymentId: payment._id,
            paymentType: payment.type,
            transactionReference: reference,
            organizationId: payment.user?.organizationId,
            createdBy: payment.user?._id
          });
        }
        
        console.log(`✅ Webhook processed: Member paid ₦${amountPaid.toFixed(2)}`);
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ success: false });
  }
});

// ==================== PARTIAL PAYMENT ENDPOINT (Admin for Bank Transfers) ====================

router.post('/record-partial-payment', protect, async (req, res) => {
  try {
    const { paymentId, amountPaid, reference, notes } = req.body;
    
    const originalPayment = await Payment.findById(paymentId).populate('user', 'organizationId');
    
    if (!originalPayment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    if (originalPayment.user.organizationId.toString() !== req.user.organizationId?.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    if (originalPayment.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Payment already completed' });
    }
    
    if (!amountPaid || amountPaid <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }
    
    const result = await processPartialPayment(originalPayment, amountPaid, reference || `MANUAL-${Date.now()}`, true);
    
    res.status(200).json({
      success: true,
      data: {
        payment: originalPayment,
        amountPaid: result.amountPaid,
        netToOrg: result.netToOrg,
        remainingTarget: result.remainingTarget,
        outstandingPayment: result.outstandingPayment
      },
      message: result.remainingTarget > 0 
        ? `Partial payment of ₦${amountPaid.toLocaleString()} recorded. Organization receives ₦${result.netToOrg.toLocaleString()}. Outstanding balance: ₦${result.remainingTarget.toLocaleString()}`
        : 'Payment completed successfully'
    });
  } catch (error) {
    console.error('Record partial payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET OUTSTANDING PAYMENTS ====================

router.get('/outstanding', protect, async (req, res) => {
  try {
    const query = {
      user: req.user.id,
      status: 'unpaid',
      type: 'outstanding',
      remainingAmount: { $gt: 0 }
    };
    
    const outstandingPayments = await Payment.find(query)
      .populate('paymentTypeId', 'name type')
      .sort({ dueDate: 1, createdAt: 1 });
    
    const totalOutstanding = outstandingPayments.reduce((sum, p) => sum + (p.remainingAmount || p.amount), 0);
    
    res.status(200).json({
      success: true,
      data: {
        payments: outstandingPayments,
        totalOutstanding,
        count: outstandingPayments.length
      }
    });
  } catch (error) {
    console.error('Get outstanding payments error:', error);
    res.status(500).json({ success: false, message: error.message });
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
        reference: payment.transactionReference,
        remainingAmount: payment.remainingAmount,
        isPartial: payment.isPartial,
        totalPaidSoFar: payment.totalPaidSoFar
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== TEST ROUTES ====================

router.get('/test-route', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Test route works!',
    registeredRoutes: ['/health', '/verify/:reference', '/webhook', '/initialize', '/status/:paymentId', '/outstanding', '/record-partial-payment']
  });
});

router.all('/webhook-test', (req, res) => {
  console.log('🔥 Test webhook hit!');
  res.json({ 
    success: true, 
    message: 'Test webhook endpoint works!',
    method: req.method
  });
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