// backend/src/controllers/paymentController.js
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const PaymentType = require('../models/PaymentType');
const crypto = require('crypto');

// Helper function for partial payments (now includes organizationId on outstanding payment)
const handlePartialPayment = async (originalPayment, amountPaid, reference) => {
  const expectedAmount = originalPayment.expectedAmount || originalPayment.amount;
  const remainingAmount = expectedAmount - amountPaid;
  
  console.log(`Partial payment detected: Expected ${expectedAmount}, Paid ${amountPaid}, Remaining ${remainingAmount}`);
  
  // Update original payment as partial
  originalPayment.paidAmount = amountPaid;
  originalPayment.remainingAmount = remainingAmount;
  originalPayment.isPartial = true;
  originalPayment.status = 'partial';
  originalPayment.paidAt = new Date();
  originalPayment.transactionReference = reference;
  await originalPayment.save();
  
  // Create outstanding payment record for remaining amount (include organizationId)
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
  
  console.log(`Created outstanding payment record: ${outstandingPayment._id} for amount ${remainingAmount}`);
  
  return {
    isPartial: true,
    paidAmount: amountPaid,
    remainingAmount: remainingAmount,
    outstandingPayment: outstandingPayment
  };
};

// @desc    Create direct payment (Admin only - no Paystack)
// @route   POST /api/payments/admin-direct
// @access  Private/Admin
exports.createAdminDirectPayment = async (req, res, next) => {
  try {
    const { userId, type, amount, dueDate, description, paymentTypeId, paidAt } = req.body;
    const organizationId = req.user.organizationId;

    console.log('Admin direct payment request:', req.body);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Verify that the target user belongs to the same organization
    const targetUser = await User.findOne({ _id: userId, organizationId: organizationId });
    if (!targetUser) {
      return res.status(403).json({
        success: false,
        message: 'User not found in your organization'
      });
    }

    if (!type) {
      return res.status(400).json({
        success: false,
        message: 'Payment type is required'
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required'
      });
    }

    // Check for existing paid payment of same type (scoped to organization)
    const existingPayment = await Payment.findOne({
      user: userId,
      paymentTypeId: paymentTypeId,
      status: 'paid',
      organizationId: organizationId
    });

    if (existingPayment) {
      return res.status(400).json({
        success: false,
        message: `Payment already exists for this member. ${type} payment has already been made.`,
        data: {
          existingPayment: {
            id: existingPayment._id,
            type: existingPayment.type,
            amount: existingPayment.amount,
            paidAt: existingPayment.paidAt,
            transactionReference: existingPayment.transactionReference
          }
        }
      });
    }

    const payment = await Payment.create({
      user: userId,
      type: type,
      amount: amount,
      dueDate: dueDate || null,
      description: description || `${type} payment recorded by admin`,
      paymentTypeId: paymentTypeId || null,
      organizationId: organizationId,
      status: 'paid',
      paidAt: paidAt || new Date(),
      transactionReference: `ADMIN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });

    await payment.populate('user', 'name email');

    if (type === 'registration') {
      await User.findByIdAndUpdate(userId, { hasPaidRegistration: true });
    }

    // Record as income with organizationId
    try {
      const incomeData = {
        amount: payment.amount,
        source: `${type} - ${description || 'Payment'}`,
        date: payment.paidAt || new Date(),
        description: description || `${type} payment recorded by admin`,
        paymentId: payment._id,
        paymentType: type,
        userId: userId,
        organizationId: organizationId,
        transactionReference: payment.transactionReference
      };
      await Income.create(incomeData);
      console.log('Income recorded for admin payment:', payment._id);
    } catch (incomeError) {
      console.error('Failed to record income:', incomeError);
    }

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

// @desc    Get outstanding payments (scoped to user + organization)
// @route   GET /api/payments/outstanding
// @access  Private
exports.getOutstandingPayments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const organizationId = req.user.organizationId;

    const outstandingPayments = await Payment.find({
      user: userId,
      organizationId: organizationId,
      status: 'unpaid',
      name: { $regex: 'Outstanding Balance', $options: 'i' }
    }).populate('paymentTypeId', 'name description');

    const regularUnpaid = await Payment.find({
      user: userId,
      organizationId: organizationId,
      status: 'unpaid',
      name: { $not: { $regex: 'Outstanding Balance', $options: 'i' } }
    }).populate('paymentTypeId', 'name description');

    const allOutstanding = [...regularUnpaid, ...outstandingPayments];

    res.status(200).json({
      success: true,
      data: allOutstanding,
      summary: {
        totalOutstanding: allOutstanding.reduce((sum, p) => sum + p.amount, 0),
        count: allOutstanding.length
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark a fine as paid (Admin) – with tenant isolation
// @route   PUT /api/payments/:id/mark-paid
// @access  Private/Admin
exports.markFineAsPaid = async (req, res, next) => {
  try {
    const { paidAt } = req.body;
    const organizationId = req.user.organizationId;

    console.log('=== MARK FINE AS PAID ===');
    console.log('Fine ID:', req.params.id);

    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: organizationId
    }).populate('user', 'name email');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.type !== 'fine') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for fines'
      });
    }

    if (payment.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Fine already paid'
      });
    }

    payment.status = 'paid';
    payment.paidAt = paidAt || new Date();
    await payment.save();

    try {
      const incomeData = {
        amount: payment.amount,
        source: `Fine - ${payment.description || 'Penalty'}`,
        date: payment.paidAt,
        description: payment.description || `Fine payment from ${payment.user?.name}`,
        paymentId: payment._id,
        paymentType: 'fine',
        userId: payment.user,
        organizationId: organizationId,
        transactionReference: payment.transactionReference
      };
      await Income.create(incomeData);
      console.log('Income recorded for fine payment:', payment._id);
    } catch (incomeError) {
      console.error('Failed to record income for fine:', incomeError);
    }

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

// @desc    Create payment (Admin) – with organizationId
// @route   POST /api/payments
// @access  Private/Admin
exports.createPayment = async (req, res, next) => {
  try {
    const { userId, name, type, amount, dueDate, description, paymentTypeId } = req.body;
    const organizationId = req.user.organizationId;

    console.log('Create payment request:', { userId, name, type, amount, dueDate, description, paymentTypeId, organizationId });

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Payment name is required'
      });
    }

    if (!type) {
      return res.status(400).json({
        success: false,
        message: 'Payment type is required'
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required'
      });
    }

    const targetUser = await User.findOne({ _id: userId, organizationId: organizationId });
    if (!targetUser) {
      return res.status(403).json({
        success: false,
        message: 'User not found in your organization'
      });
    }

    const payment = await Payment.create({
      user: userId,
      name: name,
      type: type,
      amount: amount,
      dueDate: dueDate || null,
      description: description || '',
      paymentTypeId: paymentTypeId || null,
      organizationId: organizationId,
      status: 'unpaid'
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

// @desc    Get public payment summary for members
// @route   GET /api/payments/public/summary
// @access  Private
exports.getPublicSummary = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    
    let matchCondition = { status: 'paid' };
    if (organizationId && req.user.role !== 'super-admin' && req.user.role !== 'super_admin') {
      matchCondition.organizationId = organizationId;
    }
    
    const [totalPaidResult, totalOutstandingResult, paymentCounts, monthlyPayments] = await Promise.all([
      Payment.aggregate([
        { $match: matchCondition },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { ...matchCondition, status: 'unpaid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: matchCondition },
        { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$amount' } } }
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
            total: { $sum: '$amount' },
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
        paymentCounts: paymentCounts,
        monthlyTrend: monthlyPayments,
        lastUpdated: new Date()
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payment by ID
// @route   GET /api/payments/:id
// @access  Private
exports.getPaymentById = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId
    })
      .populate('user', 'name email')
      .populate('paymentTypeId', 'name description');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this payment'
      });
    }

    const safePayment = {
      _id: payment._id,
      user: payment.user,
      type: payment.type,
      amount: payment.amount,
      status: payment.status,
      dueDate: payment.dueDate,
      paidAt: payment.paidAt,
      description: payment.description,
      transactionReference: payment.transactionReference,
      paymentTypeId: payment.paymentTypeId,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt
    };

    res.status(200).json({
      success: true,
      data: safePayment
    });
  } catch (error) {
    console.error('Get payment by ID error:', error);
    next(error);
  }
};

// @desc    Get all paid payments as income records
// @route   GET /api/payments/public/income
// @access  Private
exports.getPublicIncome = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const userRole = req.user.role;
    
    let query = { status: 'paid' };
    
    if (userRole !== 'super-admin' && userRole !== 'super_admin') {
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this user'
        });
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
      source = source.split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(' ');
      
      let description = payment.description || '';
      if (!description) {
        description = `${source} payment from ${payment.user?.name || 'Member'}`;
      }
      
      return {
        _id: payment._id,
        amount: payment.amount,
        description: description,
        source: source,
        date: payment.paidAt || payment.createdAt,
        type: 'member_payment',
        memberName: payment.user?.name || 'Member',
        paymentType: source
      };
    });
    
    const totalCollected = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    
    res.status(200).json({
      success: true,
      data: {
        records: incomeRecords,
        summary: {
          totalCollected,
          totalCount: payments.length,
          lastUpdated: new Date()
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payment summary for reporting
// @route   GET /api/payments/summary
// @access  Private/Admin
exports.getPaymentSummary = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    const { startDate, endDate, type } = req.query;
    
    let matchCondition = { organizationId: organizationId };
    
    if (startDate && endDate) {
      matchCondition.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    if (type) {
      matchCondition.type = type;
    }
    
    const [summary, byType, byStatus] = await Promise.all([
      Payment.aggregate([
        { $match: matchCondition },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$amount' },
            totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
            totalUnpaid: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, '$amount', 0] } },
            count: { $sum: 1 },
            paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            unpaidCount: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, 1, 0] } }
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
      ])
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        summary: summary[0] || { totalAmount: 0, totalPaid: 0, totalUnpaid: 0, count: 0, paidCount: 0, unpaidCount: 0 },
        byType: byType,
        byStatus: byStatus
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user payments (scoped to current user + organization)
// @route   GET /api/payments
// @access  Private
exports.getUserPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find({
      user: req.user.id,
      organizationId: req.user.organizationId
    })
      .populate('user', 'name email')
      .populate('paymentTypeId', 'name description')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: payments
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all payments for the admin's organization
// @route   GET /api/payments/all
// @access  Private/Admin
exports.getAllPayments = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;
    
    console.log('Getting all payments for organization:', organizationId);
    console.log('User role:', req.user.role);
    
    if (!organizationId && req.user.role !== 'super-admin') {
      return res.status(400).json({
        success: false,
        message: 'Organization ID not found for this user'
      });
    }
    
    let query = {};
    
    if (req.user.role === 'super-admin' || req.user.role === 'super_admin') {
      console.log('Super admin - fetching all payments');
    } else {
      query.organizationId = organizationId;
      console.log('Admin - filtering by organization:', organizationId);
    }
    
    const { status, type, userId, startDate, endDate, page = 1, limit = 20 } = req.query;
    
    if (status) query.status = status;
    if (type) query.type = type;
    if (userId) query.user = userId;
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [payments, total] = await Promise.all([
      Payment.find(query)
        .populate('user', 'name email')
        .populate('paymentTypeId', 'name description')
        .sort({ createdAt: -1 })
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
          count: { $sum: 1 }
        }
      }
    ]);
    
    const paidTotal = totals.find(t => t._id === 'paid')?.total || 0;
    const unpaidTotal = totals.find(t => t._id === 'unpaid')?.total || 0;
    
    res.status(200).json({
      success: true,
      data: {
        records: payments,
        summary: {
          totalPaid: paidTotal,
          totalUnpaid: unpaidTotal,
          totalPayments: paidTotal + unpaidTotal,
          count: total,
          totalAmount: payments.reduce((sum, p) => sum + (p.amount || 0), 0)
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

// @desc    Get single payment (with tenant check)
// @route   GET /api/payments/:id
// @access  Private
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId
    })
      .populate('user', 'name email phone')
      .populate('paymentTypeId', 'name description amount');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this payment'
      });
    }

    res.status(200).json({
      success: true,
      data: payment
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update payment (Admin, scoped to organization)
// @route   PUT /api/payments/:id
// @access  Private/Admin
exports.updatePayment = async (req, res, next) => {
  try {
    const { amount, dueDate, description, status, paidAt } = req.body;
    const organizationId = req.user.organizationId;

    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: organizationId
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (status) payment.status = status;
    if (paidAt) payment.paidAt = paidAt;
    if (amount) payment.amount = amount;
    if (dueDate) payment.dueDate = dueDate;
    if (description) payment.description = description;

    await payment.save();

    res.status(200).json({
      success: true,
      data: payment,
      message: 'Payment updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete payment (Admin) – only if unpaid
// @route   DELETE /api/payments/:id
// @access  Private/Admin
exports.deletePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a paid payment'
      });
    }

    await payment.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Payment deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get pending payments for a member (based on payment types in the same organization)
// @route   GET /api/payments/pending
// @access  Private
exports.getPendingPayments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const organizationId = req.user.organizationId;

    const paymentTypes = await PaymentType.find({ isActive: true, organizationId: organizationId });

    const existingPayments = await Payment.find({
      user: userId,
      organizationId: organizationId,
      status: 'paid'
    });

    const paidTypeIds = existingPayments.map(p => p.paymentTypeId?.toString()).filter(Boolean);

    const pendingPaymentTypes = paymentTypes.filter(
      type => !paidTypeIds.includes(type._id.toString())
    );

    const pendingPayments = pendingPaymentTypes.map(type => ({
      _id: type._id,
      name: type.name,
      description: type.description,
      amount: type.amount,
      type: type.type,
      isMandatory: type.isMandatory,
      status: 'pending'
    }));

    res.status(200).json({
      success: true,
      data: {
        records: pendingPayments,
        total: pendingPayments.length
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payment statistics for the admin's organization
// @route   GET /api/payments/stats
// @access  Private/Admin
exports.getPaymentStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const organizationId = req.user.organizationId;

    let dateFilter = { organizationId: organizationId };
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const [stats, paymentsByType, recentPayments] = await Promise.all([
      Payment.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: null,
            totalPayments: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            unpaidCount: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, 1, 0] } },
            paidAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
            unpaidAmount: { $sum: { $cond: [{ $eq: ['$status', 'unpaid'] }, '$amount', 0] } }
          }
        }
      ]),
      Payment.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
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

// @desc    Create payment for member (no admin required, for Paystack flow) – with tenant
// @route   POST /api/payments/member-payment
// @access  Private
exports.createMemberPayment = async (req, res, next) => {
  try {
    const { name, type, amount, description, paymentTypeId } = req.body;
    const userId = req.user.id;
    const organizationId = req.user.organizationId;

    if (!name || !type || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const existingOutstanding = await Payment.findOne({
      user: userId,
      paymentTypeId: paymentTypeId,
      organizationId: organizationId,
      status: 'unpaid',
      name: { $regex: 'Outstanding Balance', $options: 'i' }
    });

    if (existingOutstanding) {
      return res.status(200).json({
        success: true,
        data: existingOutstanding,
        message: 'Existing outstanding balance found. Please pay the remaining amount.'
      });
    }

    const payment = await Payment.create({
      user: userId,
      name: name,
      type: type,
      amount: amount,
      expectedAmount: amount,
      paidAmount: 0,
      remainingAmount: amount,
      isPartial: false,
      description: description || `${name} payment`,
      paymentTypeId: paymentTypeId || null,
      organizationId: organizationId,
      status: 'pending',
      transactionReference: `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });

    res.status(201).json({
      success: true,
      data: payment,
      message: 'Payment created successfully'
    });
  } catch (error) {
    console.error('Member payment creation error:', error);
    next(error);
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
        const user = await User.findOne({ 
          _id: payment.userId, 
          organizationId: organizationId 
        });
        
        if (!user) {
          failed.push({ ...payment, error: 'User not found in organization' });
          continue;
        }
        
        const existingPayment = await Payment.findOne({
          user: payment.userId,
          type: payment.type,
          status: 'paid',
          organizationId: organizationId
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
          dueDate: payment.dueDate || null,
          description: payment.description || `${payment.type} payment`,
          organizationId: organizationId,
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
      data: {
        successful,
        failed,
        total: payments.length,
        successCount: successful.length,
        failedCount: failed.length
      },
      message: `Processed ${successful.length} successful, ${failed.length} failed`
    });
  } catch (error) {
    console.error('Bulk payment error:', error);
    next(error);
  }
};
