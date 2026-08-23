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

// Platform subaccount ID (where your 2% platform fee goes)
const PLATFORM_SUBACCOUNT_ID = process.env.PLATFORM_SUBACCOUNT_ID;

// Initialize Flutterwave SDK
const axios = require('axios');
let flw;

try {
    flw = new Flutterwave(FLW_PUBLIC_KEY, FLW_SECRET_KEY);
    console.log('✅ Flutterwave SDK initialized successfully');
    console.log('   Payment object exists:', !!flw.Payment);
    console.log('   initiate method exists:', typeof flw.Payment?.initiate === 'function');
} catch (error) {
    console.error('❌ Flutterwave SDK initialization error:', error.message);
    console.error('   Public Key present:', !!FLW_PUBLIC_KEY);
    console.error('   Secret Key present:', !!FLW_SECRET_KEY);

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
        Misc: {
            verify_Account: async ({ account_number, account_bank }) => {
                console.log('🔄 Using direct API call fallback for account verification...');
                try {
                    const response = await axios.post(
                        'https://api.flutterwave.com/v3/accounts/resolve',
                        {
                            account_number: account_number,
                            account_bank: String(account_bank)
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

const verificationInProgress = new Map();

// ==================== FEE CALCULATION ====================
const calculateMemberPayAmount = (targetOrganizationAmount) => {
    if (!targetOrganizationAmount || targetOrganizationAmount <= 0) return 0;

    let memberPays = targetOrganizationAmount / 0.96;
    memberPays = Math.ceil(memberPays);

    let netToOrg = calculateNetToOrganization(memberPays).netToOrg;
    let iterations = 0;
    while (netToOrg < targetOrganizationAmount && iterations < 5) {
        memberPays++;
        netToOrg = calculateNetToOrganization(memberPays).netToOrg;
        iterations++;
    }

    return memberPays;
};

const calculateNetToOrganization = (amountPaid, targetOrgAmount = null) => {
    let flutterwaveFee = amountPaid * 0.02;
    let platformFee = amountPaid * 0.02;
    let totalFees = flutterwaveFee + platformFee;
    let netToOrg = amountPaid - totalFees;

    let roundedNet = Math.round(netToOrg);
    let roundedFlutterwave = Math.round(flutterwaveFee);
    let roundedPlatform = Math.round(platformFee);
    let roundedTotalFees = roundedFlutterwave + roundedPlatform;

    if (targetOrgAmount && Math.abs(roundedNet - targetOrgAmount) > 1) {
        roundedNet = targetOrgAmount;
        console.log(`Fee adjustment: netToOrg changed from ${Math.round(netToOrg)} to ${targetOrgAmount} (difference: ${targetOrgAmount - Math.round(netToOrg)})`);
    }

    if (roundedNet < 0) roundedNet = 0;

    return {
        amountPaid,
        flutterwaveFee: roundedFlutterwave,
        platformFee: roundedPlatform,
        netToOrg: roundedNet,
        totalFees: roundedTotalFees
    };
};

// ============================================================
// HYBRID DUES HELPER: Mark months as paid
// ============================================================
const markHybridDuesMonthsAsPaid = async (payment, amountPaid) => {
    try {
        // If payment has months array, calculate which months are covered
        const months = payment.months || [];
        if (months.length === 0) {
            // No months array - legacy payment
            return { markedMonths: [], allMonths: [] };
        }

        const monthlyPrice = payment.monthlyPrice || (payment.amount / months.length);
        const monthsCovered = Math.floor(amountPaid / monthlyPrice);
        const monthsToMark = months.slice(0, monthsCovered);

        // Get already paid months from existing payments
        const paidMonths = [];
        const existingPaidPayments = await Payment.find({
            user: payment.user,
            paymentTypeId: payment.paymentTypeId,
            organizationId: payment.organizationId,
            status: 'paid'
        });

        existingPaidPayments.forEach(p => {
            if (p.months) {
                paidMonths.push(...p.months);
            }
        });

        // Filter out already paid months
        const newlyPaidMonths = monthsToMark.filter(m => !paidMonths.includes(m));

        // Update payment with paid months (for tracking)
        payment.paidMonths = newlyPaidMonths;
        await payment.save();

        return {
            markedMonths: newlyPaidMonths,
            allMonths: months,
            totalPaidMonths: paidMonths.length + newlyPaidMonths.length
        };
    } catch (error) {
        console.error('Error marking hybrid dues months:', error);
        return { markedMonths: [], allMonths: [] };
    }
};

// ============================================================
// HYBRID DUES HELPER: Check if member has remaining months
// ============================================================
const getRemainingHybridMonths = async (userId, paymentTypeId, organizationId) => {
    try {
        // Get all paid months across all payments
        const paidPayments = await Payment.find({
            user: userId,
            paymentTypeId: paymentTypeId,
            organizationId: organizationId,
            status: 'paid'
        });

        const paidMonths = [];
        paidPayments.forEach(p => {
            if (p.months) {
                paidMonths.push(...p.months);
            }
        });

        // Get the current payment's months
        const currentPayment = await Payment.findOne({
            user: userId,
            paymentTypeId: paymentTypeId,
            organizationId: organizationId,
            status: { $ne: 'paid' }
        });

        if (!currentPayment) {
            return { remainingMonths: [], allMonths: [] };
        }

        const allMonths = currentPayment.months || [];
        const remainingMonths = allMonths.filter(m => !paidMonths.includes(m));

        return {
            remainingMonths,
            allMonths,
            paidMonths
        };
    } catch (error) {
        console.error('Error getting remaining hybrid months:', error);
        return { remainingMonths: [], allMonths: [], paidMonths: [] };
    }
};

// ==================== PARTIAL PAYMENT HELPER ====================
const processPartialPayment = async (originalPayment, amountPaid, reference, isManual = false) => {
    const targetOrgAmount = originalPayment.targetOrgAmount || originalPayment.amount;

    const existingPartial = originalPayment.partialPayments?.find(
        p => p.transactionReference === reference && p.amount === amountPaid
    );

    if (existingPartial) {
        console.log(`⚠️ Duplicate partial payment detected for reference: ${reference}`);
        return {
            amountPaid,
            netToOrg: existingPartial.netToOrg,
            remainingTarget: originalPayment.remainingAmount,
            outstandingPayment: await originalPayment.getOutstandingRecord(),
            isDuplicate: true
        };
    }

    const fees = calculateNetToOrganization(amountPaid);
    const netToOrgFromThisPayment = fees.netToOrg;

    const totalNetReceivedSoFar = (originalPayment.totalNetReceivedSoFar || 0) + netToOrgFromThisPayment;
    const remainingOrgTarget = targetOrgAmount - totalNetReceivedSoFar;

    originalPayment.totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;
    originalPayment.totalNetReceivedSoFar = totalNetReceivedSoFar;
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
                description: `Remaining balance of ₦${remainingOrgTarget.toLocaleString()} for ${originalPayment.name}. Original amount: ₦${targetOrgAmount.toLocaleString()}, Total paid so far: ₦${originalPayment.totalPaidSoFar.toLocaleString()}`,
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
        .matches(/^(PAY-[a-f0-9]+-\d+-[a-z0-9]+|flwlnk-[a-z0-9]+)$/i).withMessage('Invalid reference format')
        .isLength({ min: 10, max: 100 }),
    ValidationMiddleware.validate
];

// ==================== PAYMENT INITIALIZATION ====================
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

        console.log('📋 Payment BEFORE initialization:', {
            id: payment._id,
            status: payment.status,
            transactionReference: payment.transactionReference,
            amount: payment.amount,
            name: payment.name,
            months: payment.months,
            monthCount: payment.monthCount
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
                remaining_balance: isPartialPayment ? targetOrgAmount - customAmount : 0,
                // ============================================================
                // HYBRID DUES: Add month info for tracking
                // ============================================================
                is_hybrid_dues: !!(payment.months && payment.months.length > 0),
                month_count: payment.monthCount || 0,
                months: payment.months || []
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

            const txRef = uniqueRef;
            console.log('🔄 Extracted tx_ref:', txRef);

            const link = response.data?.link || response.data?.data?.link;
            console.log('🔄 Extracted link:', link);

            if (txRef && txRef !== payment.transactionReference) {
                payment.transactionReference = txRef;
                console.log('✅ Updated transactionReference from Flutterwave:', txRef);
            } else {
                console.log('ℹ️ Keeping existing transactionReference:', payment.transactionReference);
            }

            const fullAmount = calculateMemberPayAmount(targetOrgAmount);
            payment.paymentUrl = link;
            payment.expectedAmount = fullAmount;
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

        let payment = await Payment.findOne({ transactionReference: reference })
            .populate('user', 'name email organizationId');

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

        console.log('📊 Payment details:', {
            id: payment._id,
            status: payment.status,
            paymentTypeId: payment.paymentTypeId,
            amount: payment.amount,
            transactionReference: payment.transactionReference,
            months: payment.months,
            monthCount: payment.monthCount
        });

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
                    isPartial: payment.isPartial,
                    months: payment.months,
                    paidMonths: payment.paidMonths || []
                },
                message: 'Payment already verified'
            });
        }

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

        console.log('🔍 Full Flutterwave response:', JSON.stringify(response, null, 2));

        if (response.status === 'success' && response.data && response.data.status === 'successful') {
            const amountPaid = response.data.amount || response.data.charged_amount || 0;
            const targetAmount = payment.targetOrgAmount || payment.amount;

            const isPartialPayment = amountPaid < targetAmount;

            console.log(`💰 Amount paid: ₦${amountPaid}, Target: ₦${targetAmount}, Is Partial: ${isPartialPayment}`);

            let result;

            // ============================================================
            // HYBRID DUES: Check if this is a dues payment with months
            // ============================================================
            const isHybridDues = (payment.months && payment.months.length > 0) &&
                (payment.type === 'dues' || payment.type === 'monthly_dues');

            if (isHybridDues) {
                console.log(`📅 HYBRID DUES PAYMENT: ${payment.months.length} months, amount: ₦${payment.amount}`);

                // Calculate how many months are covered by this payment
                const monthlyPrice = payment.monthlyPrice || (payment.amount / payment.months.length);
                const monthsCovered = Math.min(
                    Math.floor(amountPaid / monthlyPrice),
                    payment.months.length
                );

                const paidMonths = payment.months.slice(0, monthsCovered);

                console.log(`📅 Months covered: ${monthsCovered}/${payment.months.length}`);
                console.log(`📅 Paid months: ${paidMonths.join(', ')}`);

                // Mark payment as paid and store paid months
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
                            transactionReference: reference,
                            // Store which months were paid
                            paidMonths: paidMonths
                        }
                    },
                    { new: true }
                );

                console.log(`✅ HYBRID DUES payment recorded: ${paidMonths.length} months paid`);
                result = { remainingTarget: 0 };
                payment = updatedPayment;

                // ============================================================
                // Check if there are remaining unpaid months
                // ============================================================
                const remainingMonths = payment.months.filter(m => !paidMonths.includes(m));
                if (remainingMonths.length > 0) {
                    console.log(`📅 Remaining months: ${remainingMonths.join(', ')} (${remainingMonths.length} months)`);

                    // Create a new payment for remaining months or update existing
                    const remainingPayment = await Payment.findOne({
                        user: payment.user,
                        paymentTypeId: payment.paymentTypeId,
                        organizationId: payment.organizationId,
                        status: 'unpaid'
                    });

                    if (remainingPayment) {
                        // Update existing with remaining months
                        remainingPayment.months = remainingMonths;
                        remainingPayment.monthCount = remainingMonths.length;
                        remainingPayment.amount = remainingMonths.length * monthlyPrice;
                        remainingPayment.targetOrgAmount = remainingMonths.length * monthlyPrice;
                        remainingPayment.expectedAmount = Math.ceil(remainingPayment.amount / 0.96);
                        remainingPayment.remainingAmount = remainingPayment.amount;
                        await remainingPayment.save();
                        console.log(`✅ Updated remaining payment: ${remainingMonths.length} months`);
                    }
                }

            } else if (isPartialPayment) {
                // Existing partial payment logic
                result = await processPartialPayment(payment, amountPaid, reference, false);
                console.log(`⚠️ Partial payment! Paid: ₦${amountPaid}, Target: ₦${targetAmount}, Remaining target: ₦${result.remainingTarget}`);
            } else {
                // Existing full payment logic
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
                    paymentTypeId: payment.paymentTypeId,
                    // ============================================================
                    // HYBRID DUES: Return month info
                    // ============================================================
                    months: payment.months || [],
                    paidMonths: payment.paidMonths || [],
                    monthCount: payment.monthCount || 0
                },
                message: isPartialPayment ? `Partial payment of ₦${amountPaid.toLocaleString()} verified. Outstanding balance: ₦${result?.remainingTarget.toLocaleString()}` : 'Payment verified successfully'
            });
        } else {
            console.log('⚠️ Payment verification response:', response);
            console.log('⚠️ Status:', response.status);
            console.log('⚠️ Data status:', response.data?.status);

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

// ==================== PAYMENT WEBHOOK ====================
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
            const existingPayment = await Payment.findOne({
                transactionReference: tx_ref,
                status: 'paid'
            });
            if (existingPayment) {
                console.log('⚠️ Payment already processed, ignoring duplicate webhook');
                return res.status(200).json({ success: true });
            }
            const amountPaid = amount;

            const payment = await Payment.findOne({
                transactionReference: tx_ref,
                status: { $ne: 'paid' }
            }).populate('user', 'organizationId');

            if (payment && payment.status !== 'paid') {
                const expectedAmount = payment.expectedAmount || payment.amount;
                const isPartialPayment = amountPaid < (expectedAmount - 1);

                // ============================================================
                // HYBRID DUES: Handle webhook for dues payments
                // ============================================================
                const isHybridDues = (payment.months && payment.months.length > 0) &&
                    (payment.type === 'dues' || payment.type === 'monthly_dues');

                if (isHybridDues) {
                    const monthlyPrice = payment.monthlyPrice || (payment.amount / payment.months.length);
                    const monthsCovered = Math.min(
                        Math.floor(amountPaid / monthlyPrice),
                        payment.months.length
                    );
                    const paidMonths = payment.months.slice(0, monthsCovered);

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
                                transactionReference: tx_ref,
                                paidMonths: paidMonths
                            }
                        }
                    );
                    console.log(`✅ Webhook - HYBRID DUES payment recorded: ${paidMonths.length} months paid`);

                    // Check for remaining months
                    const remainingMonths = payment.months.filter(m => !paidMonths.includes(m));
                    if (remainingMonths.length > 0) {
                        const remainingPayment = await Payment.findOne({
                            user: payment.user,
                            paymentTypeId: payment.paymentTypeId,
                            organizationId: payment.organizationId,
                            status: 'unpaid'
                        });

                        if (remainingPayment) {
                            const monthlyPriceFromType = payment.monthlyPrice || (payment.amount / payment.months.length);
                            remainingPayment.months = remainingMonths;
                            remainingPayment.monthCount = remainingMonths.length;
                            remainingPayment.amount = remainingMonths.length * monthlyPriceFromType;
                            remainingPayment.targetOrgAmount = remainingMonths.length * monthlyPriceFromType;
                            remainingPayment.expectedAmount = Math.ceil(remainingPayment.amount / 0.96);
                            remainingPayment.remainingAmount = remainingPayment.amount;
                            await remainingPayment.save();
                            console.log(`✅ Webhook - Updated remaining payment: ${remainingMonths.length} months`);
                        }
                    }

                } else if (isPartialPayment) {
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
                                transactionReference: tx_ref
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

// ==================== PARTIAL PAYMENT ENDPOINT ====================
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
                totalPaidSoFar: payment.totalPaidSoFar,
                months: payment.months,
                monthCount: payment.monthCount
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

// ==================== RESOLVE ACCOUNT ====================
router.post('/organizations/resolve-account', protect, async (req, res) => {
    try {
        const { accountNumber, bankCode } = req.body;

        console.log('🔍 Resolving account:', { accountNumber, bankCode, type: typeof bankCode });

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

        const cleanBankCode = String(bankCode).trim();

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
        } catch (sdkError) {
            console.log('SDK verification failed, trying direct API...', sdkError.message);
        }

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
                account_bank: numericBankCode
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

// ==================== GET BANKS ====================
router.get('/flutterwave/banks', protect, async (req, res) => {
    try {
        let response;

        if (typeof flw.Bank.getBanks === 'function') {
            response = await flw.Bank.get_banks({ country: 'NG' });
        } else if (typeof flw.Bank.list === 'function') {
            response = await flw.Bank.list({ country: 'NG' });
        } else if (typeof flw.Bank.country === 'function') {
            response = await flw.Bank.country({ country: 'NG' });
        } else if (typeof flw.Bank.ng === 'function') {
            response = await flw.Bank.ng({ country: 'NG' });
        } else {
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