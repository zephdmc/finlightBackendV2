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
        const { periodKey } = req.query; // NEW: optional period filter

        const query = {
            user: userId,
            organizationId,
            status: { $in: ['unpaid', 'partial'] },
            remainingAmount: { $gt: 0 }
        };

        // NEW: Filter by specific period if provided
        if (periodKey) {
            query.periodKey = periodKey;
        }

        const outstandingPayments = await Payment.find(query)
            .populate('paymentTypeId', 'name description frequency')
            .sort({ periodStart: -1, dueDate: 1, createdAt: 1 });

        const totalOutstanding = outstandingPayments.reduce((sum, p) => sum + (p.remainingAmount || p.amount), 0);

        // NEW: Group by period for better display
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

        // NEW: If paymentTypeId is provided, try to auto-fill period info
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

        // Use provided period data or auto-generated
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
            // NEW: Period fields
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
                periodKey: payment.periodKey // NEW: include period info
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
        if (periodKey) matchCondition.periodKey = periodKey; // NEW: filter by period

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
            // NEW: Group by period
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
                byPeriod // NEW: period breakdown
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

        // NEW: Filter by period
        if (periodKey) {
            query.periodKey = periodKey;
        }

        // Filter by status
        if (status) {
            query.status = status;
        }

        const payments = await Payment.find(query)
            .populate('user', 'name email')
            .populate('paymentTypeId', 'name description frequency')
            .sort({ periodStart: -1, createdAt: -1 })
            .limit(parseInt(limit));

        // NEW: Group by period for better UI
        const groupedByPeriod = payments.reduce((acc, p) => {
            const key = p.periodKey || 'one-time';
            if (!acc[key]) acc[key] = [];
            acc[key].push(p);
            return acc;
        }, {});

        // Calculate summary
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
        if (periodKey) query.periodKey = periodKey; // NEW
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
        // NEW: Period fields
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
        const { periodKey } = req.query; // Optional period filter

        // Get all active payment types
        const paymentTypes = await PaymentType.find({ isActive: true, organizationId });

        // Get the current period key for each payment type
        // NEW: Determine which period we're checking
        const referenceDate = new Date();

        // Get all payments the user has already paid (for current periods)
        // Instead of checking "ever paid", check "paid for current period"
        const currentPeriodKeys = paymentTypes
            .filter(pt => pt.isRecurring())
            .map(pt => pt.getPeriodKey(referenceDate))
            .filter(Boolean);

        // Get paid payments for current periods
        const paidPayments = await Payment.find({
            user: userId,
            organizationId,
            status: 'paid',
            periodKey: { $in: currentPeriodKeys }
        });

        const paidTypeIds = paidPayments.map(p => p.paymentTypeId?.toString()).filter(Boolean);

        // Also get payments that are unpaid (already exists)
        const unpaidPayments = await Payment.find({
            user: userId,
            organizationId,
            status: { $in: ['unpaid', 'partial', 'pending'] },
            remainingAmount: { $gt: 0 }
        });

        const unpaidTypeIds = unpaidPayments.map(p => p.paymentTypeId?.toString()).filter(Boolean);

        // Determine pending payment types
        const pendingPaymentTypes = paymentTypes.filter(type => {
            const typeId = type._id.toString();

            // If it's recurring, check if paid for current period
            if (type.isRecurring()) {
                const currentKey = type.getPeriodKey(referenceDate);
                // Already paid for this period
                if (paidPayments.some(p =>
                    p.paymentTypeId?.toString() === typeId &&
                    p.periodKey === currentKey
                )) {
                    return false;
                }
                // Already has an unpaid record for this period
                if (unpaidPayments.some(p =>
                    p.paymentTypeId?.toString() === typeId &&
                    p.periodKey === currentKey
                )) {
                    return false;
                }
                return true;
            }

            // For one-time payments: check if ever paid
            return !paidTypeIds.includes(typeId) && !unpaidTypeIds.includes(typeId);
        });

        // Build response with period info
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

        // If no periodKey provided, use current month
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

        // Calculate summary
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

        // Get all payments with period keys
        const payments = await Payment.find({
            user: userId,
            organizationId,
            periodKey: { $ne: null }
        })
            .populate('paymentTypeId', 'name frequency')
            .sort({ periodStart: -1 });

        // Group by periodKey
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

        // Convert to array and sort
        const periods = Object.values(grouped).sort((a, b) =>
            new Date(b.periodStart) - new Date(a.periodStart)
        );

        // Calculate summary per period
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

