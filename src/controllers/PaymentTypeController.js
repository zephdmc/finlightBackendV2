const PaymentType = require('../models/PaymentType');
const Payment = require('../models/Payment');
const User = require('../models/User');
const mongoose = require('mongoose');

/**
 * @desc    Get all payment types
 * @route   GET /api/payment-types
 * @access  Private
 */
exports.getAllPaymentTypes = async (req, res, next) => {
  try {
    const { isActive, frequency, is_mandatory, page = 1, limit = 10 } = req.query;
    
    let filter = {};
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (frequency) filter.frequency = frequency;
    if (is_mandatory !== undefined) filter.is_mandatory = is_mandatory === 'true';
    
    if (req.user.role !== 'admin') {
      filter.isActive = true;
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [paymentTypes, total] = await Promise.all([
      PaymentType.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      PaymentType.countDocuments(filter)
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        records: paymentTypes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all active payment types
 */
exports.getActivePaymentTypes = async (req, res, next) => {
  try {
    const paymentTypes = await PaymentType.find({ isActive: true })
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: paymentTypes.length,
      data: paymentTypes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get mandatory payment types
 */
exports.getMandatoryPaymentTypes = async (req, res, next) => {
  try {
    const paymentTypes = await PaymentType.find({ 
      is_mandatory: true,
      isActive: true 
    }).sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: paymentTypes.length,
      data: paymentTypes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get optional payment types
 */
exports.getOptionalPaymentTypes = async (req, res, next) => {
  try {
    const paymentTypes = await PaymentType.find({ 
      is_mandatory: false,
      isActive: true 
    }).sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: paymentTypes.length,
      data: paymentTypes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payment types by frequency
 */
exports.getPaymentTypesByFrequency = async (req, res, next) => {
  try {
    const { frequency } = req.params;
    const paymentTypes = await PaymentType.find({ 
      frequency,
      isActive: true 
    }).sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: paymentTypes.length,
      data: paymentTypes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payment type statistics
 */
exports.getPaymentTypeStats = async (req, res, next) => {
  try {
    const stats = await PaymentType.aggregate([
      {
        $group: {
          _id: null,
          totalTypes: { $sum: 1 },
          mandatoryTypes: { $sum: { $cond: ['$is_mandatory', 1, 0] } },
          optionalTypes: { $sum: { $cond: ['$is_mandatory', 0, 1] } },
          activeTypes: { $sum: { $cond: ['$isActive', 1, 0] } },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);
    
    res.status(200).json({
      success: true,
      data: stats[0] || {}
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payment type summary for dashboard
 */
exports.getPaymentTypeSummary = async (req, res, next) => {
  try {
    const summary = await PaymentType.aggregate([
      {
        $lookup: {
          from: 'payments',
          localField: '_id',
          foreignField: 'paymentTypeId',
          as: 'payments'
        }
      },
      {
        $project: {
          name: 1,
          type: 1,
          amount: 1,
          is_mandatory: 1,
          frequency: 1,
          totalPayments: { $size: '$payments' },
          paidPayments: {
            $size: {
              $filter: {
                input: '$payments',
                as: 'payment',
                cond: { $eq: ['$$payment.status', 'paid'] }
              }
            }
          },
          totalRevenue: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$payments',
                    as: 'payment',
                    cond: { $eq: ['$$payment.status', 'paid'] }
                  }
                },
                as: 'payment',
                in: '$$payment.amount'
              }
            }
          }
        }
      }
    ]);
    
    res.status(200).json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single payment type by ID
 */
exports.getPaymentType = async (req, res, next) => {
  try {
    const paymentType = await PaymentType.findById(req.params.id);
    
    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: paymentType
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payments by payment type
 */
exports.getPaymentsByType = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    
    const filter = { paymentTypeId: req.params.id };
    if (status) filter.status = status;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Payment.countDocuments(filter)
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        records: payments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get members with unpaid payments for a specific type
 */
exports.getUnpaidMembersByType = async (req, res, next) => {
  try {
    const unpaidPayments = await Payment.find({
      paymentTypeId: req.params.id,
      status: 'unpaid'
    }).populate('user', 'name email phone');
    
    const members = unpaidPayments.map(p => p.user).filter(Boolean);
    
    res.status(200).json({
      success: true,
      count: members.length,
      data: members
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create new payment type
 */
exports.createPaymentType = async (req, res, next) => {
  try {
    // Validate required fields
    if (!req.body.name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }
    
    if (!req.body.type) {
      return res.status(400).json({
        success: false,
        message: 'Payment type category is required'
      });
    }
    
    if (!req.body.amount || req.body.amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required'
      });
    }
    
    // Check if name already exists
    const existing = await PaymentType.findOne({ name: req.body.name });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Payment type with this name already exists'
      });
    }
    
    // Build payment type data
    const paymentTypeData = {
      name: req.body.name,
      type: req.body.type,
      description: req.body.description || '',
      amount: req.body.amount,
      is_mandatory: req.body.is_mandatory || false,
      frequency: req.body.frequency || 'one-time'
    };
    
    // Only add duration fields for recurring payments
    if (req.body.frequency && req.body.frequency !== 'one-time') {
      if (req.body.duration_value && req.body.duration_unit) {
        paymentTypeData.duration_value = req.body.duration_value;
        paymentTypeData.duration_unit = req.body.duration_unit;
      }
    }
    
    const paymentType = await PaymentType.create(paymentTypeData);
    
    res.status(201).json({
      success: true,
      data: paymentType,
      message: 'Payment type created successfully'
    });
  } catch (error) {
    console.error('Create payment type error:', error);
    next(error);
  }
};

/**
 * @desc    Create multiple payment types
 */
exports.createBulkPaymentTypes = async (req, res, next) => {
  try {
    const { paymentTypes } = req.body;
    const createdTypes = await PaymentType.insertMany(paymentTypes);
    
    res.status(201).json({
      success: true,
      count: createdTypes.length,
      data: createdTypes,
      message: `Created ${createdTypes.length} payment types successfully`
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Generate recurring payments from a payment type
 */
exports.generateRecurringPayments = async (req, res, next) => {
  try {
    const paymentType = await PaymentType.findById(req.params.id);
    
    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }
    
    const members = await User.find({ role: 'member' });
    const generatedPayments = [];
    
    for (const member of members) {
      const existingPayment = await Payment.findOne({
        user: member._id,
        paymentTypeId: paymentType._id,
        status: 'unpaid'
      });
      
      if (!existingPayment && paymentType.frequency !== 'one-time') {
        const payment = await Payment.create({
          user: member._id,
          name: paymentType.name,
          type: paymentType.type,
          amount: paymentType.amount,
          description: paymentType.description,
          paymentTypeId: paymentType._id,
          status: 'unpaid',
          dueDate: new Date()
        });
        generatedPayments.push(payment);
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Generated ${generatedPayments.length} payments`,
      data: generatedPayments
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update payment type
 */
exports.updatePaymentType = async (req, res, next) => {
  try {
    // Check if name already exists (excluding current record)
    if (req.body.name) {
      const existing = await PaymentType.findOne({ 
        name: req.body.name,
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Payment type with this name already exists'
        });
      }
    }
    
    const paymentType = await PaymentType.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: paymentType,
      message: 'Payment type updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Toggle payment type active status
 */
exports.togglePaymentTypeStatus = async (req, res, next) => {
  try {
    const paymentType = await PaymentType.findByIdAndUpdate(
      req.params.id,
      { isActive: req.body.isActive },
      { new: true }
    );
    
    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: paymentType,
      message: `Payment type ${req.body.isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete payment type
 */
exports.deletePaymentType = async (req, res, next) => {
  try {
    const paymentsCount = await Payment.countDocuments({ paymentTypeId: req.params.id });
    
    if (paymentsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete payment type. It has ${paymentsCount} associated payments.`
      });
    }
    
    const paymentType = await PaymentType.findByIdAndDelete(req.params.id);
    
    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Payment type deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payment type usage report
 */
exports.getPaymentTypeReport = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    let dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }
    
    const report = await Payment.aggregate([
      {
        $match: {
          paymentTypeId: new mongoose.Types.ObjectId(req.params.id),
          ...dateFilter
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);
    
    const totalPayments = report.reduce((sum, item) => sum + item.count, 0);
    const totalRevenue = report
      .filter(item => item._id === 'paid')
      .reduce((sum, item) => sum + item.totalAmount, 0);
    
    res.status(200).json({
      success: true,
      data: {
        paymentTypeId: req.params.id,
        totalPayments,
        totalRevenue,
        breakdown: report,
        dateRange: { startDate, endDate }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Export payment types to CSV
 */
exports.exportPaymentTypes = async (req, res, next) => {
  try {
    const paymentTypes = await PaymentType.find({});
    
    const csvHeaders = ['Name', 'Type', 'Description', 'Amount', 'Mandatory', 'Frequency', 'Status', 'Created At'];
    const csvRows = paymentTypes.map(pt => [
      pt.name,
      pt.type || 'dues',
      pt.description || '',
      pt.amount,
      pt.is_mandatory ? 'Yes' : 'No',
      pt.frequency,
      pt.isActive ? 'Active' : 'Inactive',
      new Date(pt.createdAt).toLocaleDateString()
    ]);
    
    const csvContent = [csvHeaders, ...csvRows]
      .map(row => row.join(','))
      .join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=payment-types-${Date.now()}.csv`);
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
};