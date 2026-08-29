// backend/src/controllers/paymentController.js
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const PaymentType = require('../models/PaymentType');
const Expenditure = require('../models/Expenditure');
const crypto = require('crypto');

// ==================== HELPER FUNCTIONS ====================

/**
 * Calculate Flutterwave + platform fees for a given amount.
 * Flutterwave fee = 2% (no cap, no flat fee)
 * Platform fee   = 4%
 * Total fees     = 6%
 * Net to org     = amountPaid * 0.94
 */
const calculateFeesAndNet = (amountPaid) => {
    const flutterwaveFee = amountPaid * 0.02;
    const platformFee = amountPaid * 0.02;
    const totalFees = flutterwaveFee + platformFee;
    const netToOrg = amountPaid - totalFees;
    return {
        flutterwaveFee: Math.round(flutterwaveFee),
        platformFee: Math.round(platformFee),
        totalFees: Math.round(totalFees),
        netToOrg: Math.round(netToOrg)
    };
};



// controllers/paymentController.js - Updated helper

/**
 * Calculate late penalties for ANY payment type
 * @param {Object} paymentType - The payment type with penalty settings
 * @param {Date} referenceDate - The date to check against
 * @param {Array} months - Optional months array (for dues only)
 * @returns {Object} - { totalPenalty, breakdown, isLate }
 */
const calculateLatePenalties = (paymentType, referenceDate = new Date(), months = null) => {
    // ============================================================
    // Check if penalties are enabled
    // ============================================================
    if (!paymentType || !paymentType.late_penalty_enabled) {
        return {
            totalPenalty: 0,
            breakdown: [],
            isLate: false,
            message: 'No penalties enabled'
        };
    }

    const now = new Date(referenceDate);
    const dueDateAfter = paymentType.due_date_after || 30;
    const daysAfterDue = paymentType.late_penalty_days_after || 7;

    // ============================================================
    // Calculate penalty based on payment type
    // ============================================================
    const penaltyPercentage = paymentType.late_penalty_type === 'percentage'
        ? paymentType.late_penalty_value / 100
        : 0;
    const fixedPenalty = paymentType.late_penalty_type === 'fixed'
        ? paymentType.late_penalty_value
        : 0;

    // ============================================================
    // For DUES: Check each month individually
    // ============================================================
    if (months && months.length > 0 &&
        (paymentType.type === 'dues' || paymentType.type === 'monthly_dues')) {

        const breakdown = months.map(month => {
            const [year, monthNum] = month.split('-').map(Number);
            const dueDate = new Date(year, monthNum - 1, 1);
            dueDate.setDate(dueDate.getDate() + dueDateAfter);

            const penaltyStartDate = new Date(dueDate);
            penaltyStartDate.setDate(penaltyStartDate.getDate() + daysAfterDue);

            const isLate = now > penaltyStartDate;

            let penalty = 0;
            if (isLate) {
                if (paymentType.late_penalty_type === 'percentage') {
                    penalty = paymentType.amount * penaltyPercentage;
                } else {
                    penalty = fixedPenalty;
                }
            }

            return {
                month,
                dueDate,
                penaltyStartDate,
                isLate,
                penalty: Math.round(penalty * 100) / 100
            };
        });

        const totalPenalty = breakdown.reduce((sum, b) => sum + b.penalty, 0);
        const isLate = breakdown.some(b => b.isLate);

        return {
            totalPenalty: Math.round(totalPenalty * 100) / 100,
            breakdown,
            isLate,
            message: isLate ? 'Late penalties applied' : 'No late penalties'
        };
    }

    // ============================================================
    // For NON-DUES: Check single payment
    // ============================================================
    const createdAt = paymentType.createdAt || new Date();
    const dueDate = new Date(createdAt);
    dueDate.setDate(dueDate.getDate() + dueDateAfter);

    const penaltyStartDate = new Date(dueDate);
    penaltyStartDate.setDate(penaltyStartDate.getDate() + daysAfterDue);

    const isLate = now > penaltyStartDate;

    let penalty = 0;
    if (isLate) {
        if (paymentType.late_penalty_type === 'percentage') {
            penalty = paymentType.amount * penaltyPercentage;
        } else {
            penalty = fixedPenalty;
        }
    }

    return {
        totalPenalty: Math.round(penalty * 100) / 100,
        breakdown: [{
            month: null,
            dueDate,
            penaltyStartDate,
            isLate,
            penalty: Math.round(penalty * 100) / 100
        }],
        isLate,
        message: isLate ? 'Late penalty applied' : 'No late penalty'
    };
};

/**
 * Get the current period key for a payment type
 * NEW: Helper for recurring billing
 */
const getCurrentPeriodKey = (paymentType, referenceDate = new Date()) => {
    if (!paymentType || paymentType.frequency === 'one-time') {
        return null;
    }
    return paymentType.getPeriodKey(referenceDate);
};

/**
 * Get the current period dates for a payment type
 * NEW: Helper for recurring billing
 */
const getCurrentPeriodDates = (paymentType, referenceDate = new Date()) => {
    if (!paymentType || paymentType.frequency === 'one-time') {
        return { periodStart: null, periodEnd: null };
    }
    return paymentType.getPeriodForDate(referenceDate);
};

/**
 * Handle partial payment (card underpayment, bank transfer, or manual admin record)
 * – Updates original payment with partial payment record
 * – Creates/updates an outstanding payment for the remaining target
 * – Creates Income record for the net amount received by the organisation
 * – Creates Expenditure records for fees
 */
const handlePartialPayment = async (originalPayment, amountPaid, reference, notes = '') => {


    // ============================================================
    // ⭐ STRICT CHECK: Prevent partial payments for dues
    // ============================================================
    const isDuesPayment = (originalPayment.type === 'dues' || originalPayment.type === 'monthly_dues')
        && originalPayment.months && originalPayment.months.length > 0;

    if (isDuesPayment) {
        // Check if this is a FULL payment
        const totalExpected = (originalPayment.amount || 0) + (originalPayment.penaltyAmount || 0);
        const totalPayable = Math.ceil(totalExpected / 0.96);

        if (amountPaid < totalPayable - 1) {
            throw new Error(`Partial payments are not allowed for dues. Expected amount: ₦${totalPayable}`);
        }
    }


    const targetAmount = originalPayment.targetOrgAmount || originalPayment.amount;

    // Calculate cumulative net received by organisation from all previous partial payments
    const previousNetReceived = (originalPayment.partialPayments || [])
        .reduce((sum, p) => sum + (p.netToOrg || 0), 0);

    const { netToOrg, flutterwaveFee, platformFee, totalFees } = calculateFeesAndNet(amountPaid);
    const newTotalNetReceived = previousNetReceived + netToOrg;
    const remainingTarget = targetAmount - newTotalNetReceived;

    console.log(`Partial payment: Target ${targetAmount}, Paid ${amountPaid}, Net to org ${netToOrg}, Remaining target ${remainingTarget}`);

    // Update original payment
    originalPayment.totalPaidSoFar = (originalPayment.totalPaidSoFar || 0) + amountPaid;
    originalPayment.remainingAmount = remainingTarget;
    originalPayment.isPartial = remainingTarget > 0;
    originalPayment.status = remainingTarget > 0 ? 'partial' : 'paid';
    originalPayment.partialPayments = originalPayment.partialPayments || [];
    originalPayment.partialPayments.push({
        amount: amountPaid,
        netToOrg: netToOrg,
        date: new Date(),
        transactionReference: reference,
        fees: {
            flutterwaveFee: flutterwaveFee,
            platformFee: platformFee,
            totalFees: totalFees
        },
        notes: notes
    });

    if (remainingTarget <= 0) {
        originalPayment.paidAt = new Date();
        // ✅ If this is an outstanding payment, update the parent
        if (originalPayment.parentPaymentId) {
            const parentPayment = await Payment.findById(originalPayment.parentPaymentId);
            if (parentPayment) {
                parentPayment.totalPaidSoFar = parentPayment.targetOrgAmount;
                parentPayment.remainingAmount = 0;
                parentPayment.isPartial = false;
                parentPayment.status = 'paid';
                parentPayment.paidAt = new Date();
                await parentPayment.save();
                console.log(`✅ Parent payment ${parentPayment._id} marked as paid`);
            }
        }
    }
    await originalPayment.save();

    let outstandingPayment = null;

    // Create or update outstanding payment for remaining target
    if (remainingTarget > 0) {
        outstandingPayment = await Payment.findOne({
            parentPaymentId: originalPayment._id,
            type: 'outstanding',
            status: 'unpaid'
        });

        if (outstandingPayment) {
            outstandingPayment.amount = remainingTarget;
            outstandingPayment.targetOrgAmount = remainingTarget;
            outstandingPayment.remainingAmount = remainingTarget;
            outstandingPayment.description = `Remaining balance of ₦${remainingTarget.toLocaleString()} for ${originalPayment.name}`;
            await outstandingPayment.save();
        } else {
            outstandingPayment = await Payment.create({
                user: originalPayment.user,
                name: `${originalPayment.name} (Outstanding Balance)`,
                type: 'outstanding',
                amount: remainingTarget,
                // ✅ Use targetOrgAmount from original payment
                originalAmount: originalPayment.targetOrgAmount || originalPayment.amount,
                targetOrgAmount: remainingTarget,
                expectedAmount: remainingTarget,
                remainingAmount: remainingTarget,
                totalPaidSoFar: 0,
                isPartial: false,
                parentPaymentId: originalPayment._id,
                paymentTypeId: originalPayment.paymentTypeId,
                organizationId: originalPayment.organizationId,
                description: `Remaining balance of ₦${remainingTarget.toLocaleString()} for ${originalPayment.name}`,
                status: 'unpaid',
                dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                // Copy period info from original
                periodStart: originalPayment.periodStart,
                periodEnd: originalPayment.periodEnd,
                periodKey: originalPayment.periodKey
            });
        }
        console.log(`Outstanding payment record: ${outstandingPayment._id} for amount ${remainingTarget}`);
    }

    // Record Income for net amount received by organisation
    await Income.create({
        amount: netToOrg,
        source: `${originalPayment.type} payment (Partial)`,
        date: new Date(),
        description: `Partial payment of ₦${amountPaid.toLocaleString()} received. Fees: ₦${totalFees.toLocaleString()}. ${remainingTarget > 0 ? `Remaining: ₦${remainingTarget.toLocaleString()}` : 'Payment completed.'}`,
        paymentId: originalPayment._id,
        paymentType: originalPayment.type,
        transactionReference: reference,
        organizationId: originalPayment.organizationId,
        metadata: {
            isPartial: true,
            partialAmount: amountPaid,
            remainingTarget: remainingTarget,
            fees: { flutterwaveFee, platformFee }
        }
    });

    // Record expenditures for fees
    if (flutterwaveFee > 0) {
        await Expenditure.create({
            amount: flutterwaveFee,
            purpose: 'Payment Processing Fee',
            description: `Flutterwave fee for partial payment ${reference}`,
            createdBy: originalPayment.user,
            organizationId: originalPayment.organizationId,
            metadata: { feeType: 'flutterwave', paymentId: originalPayment._id, isPartial: true }
        });
    }

    if (platformFee > 0) {
        await Expenditure.create({
            amount: platformFee,
            purpose: 'Platform Service Fee',
            description: `Platform fee for partial payment ${reference}`,
            createdBy: originalPayment.user,
            organizationId: originalPayment.organizationId,
            metadata: { feeType: 'platform', paymentId: originalPayment._id, isPartial: true }
        });
    }

    return {
        isPartial: true,
        paidAmount: amountPaid,
        netToOrg: netToOrg,
        remainingTarget: remainingTarget,
        outstandingPayment: outstandingPayment
    };
};