// @desc    Create payment for member (no admin required, used by gateway)
// @route   POST /api/payments/member-payment
// @access  Private
exports.createMemberPayment = async (req, res, next) => {
    console.log('🔥🔥🔥 createMemberPayment WAS CALLED! 🔥🔥🔥');
    console.log('Request body:', req.body);
    try {
        const { name, type, amount, description, paymentTypeId, periodStart, periodEnd, periodKey } = req.body;
        const userId = req.user.id;
        const organizationId = req.user.organizationId;

        if (!name || !type || !amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // NEW: If paymentTypeId is provided, try to auto-fill period info
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

        // Use provided period data or auto-generated
        const finalPeriodStart = periodStart || periodData.periodStart || null;
        const finalPeriodEnd = periodEnd || periodData.periodEnd || null;
        const finalPeriodKey = periodKey || periodData.periodKey || null;

        // ===== CHECK FOR EXISTING PAYMENTS =====
        // ✅ Use consistent variable name: existingPayment
        // NEW: Also check by periodKey if available
        let existingPaymentQuery = {
            user: userId,
            paymentTypeId,
            organizationId,
            status: { $in: ['unpaid', 'partial', 'pending'] },
            remainingAmount: { $gt: 0 }
        };

        // If periodKey is available, check for same period
        if (finalPeriodKey) {
            existingPaymentQuery.periodKey = finalPeriodKey;
        }

        const existingPayment = await Payment.findOne(existingPaymentQuery);

        if (existingPayment) {
            // If there's an existing payment, return it
            let message = 'You already have a payment for this type.';

            if (existingPayment.status === 'pending') {
                message = 'You have a pending payment. Please complete or cancel it first.';
            } else if (existingPayment.status === 'partial') {
                message = `You have an outstanding balance of ₦${existingPayment.remainingAmount.toLocaleString()}. Please complete the payment.`;
            } else if (existingPayment.status === 'unpaid') {
                message = 'You have an unpaid payment. Please complete the payment.';
            }

            return res.status(200).json({
                success: true,
                data: existingPayment,
                message
            });
        }

        let transactionReference1 = `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log(`Generated transaction reference: ${transactionReference1}`);

        // ===== CREATE NEW PAYMENT =====
        const payment = await Payment.create({
            user: userId,
            name,
            type,
            amount,
            targetOrgAmount: amount,
            expectedAmount: amount,
            paidAmount: 0,
            remainingAmount: amount,
            totalPaidSoFar: 0,
            isPartial: false,
            description: description || `${name} payment`,
            paymentTypeId: paymentTypeId || null,
            organizationId,
            status: 'pending',
            transactionReference: transactionReference1,
            // NEW: Period fields
            periodStart: finalPeriodStart,
            periodEnd: finalPeriodEnd,
            periodKey: finalPeriodKey
        });

        // ✅ Force save if field is missing
        if (!payment.transactionReference) {
            console.log('⚠️ transactionReference missing, forcing update...');
            await Payment.findByIdAndUpdate(payment._id, {
                $set: { transactionReference: `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` }
            });
            // Re-fetch the payment
            const updated = await Payment.findById(payment._id);
            console.log(`✅ After force update: ${updated.transactionReference}`);
        }

        console.log(`✅ Payment created with reference: ${payment.transactionReference} type: ${payment.type} amount: ₦${payment.amount.toLocaleString()}`);

        res.status(201).json({
            success: true,
            data: payment,
            message: 'Payment created successfully'
        });
    } catch (error) {
        console.error('Member payment creation error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
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