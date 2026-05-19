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
const Expenditure = require('../models/Expenditure');

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

// ✅ Idempotency helper to prevent duplicate expenditure records
const hasExpenditureRecord = async (paymentId, feeType) => {
  const existing = await Expenditure.findOne({
    'metadata.paymentId': paymentId,
    'metadata.feeType': feeType
  });
  return !!existing;
};

// ==================== FEE CALCULATION HELPERS ====================

/**
 * Calculate what member needs to pay so organization receives target amount
 * Solves: targetOrgAmount = amount - paystackFee(amount) - platformFee(afterPaystack)
 */
const calculateMemberPayAmount = (targetOrganizationAmount) => {
  if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;
  
  let memberPays = targetOrganizationAmount;
  let iteration = 0;
  const maxIterations = 30;
  
  while (iteration < maxIterations) {
    let paystackFee = memberPays * 0.015;
    if (memberPays >= 2500) paystackFee += 100;
    paystackFee = Math.min(paystackFee, 2000);
    
    const afterPaystack = memberPays - paystackFee;
    const platformFee = afterPaystack * 0.04;
    const orgGets = afterPaystack - platformFee;
    
    if (Math.abs(orgGets - targetOrganizationAmount) < 1) {
      break;
    }
    
    const difference = targetOrganizationAmount - orgGets;
    memberPays += difference;
    iteration++;
  }
  
  return Math.ceil(memberPays);
};

/**
 * Calculate fee breakdown from the actual amount paid
 */
const calculateFeesFromPaidAmount = (amountPaid) => {
  const paystackFee = amountPaid * 0.015 + (amountPaid >= 2500 ? 100 : 0);
  const finalPaystackFee = Math.min(paystackFee, 2000);
  const afterPaystack = amountPaid - finalPaystackFee;
  const platformFee = afterPaystack * 0.04;
  const netToOrg = afterPaystack - platformFee;
  
  return {
    amountPaid,
    paystackFee: finalPaystackFee,
    afterPaystack,
    platformFee,
    netToOrg,
    totalFees: finalPaystackFee + platformFee
  };
};

// ==================== PARTIAL PAYMENT HELPERS ====================

/**
 * Create or update outstanding payment record for partial payments
 */
const createOrUpdateOutstandingPayment = async (originalPayment, amountPaid, fees, reference) => {
  // Calculate remaining amount (what org should still receive)
  const totalTargetOrgAmount = originalPayment.targetOrgAmount || originalPayment.amount;
  const totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;
  const remainingAmount = totalTargetOrgAmount - totalPaidSoFar;
  
  // Update original payment with partial payment info
  originalPayment.totalPaidSoFar = totalPaidSoFar;
  originalPayment.remainingAmount = remainingAmount;
  originalPayment.isPartial = remainingAmount > 0;
  originalPayment.partialPayments = originalPayment.partialPayments || [];
  originalPayment.partialPayments.push({
    amount: amountPaid,
    netToOrg: fees.netToOrg,
    date: new Date(),
    transactionReference: reference,
    fees: {
      paystackFee: fees.paystackFee,
      platformFee: fees.platformFee,
      totalFees: fees.totalFees
    }
  });
  
  if (remainingAmount <= 0) {
    originalPayment.status = 'paid';
    originalPayment.completedAt = new Date();
  } else {
    originalPayment.status = 'partial';
  }
  
  await originalPayment.save();
  
  // If there's remaining amount, create or update outstanding payment record
  if (remainingAmount > 0) {
    let outstandingPayment = await Payment.findOne({
      parentPaymentId: originalPayment._id,
      type: 'outstanding',
      status: 'unpaid'
    });
    
    if (outstandingPayment) {
      // Update existing outstanding payment
      outstandingPayment.amount = remainingAmount;
      outstandingPayment.description = `Outstanding balance for ${originalPayment.name} - Original: ₦${totalTargetOrgAmount.toLocaleString()}, Paid: ₦${totalPaidSoFar.toLocaleString()}`;
      await outstandingPayment.save();
    } else {
      // Create new outstanding payment record
      outstandingPayment = new Payment({
        name: `${originalPayment.name} (Outstanding Balance)`,
        type: 'outstanding',
        amount: remainingAmount,
        description: `Remaining balance from ${originalPayment.name}. Original amount: ₦${totalTargetOrgAmount.toLocaleString()}, Total paid: ₦${totalPaidSoFar.toLocaleString()}`,
        user: originalPayment.user,
        organizationId: originalPayment.organizationId,
        paymentTypeId: originalPayment.paymentTypeId,
        parentPaymentId: originalPayment._id,
        status: 'unpaid',
        isPartial: true,
        dueDate: originalPayment.dueDate,
        metadata: {
          originalAmount: totalTargetOrgAmount,
          paidAmount: totalPaidSoFar,
          remainingAmount: remainingAmount,
          partialPayments: originalPayment.partialPayments
        }
      });
      await outstandingPayment.save();
    }
    
    return { remainingAmount, outstandingPayment };
  }
  
  return { remainingAmount: 0, outstandingPayment: null };
};