// ==================== CONTROLLER METHODS ====================

// @desc    Create direct payment (Admin only - manual, no gateway)
// @route   POST /api/payments/admin-direct
// @access  Private/Admin
exports.createAdminDirectPayment = async (req, res, next) => {
    try {
        const { userId, type, amount, dueDate, description, paymentTypeId, paidAt } = req.body;
        const organizationId = req.user.organizationId;

        console.log('Admin direct payment request:', req.body);

        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID is required' });
        }

        const targetUser = await User.findOne({ _id: userId, organizationId });
        if (!targetUser) {
            return res.status(403).json({ success: false, message: 'User not found in your organization' });
        }

        if (!type) {
            return res.status(400).json({ success: false, message: 'Payment type is required' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        // Prevent duplicate paid payment for same type/paymentTypeId
        const existingPayment = await Payment.findOne({
            user: userId,
            paymentTypeId,
            status: 'paid',
            organizationId
        });

        if (existingPayment) {
            return res.status(400).json({
                success: false,
                message: `Payment already exists for this member. ${type} payment has already been made.`,
                data: { existingPayment }
            });
        }

        const payment = await Payment.create({
            user: userId,
            type,
            amount,
            targetOrgAmount: amount,
            expectedAmount: amount,
            remainingAmount: 0,
            totalPaidSoFar: amount,
            dueDate: dueDate || null,
            description: description || `${type} payment recorded by admin`,
            paymentTypeId: paymentTypeId || null,
            organizationId,
            status: 'paid',
            paidAt: paidAt || new Date(),
            transactionReference: `ADMIN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        });

        await payment.populate('user', 'name email');

        if (type === 'registration') {
            await User.findByIdAndUpdate(userId, { hasPaidRegistration: true });
        }

        await Income.create({
            amount: payment.amount,
            source: `${type} - ${description || 'Payment'}`,
            date: payment.paidAt || new Date(),
            description: description || `${type} payment recorded by admin`,
            paymentId: payment._id,
            paymentType: type,
            userId,
            organizationId,
            transactionReference: payment.transactionReference
        });

        res.status(201).json({
            success: true,
            data: payment,
            message: `Payment of ₦${amount.toLocaleString()} recorded successfully for ${payment.user?.name || 'member'}`
        });
    } catch (error) {
        console.error('Admin direct payment error:', error);
        next(error);
    }
};

// @desc    Get outstanding payments (unpaid / partial) for current user
// @route   GET /api/payments/outstanding
// @access  Private
exports.getOutstandingPayments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;
        const { periodKey } = req.query;

        const query = {
            user: userId,
            organizationId,
            status: { $in: ['unpaid', 'partial'] },
            remainingAmount: { $gt: 0 }
        };

        if (periodKey) {
            query.periodKey = periodKey;
        }

        const outstandingPayments = await Payment.find(query)
            .populate('paymentTypeId', 'name description frequency')
            .sort({ periodStart: -1, dueDate: 1, createdAt: 1 });

        const totalOutstanding = outstandingPayments.reduce((sum, p) => sum + (p.remainingAmount || p.amount), 0);

        const groupedByPeriod = outstandingPayments.reduce((acc, p) => {
            const key = p.periodKey || 'one-time';
            if (!acc[key]) acc[key] = [];
            acc[key].push(p);
            return acc;
        }, {});

        res.status(200).json({
            success: true,
            data: outstandingPayments,
            grouped: groupedByPeriod,
            summary: {
                totalOutstanding,
                count: outstandingPayments.length,
                periods: Object.keys(groupedByPeriod)
            }
        });
    } catch (error) {
        console.error('Get outstanding payments error:', error);
        next(error);
    }
};

// @desc    Mark a fine as paid (Admin)
// @route   PUT /api/payments/:id/mark-paid
// @access  Private/Admin
exports.markFineAsPaid = async (req, res, next) => {
    try {
        const { paidAt } = req.body;
        const organizationId = req.user.organizationId;

        const payment = await Payment.findOne({
            _id: req.params.id,
            organizationId
        }).populate('user', 'name email');

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (payment.type !== 'fine') {
            return res.status(400).json({ success: false, message: 'This endpoint is only for fines' });
        }

        if (payment.status === 'paid') {
            return res.status(400).json({ success: false, message: 'Fine already paid' });
        }

        payment.status = 'paid';
        payment.paidAt = paidAt || new Date();
        payment.remainingAmount = 0;
        payment.totalPaidSoFar = payment.amount;
        await payment.save();

        await Income.create({
            amount: payment.amount,
            source: `Fine - ${payment.description || 'Penalty'}`,
            date: payment.paidAt,
            description: payment.description || `Fine payment from ${payment.user?.name}`,
            paymentId: payment._id,
            paymentType: 'fine',
            userId: payment.user,
            organizationId,
            transactionReference: payment.transactionReference
        });

        res.status(200).json({
            success: true,
            data: payment,
            message: 'Fine marked as paid successfully'
        });
    } catch (error) {
        console.error('Mark fine as paid error:', error);
        next(error);
    }
};

// @desc    Create payment (Admin - creates unpaid record)
// @route   POST /api/payments
// @access  Private/Admin
exports.createPayment = async (req, res, next) => {
    console.log('🔥🔥🔥 Admin createPayment WAS CALLED! 🔥🔥🔥');
    try {
        const { userId, name, type, amount, dueDate, description, paymentTypeId, periodStart, periodEnd, periodKey } = req.body;
        const organizationId = req.user.organizationId;

        console.log('Create payment request:', { userId, name, type, amount, dueDate, description, paymentTypeId, organizationId, periodStart, periodEnd, periodKey });

        if (!userId || !name || !type || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const targetUser = await User.findOne({ _id: userId, organizationId });
        if (!targetUser) {
            return res.status(403).json({ success: false, message: 'User not found in your organization' });
        }

        let periodData = {};
        if (paymentTypeId) {
            const paymentType = await PaymentType.findById(paymentTypeId);
            if (paymentType && paymentType.isRecurring()) {
                const period = paymentType.getPeriodForDate(new Date());
                periodData = {
                    periodStart: period.periodStart,
                    periodEnd: period.periodEnd,
                    periodKey: paymentType.getPeriodKey(new Date())
                };
            }
        }

        const finalPeriodStart = periodStart || periodData.periodStart || null;
        const finalPeriodEnd = periodEnd || periodData.periodEnd || null;
        const finalPeriodKey = periodKey || periodData.periodKey || null;

        const payment = await Payment.create({
            user: userId,
            name,
            type,
            amount,
            targetOrgAmount: amount,
            expectedAmount: amount,
            remainingAmount: amount,
            totalPaidSoFar: 0,
            isPartial: false,
            dueDate: dueDate || null,
            description: description || '',
            paymentTypeId: paymentTypeId || null,
            organizationId,
            status: 'unpaid',
            periodStart: finalPeriodStart,
            periodEnd: finalPeriodEnd,
            periodKey: finalPeriodKey
        });

        res.status(201).json({
            success: true,
            data: payment,
            message: 'Payment created successfully'
        });
    } catch (error) {
        console.error('Error in createPayment:', error);
        next(error);
    }
};

// @desc    Get public payment summary for members (collected, outstanding, trends)
// @route   GET /api/payments/public/summary
// @access  Private
exports.getPublicSummary = async (req, res, next) => {
    try {
        const organizationId = req.user.organizationId;

        let matchCondition = { status: 'paid' };
        if (organizationId && !['super-admin', 'super_admin'].includes(req.user.role)) {
            matchCondition.organizationId = organizationId;
        }

        const [totalPaidResult, totalOutstandingResult, paymentCounts, monthlyPayments] = await Promise.all([
            Payment.aggregate([
                { $match: matchCondition },
                { $group: { _id: null, total: { $sum: '$netToOrganization' } } }
            ]),
            Payment.aggregate([
                { $match: { ...matchCondition, status: { $in: ['unpaid', 'partial'] }, remainingAmount: { $gt: 0 } } },
                { $group: { _id: null, total: { $sum: '$remainingAmount' } } }
            ]),
            Payment.aggregate([
                { $match: matchCondition },
                { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$netToOrganization' } } }
            ]),
            Payment.aggregate([
                {
                    $match: {
                        status: 'paid',
                        paidAt: { $gte: new Date(new Date().setMonth(new Date().getMonth() - 12)) }
                    }
                },
                {
                    $group: {
                        _id: { year: { $year: '$paidAt' }, month: { $month: '$paidAt' } },
                        total: { $sum: '$netToOrganization' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { '_id.year': 1, '_id.month': 1 } }
            ])
        ]);

        res.status(200).json({
            success: true,
            data: {
                totalCollected: totalPaidResult[0]?.total || 0,
                totalOutstanding: totalOutstandingResult[0]?.total || 0,
                paymentCounts,
                monthlyTrend: monthlyPayments,
                lastUpdated: new Date()
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get single payment by ID (with permission check)
// @route   GET /api/payments/:id
// @access  Private
exports.getPaymentById = async (req, res, next) => {
    try {
        const payment = await Payment.findOne({
            _id: req.params.id,
            organizationId: req.user.organizationId
        })
            .populate('user', 'name email')
            .populate('paymentTypeId', 'name description frequency');

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this payment' });
        }

        res.status(200).json({ success: true, data: payment });
    } catch (error) {
        console.error('Get payment by ID error:', error);
        next(error);
    }
};

// @desc    Get all paid payments as income records (for reports)
// @route   GET /api/payments/public/income
// @access  Private
exports.getPublicIncome = async (req, res, next) => {
    try {
        const organizationId = req.user.organizationId;
        const userRole = req.user.role;
        let query = { status: 'paid' };

        if (!['super-admin', 'super_admin'].includes(userRole)) {
            if (!organizationId) {
                return res.status(400).json({ success: false, message: 'Organization ID not found for this user' });
            }
            query.organizationId = organizationId;
        }

        const payments = await Payment.find(query)
            .populate('user', 'name')
            .populate('paymentTypeId', 'name')
            .sort({ paidAt: -1 })
            .limit(200);

        const incomeRecords = payments.map(payment => {
            let source = payment.paymentTypeId?.name || payment.type || 'Member Payment';
            source = source.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
            let description = payment.description || `${source} payment from ${payment.user?.name || 'Member'}`;

            return {
                _id: payment._id,
                amount: payment.netToOrganization || payment.amount,
                description,
                source,
                date: payment.paidAt || payment.createdAt,
                type: 'member_payment',
                memberName: payment.user?.name || 'Member',
                paymentType: source,
                isPartial: payment.isPartial,
                remainingAmount: payment.remainingAmount,
                periodKey: payment.periodKey
            };
        });

        const totalCollected = payments.reduce((sum, p) => sum + (p.netToOrganization || p.amount || 0), 0);

        res.status(200).json({
            success: true,
            data: {
                records: incomeRecords,
                summary: { totalCollected, totalCount: payments.length, lastUpdated: new Date() }
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get payment summary (for reporting)
// @route   GET /api/payments/summary
// @access  Private/Admin
exports.getPaymentSummary = async (req, res, next) => {
    try {
        const organizationId = req.user.organizationId;
        const { startDate, endDate, type, periodKey } = req.query;

        let matchCondition = { organizationId };
        if (startDate && endDate) {
            matchCondition.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }
        if (type) matchCondition.type = type;
        if (periodKey) matchCondition.periodKey = periodKey;

        const [summary, byType, byStatus, byPeriod] = await Promise.all([
            Payment.aggregate([
                { $match: matchCondition },
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: '$amount' },
                        totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$netToOrganization', 0] } },
                        totalUnpaid: { $sum: { $cond: [{ $in: ['$status', ['unpaid', 'partial']] }, '$remainingAmount', 0] } },
                        count: { $sum: 1 },
                        paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                        unpaidCount: { $sum: { $cond: [{ $in: ['$status', ['unpaid', 'partial']] }, 1, 0] } }
                    }
                }
            ]),
            Payment.aggregate([
                { $match: matchCondition },
                { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Payment.aggregate([
                { $match: matchCondition },
                { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Payment.aggregate([
                { $match: { ...matchCondition, periodKey: { $ne: null } } },
                { $group: { _id: '$periodKey', total: { $sum: '$amount' }, count: { $sum: 1 } } },
                { $sort: { '_id': -1 } }
            ])
        ]);

        res.status(200).json({
            success: true,
            data: {
                summary: summary[0] || { totalAmount: 0, totalPaid: 0, totalUnpaid: 0, count: 0, paidCount: 0, unpaidCount: 0 },
                byType,
                byStatus,
                byPeriod
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get payments for the currently logged‑in member (own payments)
// @route   GET /api/payments
// @access  Private
exports.getUserPayments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;
        const { periodKey, status, limit = 50 } = req.query;

        const query = {
            user: userId,
            organizationId
        };

        if (periodKey) {
            query.periodKey = periodKey;
        }

        if (status) {
            query.status = status;
        }

        const payments = await Payment.find(query)
            .populate('user', 'name email')
            .populate('paymentTypeId', 'name description frequency')
            .sort({ periodStart: -1, createdAt: -1 })
            .limit(parseInt(limit));

        const groupedByPeriod = payments.reduce((acc, p) => {
            const key = p.periodKey || 'one-time';
            if (!acc[key]) acc[key] = [];
            acc[key].push(p);
            return acc;
        }, {});

        const totalUnpaid = payments
            .filter(p => p.status === 'unpaid' || p.status === 'partial')
            .reduce((sum, p) => sum + (p.remainingAmount || 0), 0);

        res.status(200).json({
            success: true,
            data: payments,
            grouped: groupedByPeriod,
            summary: {
                total: payments.length,
                totalUnpaid,
                periods: Object.keys(groupedByPeriod)
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get all payments for the admin's organization (with filters & pagination)
// @route   GET /api/payments/all
// @access  Private/Admin
exports.getAllPayments = async (req, res, next) => {
    try {
        const organizationId = req.user.organizationId;
        console.log('Getting all payments for organization:', organizationId);

        if (!organizationId && !['super-admin', 'super_admin'].includes(req.user.role)) {
            return res.status(400).json({ success: false, message: 'Organization ID not found for this user' });
        }

        let query = {};
        if (!['super-admin', 'super_admin'].includes(req.user.role)) {
            query.organizationId = organizationId;
        }

        const { status, type, userId, startDate, endDate, periodKey, page = 1, limit = 20 } = req.query;

        if (status) query.status = status;
        if (type) query.type = type;
        if (userId) query.user = userId;
        if (periodKey) query.periodKey = periodKey;
        if (startDate && endDate) {
            query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [payments, total] = await Promise.all([
            Payment.find(query)
                .populate('user', 'name email')
                .populate('paymentTypeId', 'name description')
                .sort({ periodStart: -1, createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Payment.countDocuments(query)
        ]);

        const totals = await Payment.aggregate([
            { $match: query },
            {
                $group: {
                    _id: '$status',
                    total: { $sum: '$amount' },
                    netTotal: { $sum: '$netToOrganization' },
                    count: { $sum: 1 }
                }
            }
        ]);

        const paidTotal = totals.find(t => t._id === 'paid')?.netTotal || 0;
        const unpaidTotal = totals.find(t => t._id === 'unpaid')?.total || 0;
        const partialTotal = totals.find(t => t._id === 'partial')?.total || 0;

        res.status(200).json({
            success: true,
            data: {
                records: payments,
                summary: {
                    totalPaid: paidTotal,
                    totalUnpaid: unpaidTotal,
                    totalPartial: partialTotal,
                    totalPayments: paidTotal + unpaidTotal + partialTotal,
                    count: total
                },
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
    } catch (error) {
        console.error('Error in getAllPayments:', error);
        next(error);
    }
};

// @desc    Get single payment (alias for getPaymentById, with tenant check)
// @route   GET /api/payments/:id
// @access  Private
exports.getPayment = async (req, res, next) => {
    try {
        const payment = await Payment.findOne({
            _id: req.params.id,
            organizationId: req.user.organizationId
        })
            .populate('user', 'name email phone')
            .populate('paymentTypeId', 'name description amount frequency')
            .populate('parentPaymentId');

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this payment' });
        }

        res.status(200).json({ success: true, data: payment });
    } catch (error) {
        next(error);
    }
};

// @desc    Update payment (Admin)
// @route   PUT /api/payments/:id
// @access  Private/Admin
exports.updatePayment = async (req, res, next) => {
    try {
        const { amount, dueDate, description, status, paidAt, periodStart, periodEnd, periodKey } = req.body;
        const organizationId = req.user.organizationId;

        const payment = await Payment.findOne({ _id: req.params.id, organizationId });

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (status) payment.status = status;
        if (paidAt) payment.paidAt = paidAt;
        if (amount) {
            payment.amount = amount;
            payment.targetOrgAmount = amount;
            payment.expectedAmount = amount;
            payment.remainingAmount = amount - (payment.totalPaidSoFar || 0);
        }
        if (dueDate) payment.dueDate = dueDate;
        if (description) payment.description = description;
        if (periodStart) payment.periodStart = periodStart;
        if (periodEnd) payment.periodEnd = periodEnd;
        if (periodKey) payment.periodKey = periodKey;

        await payment.save();

        res.status(200).json({ success: true, data: payment, message: 'Payment updated successfully' });
    } catch (error) {
        next(error);
    }
};

// @desc    Delete payment (Admin) – only if unpaid and no partial payments
// @route   DELETE /api/payments/:id
// @access  Private/Admin
exports.deletePayment = async (req, res, next) => {
    try {
        const payment = await Payment.findOne({ _id: req.params.id, organizationId: req.user.organizationId });

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (payment.status === 'paid') {
            return res.status(400).json({ success: false, message: 'Cannot delete a paid payment' });
        }

        if (payment.parentPaymentId) {
            await Payment.deleteMany({ parentPaymentId: payment._id });
        }

        if (payment.isPartial && payment.partialPayments?.length) {
            return res.status(400).json({ success: false, message: 'Cannot delete a payment that has partial payments' });
        }

        await payment.deleteOne();

        res.status(200).json({ success: true, message: 'Payment deleted successfully' });
    } catch (error) {
        next(error);
    }
};

// ============================================================
// UPDATED: Get pending payments for a member (period-aware)
// @route   GET /api/payments/pending
// @access  Private
// ============================================================
exports.getPendingPayments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;
        const { periodKey } = req.query;

        const paymentTypes = await PaymentType.find({ isActive: true, organizationId });

        const referenceDate = new Date();

        const currentPeriodKeys = paymentTypes
            .filter(pt => pt.isRecurring())
            .map(pt => pt.getPeriodKey(referenceDate))
            .filter(Boolean);

        const paidPayments = await Payment.find({
            user: userId,
            organizationId,
            status: 'paid',
            periodKey: { $in: currentPeriodKeys }
        });

        const paidTypeIds = paidPayments.map(p => p.paymentTypeId?.toString()).filter(Boolean);

        const unpaidPayments = await Payment.find({
            user: userId,
            organizationId,
            status: { $in: ['unpaid', 'partial', 'pending'] },
            remainingAmount: { $gt: 0 }
        });

        const unpaidTypeIds = unpaidPayments.map(p => p.paymentTypeId?.toString()).filter(Boolean);

        const pendingPaymentTypes = paymentTypes.filter(type => {
            const typeId = type._id.toString();

            if (type.isRecurring()) {
                const currentKey = type.getPeriodKey(referenceDate);
                if (paidPayments.some(p =>
                    p.paymentTypeId?.toString() === typeId &&
                    p.periodKey === currentKey
                )) {
                    return false;
                }
                if (unpaidPayments.some(p =>
                    p.paymentTypeId?.toString() === typeId &&
                    p.periodKey === currentKey
                )) {
                    return false;
                }
                return true;
            }

            return !paidTypeIds.includes(typeId) && !unpaidTypeIds.includes(typeId);
        });

        const pendingPayments = pendingPaymentTypes.map(type => {
            const periodInfo = type.isRecurring()
                ? type.getPeriodForDate(referenceDate)
                : { periodStart: null, periodEnd: null, periodLabel: 'One-time' };

            return {
                _id: type._id,
                name: type.name,
                description: type.description,
                amount: type.amount,
                type: type.type,
                isMandatory: type.is_mandatory,
                isRecurring: type.isRecurring(),
                frequency: type.frequency,
                status: 'pending',
                periodStart: periodInfo.periodStart,
                periodEnd: periodInfo.periodEnd,
                periodLabel: periodInfo.periodLabel,
                periodKey: type.isRecurring() ? type.getPeriodKey(referenceDate) : null
            };
        });

        res.status(200).json({
            success: true,
            data: {
                records: pendingPayments,
                total: pendingPayments.length,
                period: {
                    referenceDate: referenceDate,
                    label: referenceDate.toLocaleDateString('default', { month: 'long', year: 'numeric' })
                }
            }
        });
    } catch (error) {
        console.error('Get pending payments error:', error);
        next(error);
    }
};

// ============================================================
// NEW: Get current period payments for a member
// @route   GET /api/payments/current-period
// @access  Private
// ============================================================
exports.getCurrentPeriodPayments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;
        const { periodKey } = req.query;

        let targetPeriodKey = periodKey;
        if (!targetPeriodKey) {
            const now = new Date();
            targetPeriodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }

        const payments = await Payment.find({
            user: userId,
            organizationId,
            periodKey: targetPeriodKey
        })
            .populate('paymentTypeId', 'name description frequency amount')
            .sort({ createdAt: -1 });

        const totalUnpaid = payments
            .filter(p => p.status === 'unpaid' || p.status === 'partial')
            .reduce((sum, p) => sum + (p.remainingAmount || 0), 0);

        const totalPaid = payments
            .filter(p => p.status === 'paid')
            .reduce((sum, p) => sum + (p.amount || 0), 0);

        res.status(200).json({
            success: true,
            data: {
                periodKey: targetPeriodKey,
                payments,
                summary: {
                    total: payments.length,
                    totalUnpaid,
                    totalPaid,
                    paidCount: payments.filter(p => p.status === 'paid').length,
                    unpaidCount: payments.filter(p => p.status === 'unpaid' || p.status === 'partial').length
                }
            }
        });
    } catch (error) {
        console.error('Get current period payments error:', error);
        next(error);
    }
};

// ============================================================
// NEW: Get payment periods for a member (grouped by period)
// @route   GET /api/payments/periods
// @access  Private
// ============================================================
exports.getPaymentPeriods = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;

        const payments = await Payment.find({
            user: userId,
            organizationId,
            periodKey: { $ne: null }
        })
            .populate('paymentTypeId', 'name frequency')
            .sort({ periodStart: -1 });

        const grouped = payments.reduce((acc, p) => {
            const key = p.periodKey;
            if (!acc[key]) {
                acc[key] = {
                    periodKey: key,
                    periodStart: p.periodStart,
                    periodEnd: p.periodEnd,
                    payments: []
                };
            }
            acc[key].payments.push(p);
            return acc;
        }, {});

        const periods = Object.values(grouped).sort((a, b) =>
            new Date(b.periodStart) - new Date(a.periodStart)
        );

        const periodsWithSummary = periods.map(period => {
            const totalAmount = period.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
            const totalPaid = period.payments
                .filter(p => p.status === 'paid')
                .reduce((sum, p) => sum + (p.amount || 0), 0);
            const totalUnpaid = period.payments
                .filter(p => p.status === 'unpaid' || p.status === 'partial')
                .reduce((sum, p) => sum + (p.remainingAmount || 0), 0);

            return {
                ...period,
                summary: {
                    totalAmount,
                    totalPaid,
                    totalUnpaid,
                    paymentCount: period.payments.length,
                    paidCount: period.payments.filter(p => p.status === 'paid').length,
                    unpaidCount: period.payments.filter(p => p.status === 'unpaid' || p.status === 'partial').length
                }
            };
        });

        res.status(200).json({
            success: true,
            data: periodsWithSummary,
            count: periodsWithSummary.length
        });
    } catch (error) {
        console.error('Get payment periods error:', error);
        next(error);
    }
};

// @desc    Get payment statistics for the admin's organisation
// @route   GET /api/payments/stats
// @access  Private/Admin
exports.getPaymentStats = async (req, res, next) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = req.user.organizationId;

        let dateFilter = { organizationId };
        if (startDate && endDate) {
            dateFilter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }

        const [stats, paymentsByType, recentPayments] = await Promise.all([
            Payment.aggregate([
                { $match: dateFilter },
                {
                    $group: {
                        _id: null,
                        totalPayments: { $sum: 1 },
                        totalAmount: { $sum: '$amount' },
                        totalNetToOrg: { $sum: '$netToOrganization' },
                        paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                        unpaidCount: { $sum: { $cond: [{ $in: ['$status', ['unpaid', 'partial']] }, 1, 0] } },
                        paidAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$netToOrganization', 0] } },
                        unpaidAmount: { $sum: { $cond: [{ $in: ['$status', ['unpaid', 'partial']] }, '$remainingAmount', 0] } }
                    }
                }
            ]),
            Payment.aggregate([
                { $match: dateFilter },
                { $group: { _id: '$type', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
            ]),
            Payment.find(dateFilter)
                .populate('user', 'name email')
                .sort({ createdAt: -1 })
                .limit(10)
        ]);

        res.status(200).json({
            success: true,
            data: {
                summary: stats[0] || {
                    totalPayments: 0,
                    totalAmount: 0,
                    totalNetToOrg: 0,
                    paidCount: 0,
                    unpaidCount: 0,
                    paidAmount: 0,
                    unpaidAmount: 0
                },
                byType: paymentsByType,
                recentPayments
            }
        });
    } catch (error) {
        next(error);
    }
};

// ============================================================
// UPDATED: Create payment for member (HYBRID DUES IMPLEMENTATION)
// @route   POST /api/payments/member-payment
// @access  Private
// ============================================================
// exports.createMemberPayment = async (req, res, next) => {
//     console.log('🔥🔥🔥 createMemberPayment WAS CALLED! 🔥🔥🔥');
//     console.log('Request body:', req.body);
//     try {
//         const {
//             name,
//             type,
//             amount,
//             description,
//             paymentTypeId,
//             periodStart,
//             periodEnd,
//             periodKey,
//             months,           // ← NEW: Array of months
//             monthCount,       // ← NEW: Number of months
//             monthlyPrice      // ← NEW: Price per month
//         } = req.body;
//         const userId = req.user.id;
//         const organizationId = req.user.organizationId;

//         if (!name || !type || !amount || amount <= 0) {
//             return res.status(400).json({ success: false, message: 'Missing required fields' });
//         }

//         // ============================================================
//         // HYBRID DUES IMPLEMENTATION: Check if this is a dues payment with months
//         // ============================================================
//         const isDuesPayment = (type === 'dues' || type === 'monthly_dues') && months && months.length > 0;

//         // If it's a dues payment with months, validate months
//         if (isDuesPayment) {
//             if (!months || months.length === 0) {
//                 return res.status(400).json({
//                     success: false,
//                     message: 'Please select at least one month for dues payment'
//                 });
//             }
//             console.log(`📅 Dues payment for months: ${months.join(', ')} (${months.length} months)`);
//         }

//         // ============================================================
//         // NEW: If paymentTypeId is provided, get the payment type
//         // ============================================================
//         let paymentType = null;
//         if (paymentTypeId) {
//             paymentType = await PaymentType.findById(paymentTypeId);
//         }

//         // ============================================================
//         // HYBRID: For dues, check if there's already an active payment for this user
//         // ============================================================
//         let existingPayment = null;
//         if (isDuesPayment && paymentType) {
//             // Check if user already has an active (unpaid/partial/pending) payment for this dues type
//             existingPayment = await Payment.findOne({
//                 user: userId,
//                 paymentTypeId: paymentTypeId,
//                 organizationId: organizationId,
//                 status: { $in: ['unpaid', 'partial', 'pending'] }
//             });

//             if (existingPayment) {
//                 // ============================================================
//                 // EXISTING PAYMENT FOUND - ADD NEW MONTHS TO IT
//                 // ============================================================
//                 console.log(`📝 Adding ${months.length} month(s) to existing payment: ${existingPayment._id}`);

//                 // Filter out months that are already in the payment
//                 const existingMonths = existingPayment.months || [];
//                 const newMonths = months.filter(m => !existingMonths.includes(m));

//                 if (newMonths.length === 0) {
//                     return res.status(400).json({
//                         success: false,
//                         message: 'All selected months are already in your payment. Please select different months.',
//                         data: {
//                             existingMonths: existingMonths,
//                             selectedMonths: months
//                         }
//                     });
//                 }

//                 // Calculate new totals
//                 const monthlyPriceFromType = paymentType.amount || amount;
//                 const allMonths = [...existingMonths, ...newMonths];
//                 const totalAmount = allMonths.length * monthlyPriceFromType;
//                 const totalPayable = Math.ceil(totalAmount / 0.96);

//                 // Update the payment
//                 existingPayment.months = allMonths;
//                 existingPayment.monthCount = allMonths.length;
//                 existingPayment.monthlyPrice = monthlyPriceFromType;
//                 existingPayment.amount = totalAmount;
//                 existingPayment.targetOrgAmount = totalAmount;
//                 existingPayment.expectedAmount = totalPayable;
//                 existingPayment.remainingAmount = totalAmount - (existingPayment.totalPaidSoFar || 0);
//                 existingPayment.status = 'pending';
//                 existingPayment.description = description || `${name} - ${allMonths.join(', ')}`;

//                 // Generate new transaction reference
//                 existingPayment.transactionReference = `PAY-${existingPayment._id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

//                 await existingPayment.save();

//                 console.log(`✅ Payment updated with ${newMonths.length} new month(s). Total: ${allMonths.length} months`);

//                 return res.status(200).json({
//                     success: true,
//                     data: existingPayment,
//                     message: `Added ${newMonths.length} month(s) to your payment. Total: ${allMonths.length} months.`,
//                     isUpdate: true,
//                     addedMonths: newMonths,
//                     totalMonths: allMonths.length,
//                     previousMonths: existingMonths
//                 });
//             }
//         }

//         // ============================================================
//         // NO EXISTING PAYMENT - CREATE NEW
//         // ============================================================

//         // Calculate amount and period info
//         let finalAmount = amount;
//         let finalTargetOrgAmount = amount;
//         let finalExpectedAmount = Math.ceil(amount / 0.96);
//         let finalRemainingAmount = amount;
//         let finalMonths = [];
//         let finalMonthCount = 0;
//         let finalMonthlyPrice = amount;

//         // If dues payment with months, calculate total
//         if (isDuesPayment && paymentType) {
//             finalMonthlyPrice = paymentType.amount || amount;
//             finalMonths = months;
//             finalMonthCount = months.length;
//             finalAmount = months.length * finalMonthlyPrice;
//             finalTargetOrgAmount = finalAmount;
//             finalExpectedAmount = Math.ceil(finalAmount / 0.96);
//             finalRemainingAmount = finalAmount;
//         }

//         // If periodKey not provided but months exist, use first month as periodKey
//         let finalPeriodKey = periodKey;
//         if (!finalPeriodKey && finalMonths.length > 0) {
//             finalPeriodKey = finalMonths[0];
//         }

//         // Generate transaction reference
//         let transactionReference = `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

//         // ===== CREATE NEW PAYMENT =====
//         const payment = await Payment.create({
//             user: userId,
//             name,
//             type,
//             amount: finalAmount,
//             targetOrgAmount: finalTargetOrgAmount,
//             expectedAmount: finalExpectedAmount,
//             paidAmount: 0,
//             remainingAmount: finalRemainingAmount,
//             totalPaidSoFar: 0,
//             isPartial: false,
//             description: description || `${name} payment${finalMonths.length > 0 ? ` - ${finalMonths.join(', ')}` : ''}`,
//             paymentTypeId: paymentTypeId || null,
//             organizationId,
//             status: 'pending',
//             transactionReference: transactionReference,
//             // NEW: Months fields for hybrid dues
//             months: finalMonths,
//             monthCount: finalMonthCount,
//             monthlyPrice: finalMonthlyPrice,
//             // Legacy period fields
//             periodStart: periodStart || null,
//             periodEnd: periodEnd || null,
//             periodKey: finalPeriodKey
//         });

//         // ✅ Force save if field is missing
//         if (!payment.transactionReference) {
//             console.log('⚠️ transactionReference missing, forcing update...');
//             await Payment.findByIdAndUpdate(payment._id, {
//                 $set: { transactionReference: `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` }
//             });
//             const updated = await Payment.findById(payment._id);
//             console.log(`✅ After force update: ${updated.transactionReference}`);
//         }

//         console.log(`✅ Payment created with reference: ${payment.transactionReference} type: ${payment.type} amount: ₦${payment.amount.toLocaleString()}`);
//         console.log(`📅 Months: ${payment.months ? payment.months.join(', ') : 'N/A'}`);

//         res.status(201).json({
//             success: true,
//             data: payment,
//             message: isDuesPayment
//                 ? `Payment created for ${payment.monthCount} month(s): ${payment.months.join(', ')}`
//                 : 'Payment created successfully'
//         });

//     } catch (error) {
//         console.error('Member payment creation error:', error);
//         res.status(500).json({
//             success: false,
//             message: error.message || 'Failed to create payment'
//         });
//     }
// };


// controllers/paymentController.js - Updated createMemberPayment

// exports.createMemberPayment = async (req, res, next) => {
//     console.log('🔥🔥🔥 createMemberPayment WAS CALLED! 🔥🔥🔥');
//     console.log('Request body:', req.body);
//     try {
//         const {
//             name,
//             type,
//             amount,
//             description,
//             paymentTypeId,
//             periodStart,
//             periodEnd,
//             periodKey,
//             months,
//             monthCount,
//             monthlyPrice,
//             includePenalties = true
//         } = req.body;
//         const userId = req.user.id;
//         const organizationId = req.user.organizationId;

//         // ============================================================
//         // VALIDATE BASIC REQUIRED FIELDS
//         // ============================================================
//         if (!name || !type || !amount || amount <= 0) {
//             return res.status(400).json({ success: false, message: 'Missing required fields' });
//         }

//         // ============================================================
//         // GET PAYMENT TYPE
//         // ============================================================
//         let paymentType = null;
//         if (paymentTypeId) {
//             paymentType = await PaymentType.findById(paymentTypeId);
//         }

//         // ============================================================
//         // DETERMINE IF THIS IS A DUES PAYMENT (for month tracking)
//         // ============================================================
//         const isDuesPayment = (type === 'dues' || type === 'monthly_dues') && months && months.length > 0;

//         // ============================================================
//         // VALIDATE DUES PAYMENT (only if months provided)
//         // ============================================================
//         if (isDuesPayment) {
//             if (!months || months.length === 0) {
//                 return res.status(400).json({
//                     success: false,
//                     message: 'Please select at least one month for dues payment'
//                 });
//             }
//             console.log(`📅 Dues payment for months: ${months.join(', ')} (${months.length} months)`);
//         }

//         // ============================================================
//         // CALCULATE PENALTIES FOR ALL PAYMENT TYPES
//         // ============================================================
//         let penaltyInfo = { totalPenalty: 0, breakdown: [], isLate: false };

//         if (paymentType && includePenalties) {
//             // ============================================================
//             // Pass months ONLY if this is a dues payment
//             // ============================================================
//             const penaltyMonths = isDuesPayment ? months : null;
//             penaltyInfo = calculateLatePenalties(paymentType, new Date(), penaltyMonths);

//             if (penaltyInfo.isLate) {
//                 console.log(`⚠️ Late penalty applied: ₦${penaltyInfo.totalPenalty}`);
//                 if (isDuesPayment && penaltyInfo.breakdown.length > 0) {
//                     penaltyInfo.breakdown.filter(b => b.isLate).forEach(b => {
//                         console.log(`   ${b.month}: ₦${b.penalty} penalty`);
//                     });
//                 }
//             }
//         }

//         // ============================================================
//         // CALCULATE AMOUNTS
//         // ============================================================
//         let finalAmount = amount;
//         let finalTargetOrgAmount = amount;
//         let finalExpectedAmount = Math.ceil(amount / 0.96);
//         let finalRemainingAmount = amount;
//         let finalMonths = [];
//         let finalMonthCount = 0;
//         let finalMonthlyPrice = amount;
//         let finalPenaltyAmount = penaltyInfo.totalPenalty || 0;
//         let finalPenaltyBreakdown = penaltyInfo.breakdown || [];

//         if (isDuesPayment && paymentType) {
//             // ============================================================
//             // DUES PAYMENT - Calculate with months
//             // ============================================================
//             finalMonthlyPrice = paymentType.amount || amount;
//             finalMonths = months;
//             finalMonthCount = months.length;
//             const baseAmount = months.length * finalMonthlyPrice;
//             finalAmount = baseAmount + finalPenaltyAmount;
//             finalTargetOrgAmount = baseAmount;
//             finalExpectedAmount = Math.ceil(finalAmount / 0.96);
//             finalRemainingAmount = finalAmount;
//         } else {
//             // ============================================================
//             // NON-DUES PAYMENT - Add penalty to base amount
//             // ============================================================
//             finalAmount = amount + finalPenaltyAmount;
//             finalTargetOrgAmount = amount;
//             finalExpectedAmount = Math.ceil(finalAmount / 0.96);
//             finalRemainingAmount = finalAmount;
//         }

//         // ============================================================
//         // CHECK FOR EXISTING PAYMENT (ONLY FOR DUES)
//         // ============================================================
//         let existingPayment = null;
//         if (isDuesPayment && paymentType) {
//             existingPayment = await Payment.findOne({
//                 user: userId,
//                 paymentTypeId: paymentTypeId,
//                 organizationId: organizationId,
//                 status: { $in: ['unpaid', 'partial', 'pending'] }
//             });
//         }

//         // ============================================================
//         // IF EXISTING PAYMENT FOUND - ADD MONTHS (ONLY FOR DUES)
//         // ============================================================
//         if (existingPayment) {
//             console.log(`📝 Adding ${months.length} month(s) to existing payment: ${existingPayment._id}`);

//             const existingMonths = existingPayment.months || [];
//             const newMonths = months.filter(m => !existingMonths.includes(m));

//             if (newMonths.length === 0) {
//                 return res.status(400).json({
//                     success: false,
//                     message: 'All selected months are already in your payment. Please select different months.',
//                     data: { existingMonths, selectedMonths: months }
//                 });
//             }

//             // Calculate penalties for new months only
//             const newPenaltyInfo = calculateLatePenalties(paymentType, new Date(), newMonths);

//             const allMonths = [...existingMonths, ...newMonths];
//             const newBaseTotal = allMonths.length * finalMonthlyPrice;
//             const totalExistingPenalty = existingPayment.penaltyAmount || 0;
//             const newTotalWithPenalty = newBaseTotal + totalExistingPenalty + (newPenaltyInfo.totalPenalty || 0);
//             const newTotalPayable = Math.ceil(newTotalWithPenalty / 0.96);

//             existingPayment.months = allMonths;
//             existingPayment.monthCount = allMonths.length;
//             existingPayment.monthlyPrice = finalMonthlyPrice;
//             existingPayment.amount = newBaseTotal;
//             existingPayment.targetOrgAmount = newBaseTotal;
//             existingPayment.expectedAmount = newTotalPayable;
//             existingPayment.remainingAmount = newTotalWithPenalty - (existingPayment.totalPaidSoFar || 0);
//             existingPayment.status = 'pending';
//             existingPayment.description = description || `${name} - ${allMonths.join(', ')}`;
//             existingPayment.penaltyAmount = totalExistingPenalty + (newPenaltyInfo.totalPenalty || 0);
//             existingPayment.penaltyBreakdown = [
//                 ...(existingPayment.penaltyBreakdown || []),
//                 ...newPenaltyInfo.breakdown
//             ];
//             existingPayment.transactionReference = `PAY-${existingPayment._id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

//             await existingPayment.save();

//             console.log(`✅ Payment updated with ${newMonths.length} new month(s). Total: ${allMonths.length} months`);

//             return res.status(200).json({
//                 success: true,
//                 data: existingPayment,
//                 message: `Added ${newMonths.length} month(s) to your payment. Total: ${allMonths.length} months.`,
//                 isUpdate: true,
//                 addedMonths: newMonths,
//                 totalMonths: allMonths.length,
//                 previousMonths: existingMonths,
//                 penaltyInfo: {
//                     totalPenalty: existingPayment.penaltyAmount,
//                     breakdown: existingPayment.penaltyBreakdown
//                 }
//             });
//         }

//         // ============================================================
//         // CREATE NEW PAYMENT - Works for ALL types
//         // ============================================================
//         let transactionReference = `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

//         const paymentData = {
//             user: userId,
//             name,
//             type,
//             amount: finalAmount,
//             targetOrgAmount: finalTargetOrgAmount,
//             expectedAmount: finalExpectedAmount,
//             paidAmount: 0,
//             remainingAmount: finalRemainingAmount,
//             totalPaidSoFar: 0,
//             isPartial: false,
//             description: description || `${name} payment${finalMonths.length > 0 ? ` - ${finalMonths.join(', ')}` : ''}`,
//             paymentTypeId: paymentTypeId || null,
//             organizationId,
//             status: 'pending',
//             transactionReference: transactionReference,
//             // ============================================================
//             // HYBRID DUES FIELDS (only for dues payments)
//             // ============================================================
//             months: finalMonths,
//             monthCount: finalMonthCount,
//             monthlyPrice: finalMonthlyPrice,
//             // ============================================================
//             // PENALTY FIELDS (ALL payment types)
//             // ============================================================
//             penaltyAmount: finalPenaltyAmount,
//             penaltyBreakdown: finalPenaltyBreakdown,
//             // ============================================================
//             // LEGACY PERIOD FIELDS
//             // ============================================================
//             periodStart: periodStart || null,
//             periodEnd: periodEnd || null,
//             periodKey: periodKey || (finalMonths.length > 0 ? finalMonths[0] : null)
//         };

//         const payment = await Payment.create(paymentData);

//         console.log(`✅ Payment created with reference: ${payment.transactionReference}`);
//         console.log(`📝 Type: ${payment.type}`);
//         console.log(`💰 Base amount: ₦${payment.amount}`);
//         console.log(`⚠️ Penalty: ₦${payment.penaltyAmount || 0}`);
//         console.log(`💰 Total amount: ₦${payment.amount + (payment.penaltyAmount || 0)}`);

//         // ============================================================
//         // RESPONSE
//         // ============================================================
//         const responseData = {
//             success: true,
//             data: payment,
//             message: 'Payment created successfully',
//             penaltyInfo: {
//                 totalPenalty: payment.penaltyAmount,
//                 breakdown: payment.penaltyBreakdown,
//                 isLate: penaltyInfo.isLate
//             }
//         };

//         if (isDuesPayment) {
//             responseData.message = `Payment created for ${payment.monthCount} month(s): ${payment.months.join(', ')}`;
//         }

//         if (payment.penaltyAmount > 0) {
//             responseData.message += ` (Includes ₦${payment.penaltyAmount} late penalty)`;
//         }

//         res.status(201).json(responseData);

//     } catch (error) {
//         console.error('❌ Member payment creation error:', error);
//         res.status(500).json({
//             success: false,
//             message: error.message || 'Failed to create payment'
//         });
//     }
// };

// controllers/paymentController.js - Updated createMemberPayment with Strict Full Payment

exports.createMemberPayment = async (req, res, next) => {
    console.log('🔥🔥🔥 createMemberPayment WAS CALLED! 🔥🔥🔥');
    console.log('Request body:', req.body);
    try {
        const {
            name,
            type,
            amount,
            description,
            paymentTypeId,
            periodStart,
            periodEnd,
            periodKey,
            months,
            monthCount,
            monthlyPrice,
            includePenalties = true,
            customAmount  // ← ADD THIS: For frontend custom amount
        } = req.body;
        const userId = req.user.id;
        const organizationId = req.user.organizationId;

        // ============================================================
        // VALIDATE BASIC REQUIRED FIELDS
        // ============================================================
        if (!name || !type || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // ============================================================
        // GET PAYMENT TYPE
        // ============================================================
        let paymentType = null;
        if (paymentTypeId) {
            paymentType = await PaymentType.findById(paymentTypeId);
        }

        // ============================================================
        // DETERMINE IF THIS IS A DUES PAYMENT (for month tracking)
        // ============================================================
        const isDuesPayment = (type === 'dues' || type === 'monthly_dues') && months && months.length > 0;

        // ============================================================
        // VALIDATE DUES PAYMENT (only if months provided)
        // ============================================================
        if (isDuesPayment) {
            if (!months || months.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one month for dues payment'
                });
            }
            console.log(`📅 Dues payment for months: ${months.join(', ')} (${months.length} months)`);
        }

        // ============================================================
        // CALCULATE PENALTIES FOR ALL PAYMENT TYPES
        // ============================================================
        let penaltyInfo = { totalPenalty: 0, breakdown: [], isLate: false };

        if (paymentType && includePenalties) {
            const penaltyMonths = isDuesPayment ? months : null;
            penaltyInfo = calculateLatePenalties(paymentType, new Date(), penaltyMonths);

            if (penaltyInfo.isLate) {
                console.log(`⚠️ Late penalty applied: ₦${penaltyInfo.totalPenalty}`);
                if (isDuesPayment && penaltyInfo.breakdown.length > 0) {
                    penaltyInfo.breakdown.filter(b => b.isLate).forEach(b => {
                        console.log(`   ${b.month}: ₦${b.penalty} penalty`);
                    });
                }
            }
        }

        // ============================================================
        // CALCULATE AMOUNTS
        // ============================================================
        let finalAmount = amount;
        let finalTargetOrgAmount = amount;
        let finalExpectedAmount = Math.ceil(amount / 0.96);
        let finalRemainingAmount = amount;
        let finalMonths = [];
        let finalMonthCount = 0;
        let finalMonthlyPrice = amount;
        let finalPenaltyAmount = penaltyInfo.totalPenalty || 0;
        let finalPenaltyBreakdown = penaltyInfo.breakdown || [];

        if (isDuesPayment && paymentType) {
            // ============================================================
            // DUES PAYMENT - Calculate with months
            // ============================================================
            finalMonthlyPrice = paymentType.amount || amount;
            finalMonths = months;
            finalMonthCount = months.length;
            const baseAmount = months.length * finalMonthlyPrice;
            finalAmount = baseAmount + finalPenaltyAmount;  // ← Base + Penalty
            finalTargetOrgAmount = baseAmount;              // ← Org only gets base
            finalExpectedAmount = Math.ceil(finalAmount / 0.96);  // ← With fees
            finalRemainingAmount = finalAmount;

            // ============================================================
            // ⭐ STRICT CHECK: For dues, customAmount must equal expected amount
            // ============================================================
            if (customAmount) {
                const customAmountNum = parseFloat(customAmount);
                // Allow 1 NGN tolerance for rounding
                if (customAmountNum < finalExpectedAmount - 1) {
                    return res.status(400).json({
                        success: false,
                        message: `Partial payments are not allowed for dues. The full amount of ₦${finalExpectedAmount} is required.`,
                        expectedAmount: finalExpectedAmount,
                        providedAmount: customAmountNum,
                        baseAmount: baseAmount,
                        penaltyAmount: finalPenaltyAmount
                    });
                }
            }

        } else {
            // ============================================================
            // NON-DUES PAYMENT - Add penalty to base amount
            // ============================================================
            finalAmount = amount + finalPenaltyAmount;
            finalTargetOrgAmount = amount;
            finalExpectedAmount = Math.ceil(finalAmount / 0.96);
            finalRemainingAmount = finalAmount;
        }

        // ============================================================
        // CHECK FOR EXISTING PAYMENT (ONLY FOR DUES)
        // ============================================================
        let existingPayment = null;
        if (isDuesPayment && paymentType) {
            existingPayment = await Payment.findOne({
                user: userId,
                paymentTypeId: paymentTypeId,
                organizationId: organizationId,
                status: { $in: ['unpaid', 'partial', 'pending'] }
            });
        }

        // ============================================================
        // IF EXISTING PAYMENT FOUND - ADD MONTHS (ONLY FOR DUES)
        // ============================================================
        if (existingPayment) {
            console.log(`📝 Adding ${months.length} month(s) to existing payment: ${existingPayment._id}`);

            const existingMonths = existingPayment.months || [];
            const newMonths = months.filter(m => !existingMonths.includes(m));

            if (newMonths.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'All selected months are already in your payment. Please select different months.',
                    data: { existingMonths, selectedMonths: months }
                });
            }

            // Calculate penalties for new months only
            const newPenaltyInfo = calculateLatePenalties(paymentType, new Date(), newMonths);

            const allMonths = [...existingMonths, ...newMonths];
            const newBaseTotal = allMonths.length * finalMonthlyPrice;
            const totalExistingPenalty = existingPayment.penaltyAmount || 0;
            const newTotalWithPenalty = newBaseTotal + totalExistingPenalty + (newPenaltyInfo.totalPenalty || 0);
            const newTotalPayable = Math.ceil(newTotalWithPenalty / 0.96);

            // ⭐ STRICT CHECK: For existing payment update, check customAmount
            if (customAmount) {
                const customAmountNum = parseFloat(customAmount);
                if (customAmountNum < newTotalPayable - 1) {
                    return res.status(400).json({
                        success: false,
                        message: `Partial payments are not allowed for dues. The full amount of ₦${newTotalPayable} is required.`,
                        expectedAmount: newTotalPayable,
                        providedAmount: customAmountNum
                    });
                }
            }

            existingPayment.months = allMonths;
            existingPayment.monthCount = allMonths.length;
            existingPayment.monthlyPrice = finalMonthlyPrice;
            existingPayment.amount = newBaseTotal;
            existingPayment.targetOrgAmount = newBaseTotal;
            existingPayment.expectedAmount = newTotalPayable;
            existingPayment.remainingAmount = newTotalWithPenalty - (existingPayment.totalPaidSoFar || 0);
            existingPayment.status = 'pending';
            existingPayment.description = description || `${name} - ${allMonths.join(', ')}`;
            existingPayment.penaltyAmount = totalExistingPenalty + (newPenaltyInfo.totalPenalty || 0);
            existingPayment.penaltyBreakdown = [
                ...(existingPayment.penaltyBreakdown || []),
                ...newPenaltyInfo.breakdown
            ];
            existingPayment.transactionReference = `PAY-${existingPayment._id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            await existingPayment.save();

            console.log(`✅ Payment updated with ${newMonths.length} new month(s). Total: ${allMonths.length} months`);
            console.log(`💰 Expected amount: ₦${existingPayment.expectedAmount}`);

            return res.status(200).json({
                success: true,
                data: existingPayment,
                message: `Added ${newMonths.length} month(s) to your payment. Total: ${allMonths.length} months.`,
                isUpdate: true,
                addedMonths: newMonths,
                totalMonths: allMonths.length,
                previousMonths: existingMonths,
                expectedAmount: existingPayment.expectedAmount,
                penaltyInfo: {
                    totalPenalty: existingPayment.penaltyAmount,
                    breakdown: existingPayment.penaltyBreakdown
                }
            });
        }

        // ============================================================
        // CREATE NEW PAYMENT - Works for ALL types
        // ============================================================
        let transactionReference = `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const paymentData = {
            user: userId,
            name,
            type,
            amount: finalTargetOrgAmount,  // ← Store base amount (org gets this)
            targetOrgAmount: finalTargetOrgAmount,
            expectedAmount: finalExpectedAmount,
            paidAmount: 0,
            remainingAmount: finalRemainingAmount,
            totalPaidSoFar: 0,
            isPartial: false,
            description: description || `${name} payment${finalMonths.length > 0 ? ` - ${finalMonths.join(', ')}` : ''}`,
            paymentTypeId: paymentTypeId || null,
            organizationId,
            status: 'pending',
            transactionReference: transactionReference,
            // ============================================================
            // HYBRID DUES FIELDS (only for dues payments)
            // ============================================================
            months: finalMonths,
            monthCount: finalMonthCount,
            monthlyPrice: finalMonthlyPrice,
            // ============================================================
            // PENALTY FIELDS (ALL payment types)
            // ============================================================
            penaltyAmount: finalPenaltyAmount,
            penaltyBreakdown: finalPenaltyBreakdown,
            // ============================================================
            // LEGACY PERIOD FIELDS
            // ============================================================
            periodStart: periodStart || null,
            periodEnd: periodEnd || null,
            periodKey: periodKey || (finalMonths.length > 0 ? finalMonths[0] : null)
        };

        const payment = await Payment.create(paymentData);

        console.log(`✅ Payment created with reference: ${payment.transactionReference}`);
        console.log(`📝 Type: ${payment.type}`);
        console.log(`💰 Base amount: ₦${payment.amount}`);
        console.log(`⚠️ Penalty: ₦${payment.penaltyAmount || 0}`);
        console.log(`💰 Total amount: ₦${payment.amount + (payment.penaltyAmount || 0)}`);
        console.log(`💰 Expected amount (with fees): ₦${payment.expectedAmount}`);

        // ============================================================
        // RESPONSE
        // ============================================================
        const responseData = {
            success: true,
            data: payment,
            message: 'Payment created successfully',
            expectedAmount: payment.expectedAmount,
            baseAmount: payment.amount,
            penaltyAmount: payment.penaltyAmount,
            penaltyInfo: {
                totalPenalty: payment.penaltyAmount,
                breakdown: payment.penaltyBreakdown,
                isLate: penaltyInfo.isLate
            }
        };

        if (isDuesPayment) {
            responseData.message = `Payment created for ${payment.monthCount} month(s): ${payment.months.join(', ')}`;
        }

        if (payment.penaltyAmount > 0) {
            responseData.message += ` (Includes ₦${payment.penaltyAmount} late penalty)`;
        }

        res.status(201).json(responseData);

    } catch (error) {
        console.error('❌ Member payment creation error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
        });
    }
};

// =========================
// NEW: Get dues summary for a member (Hybrid approach)
// @route   GET /api/payments/dues-summary
// @access  Private
// ============================================================
exports.getDuesSummary = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;

        // Get all dues payments for this user
        const payments = await Payment.find({
            user: userId,
            organizationId: organizationId,
            type: { $in: ['dues', 'monthly_dues'] }
        }).populate('paymentTypeId', 'name amount frequency is_mandatory');

        // Collect all months
        const paidMonths = [];
        const unpaidMonths = [];
        const pendingMonths = [];
        let totalPaid = 0;
        let totalRemaining = 0;
        let totalMonths = 0;

        payments.forEach(payment => {
            const months = payment.months || [];
            if (months.length === 0) {
                // If no months array, use periodKey as fallback
                if (payment.periodKey) {
                    months.push(payment.periodKey);
                }
            }

            months.forEach(month => {
                totalMonths++;
                if (payment.status === 'paid') {
                    paidMonths.push(month);
                    totalPaid += (payment.amount / months.length);
                } else if (payment.status === 'pending') {
                    pendingMonths.push(month);
                } else {
                    unpaidMonths.push(month);
                    totalRemaining += (payment.remainingAmount / months.length || payment.amount / months.length);
                }
            });
        });

        // Remove duplicates
        const uniquePaidMonths = [...new Set(paidMonths)].sort();
        const uniqueUnpaidMonths = [...new Set(unpaidMonths)].sort();
        const uniquePendingMonths = [...new Set(pendingMonths)].sort();

        // Generate all months in the current year for comparison
        const currentYear = new Date().getFullYear();
        const allMonths = [];
        for (let i = 0; i < 12; i++) {
            const date = new Date(currentYear, i, 1);
            const monthKey = `${currentYear}-${String(i + 1).padStart(2, '0')}`;
            const monthName = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

            let status = 'not_created';
            if (uniquePaidMonths.includes(monthKey)) {
                status = 'paid';
            } else if (uniquePendingMonths.includes(monthKey)) {
                status = 'pending';
            } else if (uniqueUnpaidMonths.includes(monthKey)) {
                status = 'unpaid';
            }

            allMonths.push({
                key: monthKey,
                name: monthName,
                status,
                isCurrent: i === new Date().getMonth(),
                isPast: i < new Date().getMonth() || currentYear < new Date().getFullYear()
            });
        }

        res.status(200).json({
            success: true,
            data: {
                summary: {
                    totalMonths,
                    paidMonths: uniquePaidMonths.length,
                    unpaidMonths: uniqueUnpaidMonths.length,
                    pendingMonths: uniquePendingMonths.length,
                    totalPaid: totalPaid,
                    totalRemaining: totalRemaining
                },
                paidMonths: uniquePaidMonths,
                unpaidMonths: uniqueUnpaidMonths,
                pendingMonths: uniquePendingMonths,
                allMonths: allMonths,
                payments: payments
            }
        });

    } catch (error) {
        console.error('Get dues summary error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to get dues summary'
        });
    }
};

// ============================================================
// NEW: Get a single dues payment by ID (with month details)
// @route   GET /api/payments/dues-payment/:id
// @access  Private
// ============================================================
exports.getDuesPaymentById = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const organizationId = req.user.organizationId;
        const { id } = req.params;

        const payment = await Payment.findOne({
            _id: id,
            user: userId,
            organizationId: organizationId,
            type: { $in: ['dues', 'monthly_dues'] }
        }).populate('paymentTypeId', 'name amount frequency is_mandatory');

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Dues payment not found'
            });
        }

        // Calculate progress
        const totalMonths = payment.months ? payment.months.length : 0;
        const paidMonths = payment.status === 'paid' ? totalMonths : 0;
        const progress = totalMonths > 0 ? (paidMonths / totalMonths) * 100 : 0;

        res.status(200).json({
            success: true,
            data: {
                payment,
                progress,
                totalMonths,
                paidMonths,
                remainingMonths: totalMonths - paidMonths
            }
        });

    } catch (error) {
        console.error('Get dues payment by ID error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to get dues payment'
        });
    }
};

