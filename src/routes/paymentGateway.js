// const express = require('express');
// const router = express.Router();
// const crypto = require('crypto');
// const rateLimit = require('express-rate-limit');
// const { protect } = require('../middleware/auth');
// const ValidationMiddleware = require('../middleware/validation');
// const Payment = require('../models/Payment');
// const User = require('../models/User');
// const Income = require('../models/Income');
// const Organization = require('../models/Organization');
// const { body, param } = require('express-validator');

// const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
// const PLATFORM_SUBACCOUNT = process.env.PLATFORM_SUBACCOUNT;
// const PAYSTACK_CALLBACK_URL = process.env.PAYSTACK_CALLBACK_URL || 'https://finlightv2.web.app/payment/callback';

// console.log('✅ Payment Gateway loaded');
// console.log('   Paystack Key:', PAYSTACK_SECRET_KEY ? 'Configured' : 'MISSING');
// console.log('   Platform Subaccount:', PLATFORM_SUBACCOUNT ? 'Configured' : 'MISSING');

// // ==================== RATE LIMITING ====================

// const paymentInitLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// const webhookLimiter = rateLimit({
//   windowMs: 1 * 60 * 1000,
//   max: 30,
//   message: { success: false, message: 'Too many webhook requests' }
// });

// const verifyLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 20,
//   skipSuccessfulRequests: true
// });

// const statusCheckLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 30,
//   message: { success: false, message: 'Too many status check requests' }
// });

// // ==================== HELPER FUNCTIONS ====================

// const generateIdempotencyKey = (paymentId) => {
//   return `pay_${paymentId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
// };

// const validateAmount = (amount) => {
//   const numAmount = Number(amount);
//   return !isNaN(numAmount) && numAmount > 0 && numAmount <= 10000000;
// };

// // Store for tracking verification in progress (in-memory, for distributed systems use Redis)
// const verificationInProgress = new Map();

// // ==================== FEE CALCULATION HELPERS ====================

// /**
//  * Calculate what member needs to pay so organization receives target amount
//  * Fees are ADDED ON TOP for card payments
//  */
// /**
//  * Calculate what member needs to pay so organization receives target amount
//  * Fees are ADDED ON TOP for card payments
//  */
// const calculateMemberPayAmount = (targetOrganizationAmount) => {
//   if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;

//   let memberPays = targetOrganizationAmount;
//   let iteration = 0;
//   const maxIterations = 30;

//   while (iteration < maxIterations) {
//     // Calculate Paystack fee based on memberPays
//     let paystackFee = memberPays * 0.015;
//     if (memberPays >= 2500) paystackFee += 100;
//     paystackFee = Math.min(paystackFee, 2000);

//     const afterPaystack = memberPays - paystackFee;
//     let platformFee = afterPaystack * 0.04;

//     // Round platform fee
//     platformFee = Math.round(platformFee * 100) / 100;

//     const orgGets = Math.round(afterPaystack - platformFee);

//     // If organization gets exactly what we want, we're done
//     if (orgGets === targetOrganizationAmount) {
//       break;
//     }

//     // If within 1 naira, adjust to exact amount
//     if (Math.abs(orgGets - targetOrganizationAmount) <= 1) {
//       const difference = targetOrganizationAmount - orgGets;
//       memberPays += difference;
//       break;
//     }

//     // Adjust memberPays based on the difference
//     const difference = targetOrganizationAmount - orgGets;
//     memberPays += difference;
//     iteration++;
//   }

//   return Math.ceil(memberPays);
// };

// /**
//  * Calculate fees for a given amount and return net to organization
//  */
// /**
//  * Calculate fees for a given amount and return net to organization
//  * Ensures organization receives exactly what they expect
//  */
// const calculateNetToOrganization = (amountPaid) => {
//   // Calculate fees
//   let paystackFee = amountPaid * 0.015;
//   if (amountPaid >= 2500) paystackFee += 100;
//   paystackFee = Math.min(paystackFee, 2000);

//   const afterPaystack = amountPaid - paystackFee;
//   let platformFee = afterPaystack * 0.04;

//   // Round platform fee to nearest kobo
//   platformFee = Math.round(platformFee * 100) / 100;

//   let netToOrg = afterPaystack - platformFee;

//   // Round net to nearest whole number
//   netToOrg = Math.round(netToOrg);

//   // Calculate total fees paid (rounded)
//   const totalFees = amountPaid - netToOrg;

//   return {
//     amountPaid,
//     paystackFee: Math.round(paystackFee),
//     afterPaystack: Math.round(afterPaystack),
//     platformFee: platformFee,
//     netToOrg: netToOrg,
//     totalFees: Math.round(totalFees)
//   };
// };

// // ==================== PARTIAL PAYMENT HELPERS ====================

// /**
//  * Process a partial payment (bank transfer or card underpayment)
//  * The organization amount remains the target, shortage becomes outstanding
//  */
// const processPartialPayment = async (originalPayment, amountPaid, reference, isManual = false) => {
//   const targetOrgAmount = originalPayment.targetOrgAmount || originalPayment.amount;
//   const totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;

