
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

// ===== FIX: Extract first URL from the list =====
const rawFrontendUrl = process.env.FRONTEND_URL || 'https://finlightv2.web.app';
const FRONTEND_URL = rawFrontendUrl.split(',')[0].trim();
console.log('📌 Using FRONTEND_URL:', FRONTEND_URL);
// const FRONTEND_URL = process.env.FRONTEND_URL || 'https://finlightv2.web.app';

// Platform subaccount ID (where your 2% platform fee goes)
const PLATFORM_SUBACCOUNT_ID = process.env.PLATFORM_SUBACCOUNT_ID;

// Initialize Flutterwave SDK
// ===== FIX: Proper Flutterwave SDK Initialization with Fallback =====
const axios = require('axios');
let flw;

try {
    // Initialize with public and secret keys
    flw = new Flutterwave(FLW_PUBLIC_KEY, FLW_SECRET_KEY);
    console.log('✅ Flutterwave SDK initialized successfully');
    console.log('   Payment object exists:', !!flw.Payment);
    console.log('   initiate method exists:', typeof flw.Payment?.initiate === 'function');
} catch (error) {
    console.error('❌ Flutterwave SDK initialization error:', error.message);
    console.error('   Public Key present:', !!FLW_PUBLIC_KEY);
    console.error('   Secret Key present:', !!FLW_SECRET_KEY);

    // Create a fallback that uses direct API calls
    flw = {
        Payment: {
            initiate: async (payload) => {
                console.log('🔄 Using direct API call fallback for payment...');
                const response = await axios.post(
                    'https://api.flutterwave.com/v3/payments',
                    payload,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                return response.data;
            }
        },
        Transaction: {
            verify: async ({ id }) => {
                console.log('🔄 Using direct API call for verification...');
                const response = await axios.get(
                    `https://api.flutterwave.com/v3/transactions/${id}/verify`,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`
                        }
                    }
                );
                return response.data;
            }
        },
        Subaccount: {
            create: async (payload) => {
                console.log('🔄 Using direct API call for subaccount creation...');
                const response = await axios.post(
                    'https://api.flutterwave.com/v3/subaccounts',
                    payload,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                return response.data;
            }
        },
        // In the fallback section, update Misc:
        // In the fallback section, ensure Misc.verify_Account is properly set up:
        Misc: {
            verify_Account: async ({ account_number, account_bank }) => {
                console.log('🔄 Using direct API call fallback for account verification...');
                try {
                    // Try with the bank code as provided
                    const response = await axios.post(
                        'https://api.flutterwave.com/v3/accounts/resolve',
                        {
                            account_number: account_number,
                            account_bank: String(account_bank)  // Ensure it's a string
                        },
                        {
                            headers: {
                                'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    return response.data;
                } catch (error) {
                    console.error('❌ Account verification fallback error:', error.response?.data || error.message);
                    // Return a structured error that matches the SDK format
                    return {
                        status: 'error',
                        message: error.response?.data?.message || 'Account verification failed'
                    };
                }
            }
        },
        Bank: {
            get_banks: async ({ country }) => {
                const response = await axios.get(
                    `https://api.flutterwave.com/v3/banks/${country}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`
                        }
                    }
                );
                return response.data;
            },
            list: async ({ country }) => {
                const response = await axios.get(
                    `https://api.flutterwave.com/v3/banks/${country}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`
                        }
                    }
                );
                return response.data;
            },
            country: async ({ country }) => {
                const response = await axios.get(
                    `https://api.flutterwave.com/v3/banks/${country}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`
                        }
                    }
                );
                return response.data;
            },
            ng: async () => {
                const response = await axios.get(
                    'https://api.flutterwave.com/v3/banks/NG',
                    {
                        headers: {
                            'Authorization': `Bearer ${FLW_SECRET_KEY}`
                        }
                    }
                );
                return response.data;
            }
        }
    };
}

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