// ============================================================
// NEW: Admin - Create dues payments for a member (bulk)
// @route   POST /api/payments/admin/create-dues
// @access  Private/Admin
// ============================================================
exports.adminCreateDuesPayment = async (req, res, next) => {
    try {
        const { userId, paymentTypeId, months, name, type, amount } = req.body;
        const organizationId = req.user.organizationId;

        if (!userId || !paymentTypeId || !months || months.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'User ID, payment type ID, and months are required'
            });
        }

        const targetUser = await User.findOne({ _id: userId, organizationId });
        if (!targetUser) {
            return res.status(403).json({
                success: false,
                message: 'User not found in your organization'
            });
        }

        const paymentType = await PaymentType.findOne({
            _id: paymentTypeId,
            organizationId,
            isActive: true
        });

        if (!paymentType) {
            return res.status(404).json({
                success: false,
                message: 'Payment type not found or inactive'
            });
        }

        // Check if user already has an active payment for this type
        const existingPayment = await Payment.findOne({
            user: userId,
            paymentTypeId: paymentTypeId,
            organizationId,
            status: { $in: ['unpaid', 'partial', 'pending'] }
        });

        if (existingPayment) {
            // Add months to existing payment
            const existingMonths = existingPayment.months || [];
            const newMonths = months.filter(m => !existingMonths.includes(m));

            if (newMonths.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'All selected months are already in the payment'
                });
            }

            const allMonths = [...existingMonths, ...newMonths];
            const totalAmount = allMonths.length * paymentType.amount;

            existingPayment.months = allMonths;
            existingPayment.monthCount = allMonths.length;
            existingPayment.amount = totalAmount;
            existingPayment.targetOrgAmount = totalAmount;
            existingPayment.expectedAmount = Math.ceil(totalAmount / 0.96);
            existingPayment.remainingAmount = totalAmount - (existingPayment.totalPaidSoFar || 0);
            existingPayment.status = 'unpaid';

            await existingPayment.save();

            return res.status(200).json({
                success: true,
                data: existingPayment,
                message: `Added ${newMonths.length} month(s) to existing payment. Total: ${allMonths.length} months.`
            });
        }

        // Create new payment
        const totalAmount = months.length * paymentType.amount;
        const transactionReference = `ADMIN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const payment = await Payment.create({
            user: userId,
            name: name || paymentType.name,
            type: type || paymentType.type,
            amount: totalAmount,
            targetOrgAmount: totalAmount,
            expectedAmount: Math.ceil(totalAmount / 0.96),
            remainingAmount: totalAmount,
            totalPaidSoFar: 0,
            isPartial: false,
            description: `${paymentType.name} - ${months.join(', ')}`,
            paymentTypeId: paymentTypeId,
            organizationId,
            status: 'unpaid',
            transactionReference: transactionReference,
            months: months,
            monthCount: months.length,
            monthlyPrice: paymentType.amount,
            periodKey: months[0]
        });

        res.status(201).json({
            success: true,
            data: payment,
            message: `Created dues payment for ${months.length} month(s)`
        });

    } catch (error) {
        console.error('Admin create dues payment error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create dues payment'
        });
    }
};

// @desc    Process bulk payments (Admin)
// @route   POST /api/payments/bulk
// @access  Private/Admin
exports.processBulkPayments = async (req, res, next) => {
    try {
        const { payments } = req.body;
        const organizationId = req.user.organizationId;

        const successful = [];
        const failed = [];

        for (const payment of payments) {
            try {
                const user = await User.findOne({ _id: payment.userId, organizationId });
                if (!user) {
                    failed.push({ ...payment, error: 'User not found in organization' });
                    continue;
                }

                const existingPayment = await Payment.findOne({
                    user: payment.userId,
                    type: payment.type,
                    status: 'paid',
                    organizationId
                });

                if (existingPayment) {
                    failed.push({ ...payment, error: 'Payment already exists' });
                    continue;
                }

                const newPayment = await Payment.create({
                    user: payment.userId,
                    name: `${payment.type} payment`,
                    type: payment.type,
                    amount: payment.amount,
                    targetOrgAmount: payment.amount,
                    expectedAmount: payment.amount,
                    remainingAmount: payment.amount,
                    totalPaidSoFar: 0,
                    dueDate: payment.dueDate || null,
                    description: payment.description || `${payment.type} payment`,
                    organizationId,
                    status: 'unpaid',
                    createdBy: req.user.id
                });

                successful.push(newPayment);
            } catch (error) {
                failed.push({ ...payment, error: error.message });
            }
        }

        res.status(201).json({
            success: true,
            data: { successful, failed, total: payments.length, successCount: successful.length, failedCount: failed.length },
            message: `Processed ${successful.length} successful, ${failed.length} failed`
        });
    } catch (error) {
        console.error('Bulk payment error:', error);
        next(error);
    }
};

// @desc    Record manual partial payment (Admin - for bank transfers)
// @route   POST /api/payments/record-partial
// @access  Private/Admin
exports.recordPartialPayment = async (req, res, next) => {
    try {
        const { paymentId, amountPaid, reference, notes } = req.body;
        const organizationId = req.user.organizationId;

        const originalPayment = await Payment.findOne({
            _id: paymentId,
            organizationId
        }).populate('user', 'name email');

        if (!originalPayment) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }

        if (originalPayment.status === 'paid') {
            return res.status(400).json({ success: false, message: 'Payment already completed' });
        }
        // ============================================================
        // ⭐ STRICT CHECK: Prevent partial payments for dues
        // ============================================================
        const isDuesPayment = (originalPayment.type === 'dues' || originalPayment.type === 'monthly_dues')
            && originalPayment.months && originalPayment.months.length > 0;

        if (isDuesPayment) {
            const totalExpected = (originalPayment.amount || 0) + (originalPayment.penaltyAmount || 0);
            const totalPayable = Math.ceil(totalExpected / 0.96);

            if (amountPaid < totalPayable - 1) {
                return res.status(400).json({
                    success: false,
                    message: `Partial payments are not allowed for dues. Expected amount: ₦${totalPayable}`,
                    expectedAmount: totalPayable,
                    paidAmount: amountPaid
                });
            }
        }
        if (!amountPaid || amountPaid <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        const result = await handlePartialPayment(
            originalPayment,
            amountPaid,
            reference || `MANUAL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            notes
        );

        res.status(200).json({
            success: true,
            data: {
                payment: originalPayment,
                remainingAmount: result.remainingTarget,
                outstandingPayment: result.outstandingPayment,
                netToOrg: result.netToOrg
            },
            message: result.remainingTarget > 0
                ? `Partial payment of ₦${amountPaid.toLocaleString()} recorded. Outstanding balance: ₦${result.remainingTarget.toLocaleString()}`
                : 'Payment completed successfully'
        });
    } catch (error) {
        console.error('Record partial payment error:', error);
        next(error);
    }
};