//   // Calculate what organization gets from THIS payment (after fees)
//   const fees = calculateNetToOrganization(amountPaid);
//   const netToOrgFromThisPayment = fees.netToOrg;

//   // The organization's target amount remains the same (e.g., ₦5,000)
//   // The remaining amount the organization still needs to receive
//   const remainingOrgTarget = targetOrgAmount - totalPaidSoFar;

//   // Update original payment
//   originalPayment.totalPaidSoFar = totalPaidSoFar;
//   originalPayment.remainingAmount = remainingOrgTarget;
//   originalPayment.isPartial = remainingOrgTarget > 0;
//   originalPayment.partialPayments = originalPayment.partialPayments || [];
//   originalPayment.partialPayments.push({
//     amount: amountPaid,
//     netToOrg: netToOrgFromThisPayment,
//     date: new Date(),
//     transactionReference: reference,
//     fees: {
//       paystackFee: fees.paystackFee,
//       platformFee: fees.platformFee,
//       totalFees: fees.totalFees
//     }
//   });

//   if (remainingOrgTarget <= 0) {
//     originalPayment.status = 'paid';
//     originalPayment.completedAt = new Date();
//   } else {
//     originalPayment.status = 'partial';
//   }

//   await originalPayment.save();

//   // Record INCOME for this partial payment (what org actually gets from this transaction)
//   await Income.create({
//     amount: netToOrgFromThisPayment,
//     source: `${originalPayment.type} payment (Partial - ₦${amountPaid.toLocaleString()} paid)`,
//     date: new Date(),
//     description: `Partial payment of ₦${amountPaid.toLocaleString()} received. Fees: ₦${fees.totalFees.toLocaleString()}. Organization target: ₦${targetOrgAmount.toLocaleString()}, Remaining: ₦${remainingOrgTarget.toLocaleString()}`,
//     paymentId: originalPayment._id,
//     paymentType: originalPayment.type,
//     transactionReference: reference,
//     organizationId: originalPayment.user?.organizationId,
//     createdBy: originalPayment.user?._id,
//     metadata: {
//       isPartial: true,
//       partialAmount: amountPaid,
//       netToOrg: netToOrgFromThisPayment,
//       remainingTarget: remainingOrgTarget,
//       fees: { paystackFee: fees.paystackFee, platformFee: fees.platformFee }
//     }
//   });

//   // Create or update outstanding payment record for remaining target amount
//   let outstandingPayment = null;
//   if (remainingOrgTarget > 0) {
//     outstandingPayment = await Payment.findOne({
//       parentPaymentId: originalPayment._id,
//       type: 'outstanding',
//       status: 'unpaid'
//     });

//     if (outstandingPayment) {
//       outstandingPayment.amount = remainingOrgTarget;
//       outstandingPayment.targetOrgAmount = remainingOrgTarget;
//       outstandingPayment.description = `Outstanding balance of ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}`;
//       await outstandingPayment.save();
//     } else {
//       outstandingPayment = await Payment.create({
//         name: `${originalPayment.name} (Outstanding Balance)`,
//         type: 'outstanding',
//         amount: remainingOrgTarget,
//         targetOrgAmount: remainingOrgTarget,
//         description: `Remaining balance of ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}. Original amount: ₦${targetOrgAmount.toLocaleString()}, Total paid so far: ₦${totalPaidSoFar.toLocaleString()}`,
//         user: originalPayment.user,
//         organizationId: originalPayment.organizationId,
//         paymentTypeId: originalPayment.paymentTypeId,
//         parentPaymentId: originalPayment._id,
//         status: 'unpaid',
//         isPartial: true,
//         dueDate: originalPayment.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
//         createdBy: originalPayment.user?._id
//       });
//     }
//     console.log(`📝 Created outstanding record: ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}`);
//   }

//   console.log(`💰 Partial payment processed: Paid ₦${amountPaid.toLocaleString()} → Org net: ₦${netToOrgFromThisPayment.toLocaleString()}, Remaining target: ₦${remainingOrgTarget.toLocaleString()}`);


//   return {
//     amountPaid,
//     netToOrg: netToOrgFromThisPayment,
//     remainingTarget: remainingOrgTarget,
//     outstandingPayment
//   };
// };

// // ==================== VALIDATION RULES ====================

// const validatePaymentInit = [
//   body('paymentId').isMongoId().withMessage('Invalid payment ID format'),
//   body('idempotencyKey').optional().isString().trim().isLength({ min: 10, max: 100 }),
//   ValidationMiddleware.validate
// ];

// const validatePaymentVerification = [
//   param('reference').notEmpty().withMessage('Transaction reference is required')
//     .matches(/^PAY-[a-f0-9]+-\d+-[a-z0-9]+$/i).withMessage('Invalid reference format')
//     .isLength({ min: 20, max: 100 }),
//   ValidationMiddleware.validate
// ];

// // ==================== PAYMENT INITIALIZATION ====================

// router.post('/initialize', protect, paymentInitLimiter, validatePaymentInit, async (req, res) => {
//   try {
//     const { paymentId, idempotencyKey } = req.body;