/**
 * Process a payment (full or partial) and handle outstanding balance
 */
const processPaymentWithOutstanding = async (payment, amountPaid, fees, reference, isPartial = false) => {
  // Update payment with fee breakdown
  payment.status = 'paid';
  payment.paidAt = new Date();
  payment.actualAmountPaid = amountPaid;
  payment.paystackFeeDeducted = fees.paystackFee;
  payment.afterPaystackAmount = fees.afterPaystack;
  payment.platformFeeDeducted = fees.platformFee;
  payment.netToOrganization = fees.netToOrg;
  
  let result = { remainingAmount: 0, outstandingPayment: null };
  
  if (isPartial) {
    // Handle partial payment - create/update outstanding record
    result = await createOrUpdateOutstandingPayment(payment, amountPaid, fees, reference);
    payment.remainingAmount = result.remainingAmount;
    payment.isPartial = result.remainingAmount > 0;
    
    console.log(`💰 Partial payment processed: Paid ₦${amountPaid.toFixed(2)} (Org gets ₦${fees.netToOrg.toFixed(2)}), Remaining: ₦${result.remainingAmount.toFixed(2)}`);
  }
  
  await payment.save();
  
  // Record income for this payment (what org receives from this transaction)
  await Income.create({
    amount: fees.netToOrg,
    source: `${payment.type} payment ${isPartial ? '(Partial)' : ''}`,
    date: new Date(),
    description: `Payment received. Member paid ₦${amountPaid.toFixed(2)}, fees: ₦${fees.totalFees.toFixed(2)}. ${result.remainingAmount > 0 ? `Outstanding balance: ₦${result.remainingAmount.toFixed(2)}` : 'Payment completed.'}`,
    paymentId: payment._id,
    paymentType: payment.type,
    transactionReference: reference,
    organizationId: payment.user?.organizationId,
    metadata: { 
      grossAmount: amountPaid,
      paystackFee: fees.paystackFee,
      platformFee: fees.platformFee,
      netToOrg: fees.netToOrg,
      isPartial,
      remainingAmount: result.remainingAmount
    }
  });
  
  return result;
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
    
    // payment.amount is what organization should receive (target amount)
    const targetOrgAmount = payment.amount;
    const memberPayAmount = calculateMemberPayAmount(targetOrgAmount);
    
    console.log(`💰 Target org amount: ₦${targetOrgAmount} → Member pays: ₦${memberPayAmount}`);
    
    if (!validateAmount(memberPayAmount)) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount calculation' });
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
    
    console.log('📤 Sending to Paystack with member amount:', memberPayAmount);
    
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
  try {
    const { reference } = req.params;
    
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
      const expectedAmount = payment.expectedAmount || payment.amount;
      
      // Check if this is a partial payment (member paid less than expected)
      const isPartialPayment = amountPaid < expectedAmount;
      const fees = calculateFeesFromPaidAmount(amountPaid);
      
      let partialResult = null;
      
      if (isPartialPayment) {
        // Handle partial payment with outstanding balance
        partialResult = await processPaymentWithOutstanding(payment, amountPaid, fees, reference, true);
        console.log(`⚠️ Partial payment detected! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Remaining: ₦${partialResult.remainingAmount}`);
      } else {
        // Full payment - standard processing
        payment.status = 'paid';
        payment.paidAt = new Date();
        payment.actualAmountPaid = amountPaid;
        payment.paystackFeeDeducted = fees.paystackFee;
        payment.afterPaystackAmount = fees.afterPaystack;
        payment.platformFeeDeducted = fees.platformFee;
        payment.netToOrganization = fees.netToOrg;
        await payment.save();
      }
      
      if (payment.type === 'registration') {
        await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
      }
      
      // Record EXPENDITURE for Paystack fee (with idempotency check)
      if (fees.paystackFee > 0) {
        const alreadyExists = await hasExpenditureRecord(payment._id, 'paystack');
        if (!alreadyExists) {
          await Expenditure.create({
            amount: fees.paystackFee,
            purpose: 'Payment Processing Fee',
            description: `Paystack transaction fee (${amountPaid >= 2500 ? '1.5% + ₦100' : '1.5%'}) for payment ${reference}`,
            createdBy: payment.user._id,
            organizationId: payment.user?.organizationId,
            receipt: null,
            metadata: {
              feeType: 'paystack',
              paymentId: payment._id,
              transactionReference: reference,
              grossAmount: amountPaid,
              percentage: 1.5,
              fixedFee: amountPaid >= 2500 ? 100 : 0,
              isPartial: isPartialPayment,
              timestamp: new Date().toISOString()
            }
          });
          console.log(`💰 Recorded Paystack fee expenditure: ₦${fees.paystackFee.toFixed(2)}`);
        }
      }
      
      // Record EXPENDITURE for Platform fee (with idempotency check)
      if (fees.platformFee > 0) {
        const alreadyExists = await hasExpenditureRecord(payment._id, 'platform');
        if (!alreadyExists) {
          await Expenditure.create({
            amount: fees.platformFee,
            purpose: 'Platform Service Fee',
            description: `Finlight platform fee (4% of after-Paystack amount) for payment ${reference}`,
            createdBy: payment.user._id,
            organizationId: payment.user?.organizationId,
            receipt: null,
            metadata: {
              feeType: 'platform',
              paymentId: payment._id,
              transactionReference: reference,
              afterPaystackAmount: fees.afterPaystack,
              percentage: 4,
              isPartial: isPartialPayment,
              timestamp: new Date().toISOString()
            }
          });
          console.log(`💰 Recorded Platform fee expenditure: ₦${fees.platformFee.toFixed(2)}`);
        }
      }
      
      // Record INCOME (what organization actually receives)
      await Income.create({
        amount: fees.netToOrg,
        source: `${payment.type} payment ${isPartialPayment ? '(Partial)' : ''}`,
        date: new Date(),
        description: `Payment received. Member paid ₦${amountPaid.toFixed(2)}, fees: ₦${fees.totalFees.toFixed(2)}. ${partialResult?.remainingAmount > 0 ? `Outstanding balance: ₦${partialResult.remainingAmount.toFixed(2)}` : 'Payment completed.'}`,
        paymentId: payment._id,
        paymentType: payment.type,
        transactionReference: reference,
        organizationId: payment.user?.organizationId,
        metadata: { 
          grossAmount: amountPaid,
          paystackFee: fees.paystackFee,
          platformFee: fees.platformFee,
          netToOrg: fees.netToOrg,
          isPartial: isPartialPayment,
          remainingAmount: partialResult?.remainingAmount || 0
        }
      });
      
      console.log(`✅ Payment verified: Member paid ₦${amountPaid.toFixed(2)} → Org receives: ₦${fees.netToOrg.toFixed(2)} (Fees: ₦${fees.totalFees.toFixed(2)})`);
      
      res.status(200).json({
        success: true,
        data: { 
          status: payment.status, 
          amount: payment.amount,
          isPartial: isPartialPayment,
          remainingAmount: partialResult?.remainingAmount || 0,
          breakdown: {
            memberPaid: amountPaid,
            expectedAmount: expectedAmount,
            paystackFee: fees.paystackFee,
            afterPaystack: fees.afterPaystack,
            platformFee: fees.platformFee,
            organizationReceives: fees.netToOrg,
            totalFees: fees.totalFees
          }
        },
        message: isPartialPayment ? 'Partial payment verified. Outstanding balance created.' : 'Payment verified successfully'
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
      const { reference, amount, fees } = event.data;
      const payment = await Payment.findOne({ transactionReference: reference })
        .populate('user', 'organizationId');
      
      if (payment && payment.status !== 'paid') {
        const amountPaid = amount / 100;
        const expectedAmount = payment.expectedAmount || payment.amount;
        const isPartialPayment = amountPaid < expectedAmount;
        
        const paystackFee = fees / 100;
        const afterPaystack = amountPaid - paystackFee;
        const platformFee = afterPaystack * 0.04;
        const netToOrg = afterPaystack - platformFee;
        const totalFees = paystackFee + platformFee;
        
        const feeData = {
          amountPaid,
          paystackFee,
          afterPaystack,
          platformFee,
          netToOrg,
          totalFees
        };
        
        let partialResult = null;
        
        if (isPartialPayment) {
          partialResult = await processPaymentWithOutstanding(payment, amountPaid, feeData, reference, true);
          console.log(`⚠️ Webhook - Partial payment! Paid: ₦${amountPaid}, Remaining: ₦${partialResult.remainingAmount}`);
        } else {
          payment.status = 'paid';
          payment.paidAt = new Date();
          payment.actualAmountPaid = amountPaid;
          payment.paystackFeeDeducted = paystackFee;
          payment.afterPaystackAmount = afterPaystack;
          payment.platformFeeDeducted = platformFee;
          payment.netToOrganization = netToOrg;
          await payment.save();
        }
        
        // Create expenditure records
        if (paystackFee > 0) {
          const alreadyExists = await hasExpenditureRecord(payment._id, 'paystack');
          if (!alreadyExists) {
            await Expenditure.create({
              amount: paystackFee,
              purpose: 'Payment Processing Fee',
              description: `Paystack fee for payment ${reference}`,
              createdBy: payment.user?._id,
              organizationId: payment.user?.organizationId,
              metadata: { feeType: 'paystack', paymentId: payment._id, isPartial: isPartialPayment }
            });
            console.log(`💰 Webhook - Recorded Paystack fee: ₦${paystackFee.toFixed(2)}`);
          }
        }
        
        if (platformFee > 0) {
          const alreadyExists = await hasExpenditureRecord(payment._id, 'platform');
          if (!alreadyExists) {
            await Expenditure.create({
              amount: platformFee,
              purpose: 'Platform Service Fee',
              description: `Finlight platform fee for payment ${reference}`,
              createdBy: payment.user?._id,
              organizationId: payment.user?.organizationId,
              metadata: { feeType: 'platform', paymentId: payment._id, isPartial: isPartialPayment }
            });
            console.log(`💰 Webhook - Recorded Platform fee: ₦${platformFee.toFixed(2)}`);
          }
        }
        
        console.log(`✅ Webhook processed: Member paid ₦${amountPaid.toFixed(2)} → Org receives: ₦${netToOrg.toFixed(2)}`);
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ success: false });
  }
});

// ==================== PARTIAL PAYMENT ENDPOINT ====================

/**
 * Admin endpoint to record manual partial payments (bank transfers)
 */
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
    
    const fees = calculateFeesFromPaidAmount(amountPaid);
    const result = await processPaymentWithOutstanding(originalPayment, amountPaid, fees, reference || `MANUAL-${Date.now()}`, true);
    
    res.status(200).json({
      success: true,
      data: {
        payment: originalPayment,
        remainingAmount: result.remainingAmount,
        outstandingPayment: result.outstandingPayment,
        fees
      },
      message: result.remainingAmount > 0 ? 'Partial payment recorded. Outstanding balance created.' : 'Payment completed successfully.'
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
      isPartial: true,
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