// ==================== FEE CALCULATION (2% + 2% = 6% total) ====================
/**
 * Member pays = targetOrgAmount / (1 - 0.02 - 0.02) = target / 0.96
 * This amount includes Flutterwave 2% + Platform 2% fees.
 */
const calculateMemberPayAmount = (targetOrganizationAmount) => {
    if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;

    // Initial calculation
    let memberPays = targetOrganizationAmount / 0.96;
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
 * - Platform fee (2%)
 * - Net amount the organization receives
 */
const calculateNetToOrganization = (amountPaid, targetOrgAmount = null) => {
    let flutterwaveFee = amountPaid * 0.02;
    let platformFee = amountPaid * 0.02;
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

    // Calculate what organization gets from THIS payment (after 2% + 2% fees)
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
    body('amount').optional().isNumeric().withMessage('Amount must be a number').custom(value => {
        if (value && value <= 0) {
            throw new Error('Amount must be greater than 0');
        }
        if (value && value > 10000000) {
            throw new Error('Amount cannot exceed ₦10,000,000');
        }
        return true;
    }),
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
    console.log('🔥🔥🔥 /initialize route was called! 🔥🔥🔥');
    console.log('Request body:', req.body);
    console.log('User:', req.user?.id);

    try {
        console.log('🔍 Flutterwave SDK status:', {
            hasFlw: !!flw,
            hasPayment: !!(flw?.Payment),
            hasInitiate: typeof flw?.Payment?.initiate === 'function'
        });

        const { paymentId, idempotencyKey, amount: customAmount } = req.body;
        console.log('📦 Payment initialization:', { paymentId, customAmount });

        const payment = await Payment.findById(paymentId).populate('user', 'name email organizationId');
        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        // ===== DEBUG: Log the payment BEFORE initialization =====
        console.log('📋 Payment BEFORE initialization:', {
            id: payment._id,
            status: payment.status,
            transactionReference: payment.transactionReference,  // Should show "PENDING-..."
            amount: payment.amount,
            name: payment.name
        });

        if (payment.user._id.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        if (payment.status === 'paid') {
            return res.status(400).json({ success: false, message: 'Payment already completed' });
        }
        if (payment.createdAt < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
            return res.status(400).json({
                success: false,
                message: 'Payment request has expired (24 hours). Please create a new one.'
            });
        }
        if (!PLATFORM_SUBACCOUNT_ID) {
            console.error('❌ PLATFORM_SUBACCOUNT_ID is not set in environment');
            return res.status(500).json({
                success: false,
                message: 'Platform configuration error. Please contact support.'
            });
        }

        const targetOrgAmount = payment.amount;
        const isPartialPayment = customAmount && customAmount > 0 && customAmount < targetOrgAmount;

        let memberPayAmount;
        if (customAmount && customAmount > 0) {
            memberPayAmount = customAmount;
            console.log(`💰 Custom amount provided: ₦${memberPayAmount} (${isPartialPayment ? 'PARTIAL' : 'FULL'})`);
        } else {
            memberPayAmount = calculateMemberPayAmount(targetOrgAmount);
            console.log(`💰 Calculated amount: ₦${memberPayAmount} (FULL)`);
        }

        if (!validateAmount(memberPayAmount)) {
            return res.status(400).json({ success: false, message: 'Invalid payment amount calculation' });
        }

        // Get organization's Flutterwave subaccount ID
        let organizationSubaccountId = null;
        let organization = null;
        if (payment.user.organizationId) {
            organization = await Organization.findById(payment.user.organizationId);
            if (organization?.flutterwave?.subaccountCode) {
                organizationSubaccountId = organization.flutterwave.subaccountCode;
                console.log(`✅ Organization subaccount Code: ${organizationSubaccountId}`);
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

        const platformFeeAmount = Math.round(memberPayAmount * 0.02);
        const organizationAmount = memberPayAmount - platformFeeAmount;
        const uniqueRef = `PAY-${payment._id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const effectiveOrgPercentage = (96 / 98) * 100;

        const subaccounts = [
            {
                id: organizationSubaccountId,
                transaction_split_type: 'percentage',
                transaction_split_value: effectiveOrgPercentage
            }
        ];
        console.log('📤 Split configuration:', {
            organizationSubaccount: organizationSubaccountId,
            organizationGets: organizationAmount,
            platformSubaccount: PLATFORM_SUBACCOUNT_ID,
            platformGets: platformFeeAmount,
            memberPays: memberPayAmount
        });

        const payload = {
            tx_ref: uniqueRef,
            amount: memberPayAmount,
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
                platform_fee: platformFeeAmount,
                is_partial_payment: isPartialPayment,
                custom_amount: customAmount || null,
                remaining_balance: isPartialPayment ? targetOrgAmount - customAmount : 0
            }
        };

        console.log('📤 Sending to Flutterwave with split:', payload);

        console.log('🔄 Using direct API call to Flutterwave...');
        const response = await withRetry(async () => {
            const axiosResponse = await axios.post(
                'https://api.flutterwave.com/v3/payments',
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            console.log('📥 Flutterwave API response status:', axiosResponse.data.status);
            return axiosResponse.data;
        });

        if (response.status === 'success') {
            console.log('📥 Full Flutterwave response:', JSON.stringify(response, null, 2));

            // Try to get tx_ref from response, or fallback to existing
            const txRef = response.data?.tx_ref ||
                response.data?.data?.tx_ref ||
                response.data?.link?.split('/pay/')[1] ||
                payment.transactionReference;  // ✅ Fallback to existing

            console.log('🔄 Extracted tx_ref:', txRef);

            const link = response.data?.link || response.data?.data?.link;
            console.log('🔄 Extracted link:', link);

            // Only update if we got a new reference
            if (txRef && txRef !== payment.transactionReference) {
                payment.transactionReference = txRef;
                console.log('✅ Updated transactionReference from Flutterwave:', txRef);
            } else {
                console.log('ℹ️ Keeping existing transactionReference:', payment.transactionReference);
            }

            payment.paymentUrl = link;
            payment.expectedAmount = memberPayAmount;
            payment.targetOrgAmount = targetOrgAmount;

            if (isPartialPayment) {
                payment.isPartial = true;
                payment.remainingAmount = targetOrgAmount - customAmount;
                payment.totalPaidSoFar = 0;
            }

            await payment.save();
            console.log('💰 AFTER save, transactionReference:', payment.transactionReference);

            const verifyPayment = await Payment.findById(payment._id);
            console.log('✅ VERIFY from database, transactionReference:', verifyPayment.transactionReference);

            return res.status(200).json({
                success: true,
                data: {
                    authorizationUrl: link,
                    reference: payment.transactionReference,
                    memberPayAmount,
                    targetOrgAmount,
                    isPartialPayment,
                    remainingBalance: isPartialPayment ? targetOrgAmount - customAmount : 0
                },
                message: isPartialPayment
                    ? `Partial payment of ₦${memberPayAmount} initialized. Remaining balance: ₦${targetOrgAmount - customAmount}`
                    : 'Payment initialized successfully'
            });
        } else {
            throw new Error(response.message || 'Flutterwave initialization failed');
        }
    } catch (error) {
        console.error('❌ Payment initialization error:', error);
        console.error('❌ Error details:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
});

// ==================== PAYMENT VERIFICATION ====================
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
        console.log('🔍 Verifying payment with reference:', reference);

        // First try to find by transactionReference
        let payment = await Payment.findOne({ transactionReference: reference })
            .populate('user', 'name email organizationId');

        // If not found, try to extract payment ID from reference
        if (!payment) {
            const match = reference.match(/PAY-([a-f0-9]+)-/);
            if (match && match[1]) {
                payment = await Payment.findById(match[1]).populate('user', 'name email organizationId');
                if (payment) {
                    console.log('✅ Found payment by ID from reference:', payment._id);
                }
            }
        }

        if (!payment) {
            verificationInProgress.delete(reference);
            resolveVerification();
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        // Log payment details for debugging
        console.log('📊 Payment details:', {
            id: payment._id,
            status: payment.status,
            paymentTypeId: payment.paymentTypeId,
            amount: payment.amount,
            transactionReference: payment.transactionReference
        });

        // If already paid, return success
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

        // ===== Verify with Flutterwave =====
        console.log('🔄 Verifying with Flutterwave using reference:', reference);

        const verifyUrl = `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${reference}`;

        const response = await withRetry(async () => {
            const axiosResponse = await axios.get(verifyUrl, {
                headers: {
                    'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log('📥 Flutterwave verify response status:', axiosResponse.data.status);
            return axiosResponse.data;
        });

        // ===== Check if payment was successful =====
        console.log('🔍 Full Flutterwave response:', JSON.stringify(response, null, 2));

        if (response.status === 'success' && response.data && response.data.status === 'successful') {
            const amountPaid = response.data.amount || response.data.charged_amount || 0;
            const expectedAmount = payment.expectedAmount || payment.amount;
            const isPartialPayment = amountPaid < (expectedAmount - 1);

            console.log(`💰 Amount paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Is Partial: ${isPartialPayment}`);

            let result;
            if (isPartialPayment) {
                result = await processPartialPayment(payment, amountPaid, reference, false);
                console.log(`⚠️ Partial payment! Paid: ₦${amountPaid}, Expected: ₦${expectedAmount}, Remaining target: ₦${result.remainingTarget}`);
            } else {
                // ===== Mark payment as paid =====
                const updatedPayment = await Payment.findOneAndUpdate(
                    { _id: payment._id },
                    {
                        $set: {
                            status: 'paid',
                            paidAt: new Date(),
                            actualAmountPaid: amountPaid,
                            netToOrganization: payment.targetOrgAmount || payment.amount,
                            totalPaidSoFar: amountPaid,
                            remainingAmount: 0,
                            isPartial: false,
                            completedAt: new Date(),
                            transactionReference: reference
                        }
                    },
                    { new: true }
                );
                console.log(`✅ Full payment recorded: Organization receives ₦${payment.targetOrgAmount || payment.amount}`);
                console.log(`📝 Payment status updated to: ${updatedPayment.status}`);
                result = { remainingTarget: 0 };
                payment = updatedPayment;
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
                    totalPaidSoFar: payment.totalPaidSoFar || amountPaid,
                    paymentTypeId: payment.paymentTypeId
                },
                message: isPartialPayment ? `Partial payment of ₦${amountPaid.toLocaleString()} verified. Outstanding balance: ₦${result?.remainingTarget.toLocaleString()}` : 'Payment verified successfully'
            });
        } else {
            console.log('⚠️ Payment verification response:', response);
            console.log('⚠️ Status:', response.status);
            console.log('⚠️ Data status:', response.data?.status);

            // If payment is still pending, return pending status
            if (response.data?.status === 'pending' || response.status === 'pending') {
                verificationInProgress.delete(reference);
                resolveVerification();
                return res.status(200).json({
                    success: true,
                    data: {
                        status: 'pending',
                        amount: payment.amount,
                        remainingAmount: payment.remainingAmount || payment.amount,
                        totalPaidSoFar: payment.totalPaidSoFar || 0,
                        paymentTypeId: payment.paymentTypeId
                    },
                    message: 'Payment is still processing. Please check back later.'
                });
            }

            // If payment was cancelled, update status to unpaid so user can retry
            if (response.data?.status === 'cancelled' || response.data?.status === 'failed') {
                await Payment.findByIdAndUpdate(payment._id, {
                    $set: {
                        status: 'unpaid',
                        remainingAmount: payment.amount,
                        totalPaidSoFar: 0
                    }
                });
                console.log('🔄 Payment was cancelled, status updated to unpaid');

                verificationInProgress.delete(reference);
                resolveVerification();
                return res.status(200).json({
                    success: true,
                    data: {
                        status: 'unpaid',
                        amount: payment.amount,
                        remainingAmount: payment.amount,
                        totalPaidSoFar: 0,
                        paymentTypeId: payment.paymentTypeId
                    },
                    message: 'Payment was cancelled. You can try again.'
                });
            }

            verificationInProgress.delete(reference);
            resolveVerification();
            res.status(400).json({
                success: false,
                message: response.message || 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Verification error:', error);
        console.error('Error details:', error.response?.data || error.message);
        verificationInProgress.delete(reference);
        resolveVerification();
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
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
            // Check if payment was already processed
            const existingPayment = await Payment.findOne({
                transactionReference: tx_ref,
                status: 'paid'
            });
            if (existingPayment) {
                console.log('⚠️ Payment already processed, ignoring duplicate webhook');
                return res.status(200).json({ success: true });
            }
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
                                completedAt: new Date(),
                                transactionReference: tx_ref  // ✅ ADD THIS LINE
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

// ==================== RESOLVE ACCOUNT (FLUTTERWAVE) ====================
// ==================== RESOLVE ACCOUNT (FLUTTERWAVE SDK) ====================
// ==================== RESOLVE ACCOUNT (FLUTTERWAVE) ====================
router.post('/organizations/resolve-account', protect, async (req, res) => {
    try {
        const { accountNumber, bankCode } = req.body;

        console.log('🔍 Resolving account:', { accountNumber, bankCode, type: typeof bankCode });

        // Validate inputs
        if (!accountNumber || !bankCode) {
            return res.status(400).json({
                success: false,
                message: 'Account number and bank code are required'
            });
        }

        if (!/^\d{10}$/.test(accountNumber)) {
            return res.status(400).json({
                success: false,
                message: 'Account number must be exactly 10 digits'
            });
        }

        // ===== TRY WITH BOTH STRING AND NUMBER FORMATS =====
        const cleanBankCode = String(bankCode).trim();

        // Try with string format first (SDK style)
        try {
            console.log(`🔄 Trying SDK-style verification with code: ${cleanBankCode}`);
            const response = await flw.Misc.verify_Account({
                account_number: accountNumber,
                account_bank: cleanBankCode
            });

            if (response.status === 'success') {
                return res.json({
                    success: true,
                    accountName: response.data.account_name
                });
            }
            // If SDK returns error, fall through to direct API
        } catch (sdkError) {
            console.log('SDK verification failed, trying direct API...', sdkError.message);
        }

        // ===== FALLBACK: Direct API with correct format =====
        // Flutterwave expects the bank code as a number for this endpoint
        const numericBankCode = parseInt(cleanBankCode, 10);

        if (isNaN(numericBankCode)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid bank code format'
            });
        }

        console.log(`🔄 Using direct API with numeric code: ${numericBankCode}`);

        const response = await axios.post(
            'https://api.flutterwave.com/v3/accounts/resolve',
            {
                account_number: accountNumber,
                account_bank: numericBankCode  // Send as number
            },
            {
                headers: {
                    'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log('📥 Account resolution response:', response.data);

        if (response.data.status === 'success') {
            return res.json({
                success: true,
                accountName: response.data.data.account_name
            });
        } else {
            return res.status(400).json({
                success: false,
                message: response.data.message || 'Unable to verify account'
            });
        }

    } catch (error) {
        console.error('❌ Account verification error:', error.response?.data || error.message);

        const errorMsg = error.response?.data?.message || error.message;

        if (errorMsg.includes('only 044') || errorMsg.includes('must be numeric')) {
            return res.status(400).json({
                success: false,
                message: 'Bank verification not available. Please enter account name manually or try a different bank.'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Account verification failed. Please try again later.'
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
            response = await flw.Bank.get_banks({ country: 'NG' });
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