//     console.log('📦 Payment initialization:', { paymentId });

//     const payment = await Payment.findById(paymentId).populate('user', 'name email organizationId');

//     if (!payment) {
//       return res.status(404).json({ success: false, message: 'Payment not found' });
//     }

//     if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
//       return res.status(403).json({ success: false, message: 'Not authorized' });
//     }

//     if (payment.status === 'paid') {
//       return res.status(400).json({ success: false, message: 'Payment already completed' });
//     }

//     const targetOrgAmount = payment.amount;
//     const memberPayAmount = calculateMemberPayAmount(targetOrgAmount);

//     console.log(`💰 Target org amount: ₦${targetOrgAmount} → Member should pay: ₦${memberPayAmount} (includes fees)`);

//     if (!validateAmount(memberPayAmount)) {
//       return res.status(400).json({ success: false, message: 'Invalid payment amount calculation' });
//     }

//     let organizationSubaccount = null;
//     let organization = null;

//     if (payment.user.organizationId) {
//       organization = await Organization.findById(payment.user.organizationId);
//       if (organization?.paystack?.subaccountCode) {
//         organizationSubaccount = organization.paystack.subaccountCode;
//         console.log(`✅ Organization subaccount: ${organizationSubaccount}`);
//       } else {
//         console.log(`⚠️ No subaccount for organization: ${payment.user.organizationId}`);
//       }
//     }

//     if (!organizationSubaccount) {
//       return res.status(400).json({
//         success: false,
//         message: 'Organization payment setup incomplete. Please contact admin.'
//       });
//     }

//     if (!PLATFORM_SUBACCOUNT) {
//       return res.status(500).json({
//         success: false,
//         message: 'Platform configuration error. Please contact support.'
//       });
//     }

//     const uniqueRef = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

//     const requestBody = {
//       email: payment.user.email,
//       amount: Math.round(memberPayAmount * 100),
//       reference: `PAY-${payment._id}-${uniqueRef}`,
//       callback_url: PAYSTACK_CALLBACK_URL,
//       subaccount: organizationSubaccount,
//       bearer: 'subaccount',
//       metadata: {
//         paymentId: payment._id.toString(),
//         userId: payment.user._id.toString(),
//         type: payment.type,
//         organizationId: payment.user.organizationId?.toString(),
//         organizationName: organization?.name,
//         targetOrgAmount: targetOrgAmount,
//         memberPayAmount: memberPayAmount
//       }
//     };

//     console.log('📤 Sending to Paystack with amount:', memberPayAmount);

//     const response = await fetch('https://api.paystack.co/transaction/initialize', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
//         'Content-Type': 'application/json',
//         'Idempotency-Key': idempotencyKey || generateIdempotencyKey(paymentId)
//       },
//       body: JSON.stringify(requestBody)
//     });

//     const data = await response.json();
//     console.log('📥 Paystack response:', data.status ? 'Success' : 'Failed', data.message);

//     if (!data.status) {
//       return res.status(400).json({ success: false, message: data.message || 'Failed to initialize payment' });
//     }

//     payment.transactionReference = data.data.reference;
//     payment.paymentUrl = data.data.authorization_url;
//     payment.expectedAmount = memberPayAmount;
//     payment.targetOrgAmount = targetOrgAmount;
//     await payment.save();

//     res.status(200).json({
//       success: true,
//       data: {
//         authorizationUrl: data.data.authorization_url,
//         reference: data.data.reference,
//         memberPayAmount,
//         targetOrgAmount
//       }
//     });

//   } catch (error) {
//     console.error('Payment initialization error:', error);
//     res.status(500).json({ success: false, message: error.message || 'Internal server error' });
//   }
// });

// // ==================== PAYMENT VERIFICATION ====================

// router.get('/verify/:reference', verifyLimiter, validatePaymentVerification, async (req, res) => {
//   const { reference } = req.params;

//   // Check if this reference is already being processed
//   if (verificationInProgress.has(reference)) {
//     console.log('⏳ Verification already in progress for:', reference);
//     await verificationInProgress.get(reference);
//     const payment = await Payment.findOne({ transactionReference: reference });
//     if (payment && payment.status === 'paid') {
//       return res.status(200).json({
//         success: true,
//         data: {
//           status: payment.status,
//           amount: payment.amount,
//           remainingAmount: payment.remainingAmount
//         },
//         message: 'Payment already verified'
//       });
//     }
//   }

//   // Create a promise to track this verification
//   let resolveVerification;
//   const verificationPromise = new Promise((resolve) => {
//     resolveVerification = resolve;
//   });
//   verificationInProgress.set(reference, verificationPromise);

//   try {
//     console.log('🔍 Verifying payment:', reference);

//     let payment = await Payment.findOne({ transactionReference: reference })
//       .populate('user', 'name email organizationId');

//     if (!payment) {
//       const match = reference.match(/PAY-([a-f0-9]+)-/);
//       if (match && match[1]) {
//         payment = await Payment.findById(match[1]).populate('user', 'name email organizationId');
//       }
//     }

//     if (!payment) {
//       verificationInProgress.delete(reference);
//       resolveVerification();
//       return res.status(404).json({ success: false, message: 'Payment not found' });
//     }

//     // Check if already paid
//     if (payment.status === 'paid') {
//       console.log('✅ Payment already verified and marked as paid');
//       verificationInProgress.delete(reference);
//       resolveVerification();
//       return res.status(200).json({
//         success: true,
//         data: {
//           status: payment.status,
//           amount: payment.amount,
//           remainingAmount: payment.remainingAmount,
//           isPartial: payment.isPartial
//         },
//         message: 'Payment already verified'
//       });
//     }

//     const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
//       method: 'GET',
//       headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
//     });

//     const data = await response.json();

//     if (data.status && data.data && data.data.status === 'success') {
//       const amountPaid = data.data.amount / 100;
//       const expectedAmount = payment.expectedAmount || payment.amount;

//       // Check if this is a partial payment (paid less than expected by more than 1 Naira)
//       const isPartialPayment = amountPaid < (expectedAmount - 1);

//       console.log(`💰 Amount paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Is Partial: ${isPartialPayment}`);
//       console.log(`Current payment status before update: ${payment.status}, remaining: ${payment.remainingAmount}`);

//       let result;

//       if (isPartialPayment) {
//         // Process partial payment - KEEPS Income creation (as requested)
//         result = await processPartialPayment(payment, amountPaid, reference, false);
//         console.log(`⚠️ Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Remaining target: ₦${result.remainingTarget}`);
//       } else {
//         // ✅ FULL PAYMENT - NO INCOME CREATION (just update payment status)
//         const exactOrgAmount = payment.targetOrgAmount || payment.amount;

//         // Force update using findOneAndUpdate
//         const updatedPayment = await Payment.findOneAndUpdate(
//           { _id: payment._id },
//           {
//             $set: {
//               status: 'paid',
//               paidAt: new Date(),
//               actualAmountPaid: amountPaid,
//               netToOrganization: exactOrgAmount,
//               totalPaidSoFar: amountPaid,
//               remainingAmount: 0,
//               isPartial: false,
//               completedAt: new Date()
//             }
//           },
//           { new: true }
//         );

//         console.log(`✅ Full payment recorded: Organization receives ₦${exactOrgAmount}`);
//         console.log(`📝 No Income record created - Payment record is the source of truth`);

//         // ❌ Income.create() REMOVED - not creating income for full payments

//         payment = updatedPayment;
//         result = { remainingTarget: 0 };
//       }

//       if (payment.type === 'registration') {
//         await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
//       }

//       console.log(`✅ Payment verified: Member paid ₦${amountPaid.toFixed(2)}, Final Status: ${payment.status}`);

//       verificationInProgress.delete(reference);
//       resolveVerification();

//       res.status(200).json({
//         success: true,
//         data: {
//           status: payment.status,
//           amount: payment.amount,
//           isPartial: isPartialPayment || false,
//           remainingAmount: result?.remainingTarget || payment.remainingAmount || 0,
//           totalPaidSoFar: payment.totalPaidSoFar || amountPaid
//         },
//         message: isPartialPayment ? `Partial payment of ₦${amountPaid.toLocaleString()} verified. Outstanding balance: ₦${result?.remainingTarget.toLocaleString()}` : 'Payment verified successfully'
//       });
//     } else {
//       verificationInProgress.delete(reference);
//       resolveVerification();
//       res.status(400).json({ success: false, message: data.message || 'Payment verification failed' });
//     }
//   } catch (error) {
//     console.error('Verification error:', error);
//     verificationInProgress.delete(reference);
//     resolveVerification();
//     res.status(500).json({ success: false, message: error.message });
//   }
// });
// // ==================== PAYMENT WEBHOOK ====================

// router.post('/webhook', webhookLimiter, async (req, res) => {
//   try {
//     let rawBody;
//     if (req.rawBody) {
//       rawBody = req.rawBody;
//     } else {
//       rawBody = JSON.stringify(req.body);
//     }

//     const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
//       .update(rawBody)
//       .digest('hex');

//     if (hash !== req.headers['x-paystack-signature']) {
//       console.log('❌ Invalid webhook signature');
//       return res.status(401).json({ success: false });
//     }

//     const event = req.body;
//     console.log('📨 Webhook received:', event.event);

//     if (event.event === 'charge.success') {
//       const { reference, amount } = event.data;

//       const payment = await Payment.findOne({
//         transactionReference: reference,
//         status: { $ne: 'paid' }
//       }).populate('user', 'organizationId');

//       if (payment && payment.status !== 'paid') {
//         const amountPaid = amount / 100;
//         const expectedAmount = payment.expectedAmount || payment.amount;
//         const isPartialPayment = amountPaid < (expectedAmount - 1);

//         if (isPartialPayment) {
//           // Partial payment - KEEPS Income creation
//           await processPartialPayment(payment, amountPaid, reference, false);
//           console.log(`⚠️ Webhook - Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}`);
//         } else {
//           // ✅ FULL PAYMENT - NO INCOME CREATION in webhook either
//           const fees = calculateNetToOrganization(amountPaid);

//           // Force update using findOneAndUpdate
//           await Payment.findOneAndUpdate(
//             { _id: payment._id },
//             {
//               $set: {
//                 status: 'paid',
//                 paidAt: new Date(),
//                 actualAmountPaid: amountPaid,
//                 netToOrganization: fees.netToOrg,
//                 totalPaidSoFar: amountPaid,
//                 remainingAmount: 0,
//                 isPartial: false,
//                 completedAt: new Date()
//               }
//             }
//           );

//           // ❌ NO Income.create() for full payments in webhook
//           console.log(`✅ Webhook - Full payment recorded. No Income record created.`);
//         }

//         console.log(`✅ Webhook processed: Member paid ₦${amountPaid.toFixed(2)}`);
//       }
//     }

//     res.status(200).json({ success: true });
//   } catch (error) {
//     console.error('Webhook error:', error);
//     res.status(200).json({ success: false });
//   }
// });

// // ==================== PARTIAL PAYMENT ENDPOINT (Admin for Bank Transfers) ====================

// router.post('/record-partial-payment', protect, async (req, res) => {
//   try {
//     const { paymentId, amountPaid, reference, notes } = req.body;

//     const originalPayment = await Payment.findById(paymentId).populate('user', 'organizationId');

//     if (!originalPayment) {
//       return res.status(404).json({ success: false, message: 'Payment not found' });
//     }

//     if (originalPayment.user.organizationId.toString() !== req.user.organizationId?.toString() && req.user.role !== 'admin') {
//       return res.status(403).json({ success: false, message: 'Not authorized' });
//     }

//     if (originalPayment.status === 'paid') {
//       return res.status(400).json({ success: false, message: 'Payment already completed' });
//     }

//     if (!amountPaid || amountPaid <= 0) {
//       return res.status(400).json({ success: false, message: 'Valid amount is required' });
//     }

//     const result = await processPartialPayment(originalPayment, amountPaid, reference || `MANUAL-${Date.now()}`, true);

//     res.status(200).json({
//       success: true,
//       data: {
//         payment: originalPayment,
//         amountPaid: result.amountPaid,
//         netToOrg: result.netToOrg,
//         remainingTarget: result.remainingTarget,
//         outstandingPayment: result.outstandingPayment
//       },
//       message: result.remainingTarget > 0
//         ? `Partial payment of ₦${amountPaid.toLocaleString()} recorded. Organization receives ₦${result.netToOrg.toLocaleString()}. Outstanding balance: ₦${result.remainingTarget.toLocaleString()}`
//         : 'Payment completed successfully'
//     });
//   } catch (error) {
//     console.error('Record partial payment error:', error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// });

// // ==================== GET OUTSTANDING PAYMENTS ====================

// router.get('/outstanding', protect, async (req, res) => {
//   try {
//     const query = {
//       user: req.user.id,
//       status: 'unpaid',
//       type: 'outstanding',
//       remainingAmount: { $gt: 0 }
//     };

//     const outstandingPayments = await Payment.find(query)
//       .populate('paymentTypeId', 'name type')
//       .sort({ dueDate: 1, createdAt: 1 });

//     const totalOutstanding = outstandingPayments.reduce((sum, p) => sum + (p.remainingAmount || p.amount), 0);

//     res.status(200).json({
//       success: true,
//       data: {
//         payments: outstandingPayments,
//         totalOutstanding,
//         count: outstandingPayments.length
//       }
//     });
//   } catch (error) {
//     console.error('Get outstanding payments error:', error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// });

// // ==================== PAYMENT STATUS CHECK ====================

// router.get('/status/:paymentId', protect, statusCheckLimiter, ValidationMiddleware.idParam, async (req, res) => {
//   try {
//     const { paymentId } = req.params;
//     const payment = await Payment.findById(paymentId).populate('user', 'name email');

//     if (!payment) {
//       return res.status(404).json({ success: false, message: 'Payment not found' });
//     }

//     if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
//       return res.status(403).json({ success: false, message: 'Not authorized' });
//     }

//     res.status(200).json({
//       success: true,
//       data: {
//         status: payment.status,
//         amount: payment.amount,
//         type: payment.type,
//         paidAt: payment.paidAt,
//         reference: payment.transactionReference,
//         remainingAmount: payment.remainingAmount,
//         isPartial: payment.isPartial,
//         totalPaidSoFar: payment.totalPaidSoFar
//       }
//     });
//   } catch (error) {
//     console.error('Status check error:', error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// });

// // ==================== TEST ROUTES ====================

// router.get('/test-route', (req, res) => {
//   res.json({
//     success: true,
//     message: 'Test route works!',
//     registeredRoutes: ['/health', '/verify/:reference', '/webhook', '/initialize', '/status/:paymentId', '/outstanding', '/record-partial-payment']
//   });
// });

// router.all('/webhook-test', (req, res) => {
//   console.log('🔥 Test webhook hit!');
//   res.json({
//     success: true,
//     message: 'Test webhook endpoint works!',
//     method: req.method
//   });
// });

// // ==================== HEALTH CHECK ====================

// router.get('/health', (req, res) => {
//   res.json({
//     status: 'OK',
//     service: 'payment-gateway',
//     paystack_configured: !!PAYSTACK_SECRET_KEY,
//     platform_subaccount: !!PLATFORM_SUBACCOUNT,
//     environment: process.env.NODE_ENV || 'development'
//   });
// });

// module.exports = router;


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
const Flutterwave = require('flutterwave-node-v3');

// ==================== ENVIRONMENT VARIABLES ====================
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const FLW_ENCRYPTION_KEY = process.env.FLW_ENCRYPTION_KEY;
const FLW_WEBHOOK_SECRET = process.env.FLW_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://finlightv2.web.app';

// Platform subaccount ID (where your 4% platform fee goes)
const PLATFORM_SUBACCOUNT_ID = process.env.PLATFORM_SUBACCOUNT_ID;

// Initialize Flutterwave SDK
const flw = new Flutterwave(FLW_PUBLIC_KEY, FLW_SECRET_KEY);

console.log('✅ Payment Gateway loaded (Flutterwave)');
console.log('   Flutterwave Key:', FLW_SECRET_KEY ? 'Configured' : 'MISSING');
console.log('   Platform Subaccount ID:', PLATFORM_SUBACCOUNT_ID ? 'Configured' : 'MISSING');

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

// ==================== RETRY HELPER ====================
/**
 * Execute a function with exponential backoff retry
 * @param {Function} fn - Async function to execute
 * @param {number} maxRetries - Maximum retry attempts (default 3)
 * @param {number} baseDelay - Initial delay in ms (default 1000)
 * @returns {Promise<any>} - Result of the function
 */
const withRetry = async (fn, maxRetries = 3, baseDelay = 1000) => {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.response?.status >= 500 ||
        error.code === 'ECONNRESET' ||
        error.message?.includes('network') ||
        error.message?.includes('timeout');

      if (!isRetryable || attempt === maxRetries - 1) throw error;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Flutterwave API call failed, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
};


const validateAmount = (amount) => {
  const numAmount = Number(amount);
  return !isNaN(numAmount) && numAmount > 0 && numAmount <= 10000000;
};

// In‑memory verification tracker
const verificationInProgress = new Map();

// ==================== FEE CALCULATION (2% + 4% = 6% total) ====================
/**
 * Member pays = targetOrgAmount / (1 - 0.02 - 0.04) = target / 0.94
 * This amount includes Flutterwave 2% + Platform 4% fees.
 */
const calculateMemberPayAmount = (targetOrganizationAmount) => {
  if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;

  // Initial calculation
  let memberPays = targetOrganizationAmount / 0.94;
  memberPays = Math.ceil(memberPays);

  // Verify net to organisation is at least target (with tolerance of 1 NGN)
  let netToOrg = calculateNetToOrganization(memberPays).netToOrg;
  let iterations = 0;
  while (netToOrg < targetOrganizationAmount && iterations < 5) {
    memberPays++;
    netToOrg = calculateNetToOrganization(memberPays).netToOrg;
    iterations++;
  }

  return memberPays;
};
/**
 * Given the amount a member actually paid, calculate:
 * - Flutterwave fee (2%)
 * - Platform fee (4%)
 * - Net amount the organization receives
 */
const calculateNetToOrganization = (amountPaid, targetOrgAmount = null) => {
  let flutterwaveFee = amountPaid * 0.02;
  let platformFee = amountPaid * 0.04;
  let totalFees = flutterwaveFee + platformFee;
  let netToOrg = amountPaid - totalFees;

  let roundedNet = Math.round(netToOrg);
  let roundedFlutterwave = Math.round(flutterwaveFee);
  let roundedPlatform = Math.round(platformFee);
  let roundedTotalFees = roundedFlutterwave + roundedPlatform;

  // If a target is provided and net differs by more than 1 NGN, adjust net to match target
  if (targetOrgAmount && Math.abs(roundedNet - targetOrgAmount) > 1) {
    roundedNet = targetOrgAmount;
    console.log(`Fee adjustment: netToOrg changed from ${Math.round(netToOrg)} to ${targetOrgAmount} (difference: ${targetOrgAmount - Math.round(netToOrg)})`);
  }

  // Safety clamp
  if (roundedNet < 0) roundedNet = 0;

  return {
    amountPaid,
    flutterwaveFee: roundedFlutterwave,
    platformFee: roundedPlatform,
    netToOrg: roundedNet,
    totalFees: roundedTotalFees
  };
};

// ==================== PARTIAL PAYMENT HELPERS ====================
/**
 * Process a partial payment (card underpayment or bank transfer).
 * Fees are calculated on the actual amount paid.
 */
const processPartialPayment = async (originalPayment, amountPaid, reference, isManual = false) => {
  const targetOrgAmount = originalPayment.targetOrgAmount || originalPayment.amount;
  const totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;

  // Calculate what organization gets from THIS payment (after 2% + 4% fees)
  const fees = calculateNetToOrganization(amountPaid);
  const netToOrgFromThisPayment = fees.netToOrg;

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
      flutterwaveFee: fees.flutterwaveFee,
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

  // Record INCOME for this partial payment
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
      fees: { flutterwaveFee: fees.flutterwaveFee, platformFee: fees.platformFee }
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
    .isLength({ min: 10, max: 100 }),
  ValidationMiddleware.validate
];

// ==================== PAYMENT INITIALIZATION (FLUTTERWAVE WITH TWO SUBACCOUNTS) ====================
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
    if (!PLATFORM_SUBACCOUNT_ID) {
      console.error('❌ PLATFORM_SUBACCOUNT_ID is not set in environment');
      return res.status(500).json({
        success: false,
        message: 'Platform configuration error. Please contact support.'
      });
    }
    const targetOrgAmount = payment.amount;
    const memberPayAmount = calculateMemberPayAmount(targetOrgAmount);
    console.log(`💰 Target org amount: ₦${targetOrgAmount} → Member should pay: ₦${memberPayAmount} (includes 2% Flutterwave + 4% platform fees)`);

    if (!validateAmount(memberPayAmount)) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount calculation' });
    }

    // Get organization's Flutterwave subaccount ID
    let organizationSubaccountId = null;
    let organization = null;
    if (payment.user.organizationId) {
      organization = await Organization.findById(payment.user.organizationId);
      if (organization?.flutterwave?.subaccountId) {
        organizationSubaccountId = organization.flutterwave.subaccountId;
        console.log(`✅ Organization subaccount ID: ${organizationSubaccountId}`);
      } else {
        console.log(`⚠️ No Flutterwave subaccount for organization: ${payment.user.organizationId}`);
      }
    }

    if (!organizationSubaccountId) {
      return res.status(400).json({
        success: false,
        message: 'Organization payment setup incomplete. Please contact admin.'
      });
    }

    if (!PLATFORM_SUBACCOUNT_ID) {
      return res.status(500).json({
        success: false,
        message: 'Platform configuration error. Please contact support.'
      });
    }

    // Calculate platform fee amount (4% of memberPayAmount)
    const platformFeeAmount = Math.round(memberPayAmount * 0.04);

    // Generate unique transaction reference
    const uniqueRef = `PAY-${payment._id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Split configuration: organization receives target amount, platform receives 4% fee
    const subaccounts = [
      {
        id: organizationSubaccountId,
        transaction_split_type: 'flat',
        transaction_split_value: targetOrgAmount
      },
      {
        id: PLATFORM_SUBACCOUNT_ID,
        transaction_split_type: 'flat',
        transaction_split_value: platformFeeAmount
      }
    ];

    const payload = {
      tx_ref: uniqueRef,
      amount: memberPayAmount,
      currency: "NGN",
      redirect_url: `${FRONTEND_URL}/payment-verify`,
      customer: {
        email: payment.user.email,
        name: payment.user.name || 'Member'
      },
      subaccounts: subaccounts,
      meta: {
        payment_id: payment._id.toString(),
        user_id: payment.user._id.toString(),
        target_org_amount: targetOrgAmount,
        member_pay_amount: memberPayAmount,
        platform_fee: platformFeeAmount
      }
    };

    console.log('📤 Sending to Flutterwave with split:', payload);
    const response = await withRetry(() => flw.Payment.initiate(payload));
    if (response.status === 'success') {
      payment.transactionReference = response.data.tx_ref;
      payment.paymentUrl = response.data.link;
      payment.expectedAmount = memberPayAmount;
      payment.targetOrgAmount = targetOrgAmount;
      await payment.save();

      return res.status(200).json({
        success: true,
        data: {
          authorizationUrl: response.data.link,
          reference: response.data.tx_ref,
          memberPayAmount,
          targetOrgAmount
        }
      });
    } else {
      throw new Error(response.message || 'Flutterwave initialization failed');
    }
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
});

// ==================== PAYMENT VERIFICATION ====================
router.get('/verify/:reference', verifyLimiter, validatePaymentVerification, async (req, res) => {
  const { reference } = req.params;

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

  let resolveVerification;
  const verificationPromise = new Promise((resolve) => { resolveVerification = resolve; });
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

    // Verify with Flutterwave
    const response = await withRetry(() => flw.Transaction.verify({ id: reference }));
    if (response.status === 'success' && response.data.status === 'successful') {
      const amountPaid = response.data.amount; // already in NGN
      const expectedAmount = payment.expectedAmount || payment.amount;
      const isPartialPayment = amountPaid < (expectedAmount - 1);

      console.log(`💰 Amount paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Is Partial: ${isPartialPayment}`);

      let result;
      if (isPartialPayment) {
        result = await processPartialPayment(payment, amountPaid, reference, false);
        console.log(`⚠️ Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Remaining target: ₦${result.remainingTarget}`);
      } else {
        // Full payment – mark as paid (no income creation here, handled by webhook or separate accounting)
        await Payment.findOneAndUpdate(
          { _id: payment._id },
          {
            $set: {
              status: 'paid',
              paidAt: new Date(),
              actualAmountPaid: amountPaid,
              netToOrganization: payment.targetOrgAmount,
              totalPaidSoFar: amountPaid,
              remainingAmount: 0,
              isPartial: false,
              completedAt: new Date()
            }
          }
        );
        result = { remainingTarget: 0 };
        console.log(`✅ Full payment recorded: Organization receives ₦${payment.targetOrgAmount}`);
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
      res.status(400).json({ success: false, message: response.message || 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    verificationInProgress.delete(reference);
    resolveVerification();
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PAYMENT WEBHOOK (FLUTTERWAVE) ====================
router.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_WEBHOOK_SECRET) {
      console.log('❌ Invalid webhook signature');
      return res.status(401).json({ success: false });
    }

    const event = req.body;
    console.log('📨 Webhook received:', event.event);

    if (event.event === 'charge.completed' && event.data.status === 'successful') {
      const { tx_ref, amount } = event.data;
      const amountPaid = amount; // already in NGN

      const payment = await Payment.findOne({
        transactionReference: tx_ref,
        status: { $ne: 'paid' }
      }).populate('user', 'organizationId');

      if (payment && payment.status !== 'paid') {
        const expectedAmount = payment.expectedAmount || payment.amount;
        const isPartialPayment = amountPaid < (expectedAmount - 1);

        if (isPartialPayment) {
          await processPartialPayment(payment, amountPaid, tx_ref, false);
          console.log(`⚠️ Webhook - Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}`);
        } else {
          await Payment.findOneAndUpdate(
            { _id: payment._id },
            {
              $set: {
                status: 'paid',
                paidAt: new Date(),
                actualAmountPaid: amountPaid,
                netToOrganization: payment.targetOrgAmount,
                totalPaidSoFar: amountPaid,
                remainingAmount: 0,
                isPartial: false,
                completedAt: new Date()
              }
            }
          );
          console.log(`✅ Webhook - Full payment recorded.`);
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
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
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

router.post('/organizations/resolve-account', protect, async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    const response = await flw.Misc.verify_Account({
      account_number: accountNumber,
      account_bank: bankCode
    });

    if (response.status === 'success') {
      return res.json({
        success: true,
        accountName: response.data.account_name
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Unable to verify account'
    });
  } catch (error) {
    console.error('Account verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Account verification failed'
    });
  }
});


// GET /api/flutterwave/banks
// GET /api/flutterwave/banks
router.get('/flutterwave/banks', protect, async (req, res) => {
  try {
    // Check if the SDK has the right method
    let response;

    // Try different possible method names
    if (typeof flw.Bank.getBanks === 'function') {
      response = await flw.Bank.getBanks({ country: 'NG' });
    } else if (typeof flw.Bank.list === 'function') {
      response = await flw.Bank.list({ country: 'NG' });
    } else if (typeof flw.Bank.country === 'function') {
      response = await flw.Bank.country({ country: 'NG' });
    } else if (typeof flw.Bank.ng === 'function') {
      response = await flw.Bank.ng({ country: 'NG' });
    } else {
      // If none of the SDK methods work, use direct API call
      const axios = require('axios');
      const apiResponse = await axios.get('https://api.flutterwave.com/v3/banks/NG', {
        headers: {
          'Authorization': `Bearer ${FLW_SECRET_KEY}`
        }
      });
      response = apiResponse.data;
    }

    if (response && response.status === 'success') {
      return res.json({
        success: true,
        data: response.data
      });
    }

    throw new Error('Unable to fetch banks');
  } catch (error) {
    console.error('Error fetching banks from Flutterwave:', error);

    // Return fallback banks
    const fallbackBanks = [
      { name: 'Access Bank', code: '044' },
      { name: 'Citibank', code: '023' },
      { name: 'Ecobank', code: '050' },
      { name: 'Fidelity Bank', code: '070' },
      { name: 'First Bank', code: '011' },
      { name: 'First City Monument Bank', code: '214' },
      { name: 'Guaranty Trust Bank', code: '058' },
      { name: 'Heritage Bank', code: '030' },
      { name: 'Keystone Bank', code: '082' },
      { name: 'Polaris Bank', code: '076' },
      { name: 'Providus Bank', code: '101' },
      { name: 'Stanbic IBTC Bank', code: '221' },
      { name: 'Standard Chartered Bank', code: '068' },
      { name: 'Sterling Bank', code: '232' },
      { name: 'Suntrust Bank', code: '100' },
      { name: 'Titan Trust Bank', code: '102' },
      { name: 'Union Bank', code: '032' },
      { name: 'United Bank for Africa', code: '033' },
      { name: 'Unity Bank', code: '215' },
      { name: 'Wema Bank', code: '035' },
      { name: 'Zenith Bank', code: '057' }
    ];

    return res.json({
      success: true,
      data: fallbackBanks,
      fromCache: true
    });
  }
});

// ==================== HEALTH CHECK ====================
router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'payment-gateway',
    flutterwave_configured: !!FLW_SECRET_KEY,
    platform_subaccount_configured: !!PLATFORM_SUBACCOUNT_ID,
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;