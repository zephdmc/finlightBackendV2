// backend/src/controllers/paymentTypeController.js
const PaymentType = require('../models/PaymentType');
const Payment = require('../models/Payment');
const User = require('../models/User');
const mongoose = require('mongoose');
const { notifyOrganization } = require('../services/notificationService');
const { sendPaymentTypeNotificationEmail } = require('../services/emailService');

/**
 * Helper: Get organizationId from authenticated user
 * All queries will be scoped to this organization
 */
const getOrgId = (req) => req.user.organizationId;

/**
 * Helper: Send payment type notification to all members
 */
const sendPaymentTypeNotifications = async (paymentType, organizationId, organizationName, isUpdate = false) => {
  try {
    const members = await User.find(
      {
        organizationId,
        role: 'member',
        isActive: true,
        email: { $ne: null, $regex: /\S+@\S+\.\S+/, $ne: '' }
      },
      { name: 1, email: 1 }
    );

    if (members.length === 0) {
      console.log('⚠️ No active members with valid emails found');
      return { total: 0, sent: 0, failed: 0 };
    }

    console.log(`📧 Sending ${isUpdate ? 'update' : 'new'} payment type notifications to ${members.length} members`);

    let sent = 0;
    let failed = 0;

    for (const member of members) {
      try {
        const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
        const paymentsUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/member/payments`;

        await sendPaymentTypeNotificationEmail(
          member.email,
          member.name,
          paymentType,
          organizationName,
          loginUrl,
          paymentsUrl,
          isUpdate
        );

        sent++;
        console.log(`✅ Email sent to ${member.email} (${sent}/${members.length})`);

        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (emailError) {
        failed++;
        console.error(`❌ Failed to send email to ${member.email}:`, emailError.message);
      }
    }

    console.log(`📧 Payment type notifications completed: ${sent} sent, ${failed} failed`);
    return { total: members.length, sent, failed };

  } catch (error) {
    console.error('❌ Error sending payment type notifications:', error);
    return { total: 0, sent: 0, failed: 0, error: error.message };
  }
};

/**
 * @desc    Get all payment types (scoped to organization)
 * @route   GET /api/payment-types
 * @access  Private
 */
exports.getAllPaymentTypes = async (req, res, next) => {
  try {
    const { isActive, frequency, is_mandatory, page = 1, limit = 10 } = req.query;
    const organizationId = getOrgId(req);

    let filter = { organizationId };
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
 * @desc    Get all active payment types (scoped)
 */
exports.getActivePaymentTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentTypes = await PaymentType.find({ organizationId, isActive: true })
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
 * @desc    Get mandatory payment types (scoped)
 */
exports.getMandatoryPaymentTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentTypes = await PaymentType.find({
      organizationId,
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
 * @desc    Get optional payment types (scoped)
 */
exports.getOptionalPaymentTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentTypes = await PaymentType.find({
      organizationId,
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
 * @desc    Get payment types by frequency (scoped)
 */
exports.getPaymentTypesByFrequency = async (req, res, next) => {
  try {
    const { frequency } = req.params;
    const organizationId = getOrgId(req);
    const paymentTypes = await PaymentType.find({
      organizationId,
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
 * @desc    Get payment type statistics (scoped)
 */
exports.getPaymentTypeStats = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const stats = await PaymentType.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
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
 * @desc    Get payment type summary for dashboard (scoped)
 */
exports.getPaymentTypeSummary = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const summary = await PaymentType.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
      {
        $lookup: {
          from: 'payments',
          let: { typeId: '$_id', orgId: organizationId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$paymentTypeId', '$$typeId'] },
                    { $eq: ['$organizationId', new mongoose.Types.ObjectId(organizationId)] }
                  ]
                }
              }
            }
          ],
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
 * @desc    Get single payment type by ID (scoped)
 */
exports.getPaymentType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentType = await PaymentType.findOne({
      _id: req.params.id,
      organizationId
    });

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
 * @desc    Get payments by payment type (scoped to organization)
 */
exports.getPaymentsByType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const { page = 1, limit = 10, status } = req.query;

    const filter = {
      paymentTypeId: req.params.id,
      organizationId
    };
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
 * @desc    Get members with unpaid payments for a specific type (scoped)
 */
exports.getUnpaidMembersByType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const unpaidPayments = await Payment.find({
      paymentTypeId: req.params.id,
      organizationId,
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

// ============================================================
// UPDATED: Create payment type with ALL fields
// ============================================================
exports.createPaymentType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);

    console.log('📥 Received payment type data:', req.body);

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

    // Validate recurring payment fields
    const { frequency, duration_value, duration_unit } = req.body;
    if (frequency && frequency !== 'one-time') {
      if (!duration_value || !duration_unit) {
        return res.status(400).json({
          success: false,
          message: 'Duration value and unit are required for recurring payments'
        });
      }
    }

    // Check if name already exists within the same organization
    const existing = await PaymentType.findOne({
      name: req.body.name,
      organizationId
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Payment type with this name already exists in your organization'
      });
    }

    // ============================================================
    // FIX: Build payment type data with ALL fields
    // ============================================================
    const paymentTypeData = {
      name: req.body.name,
      type: req.body.type,
      description: req.body.description || '',
      amount: req.body.amount,
      is_mandatory: req.body.is_mandatory || false,
      frequency: req.body.frequency || 'one-time',
      organizationId,
      createdBy: req.user.id,
      // ============================================================
      // CRITICAL: Always include duration fields
      // ============================================================
      duration_value: req.body.duration_value !== undefined && req.body.duration_value !== null
        ? parseInt(req.body.duration_value)
        : null,
      duration_unit: req.body.duration_unit || null,
      // ============================================================
      // CRITICAL: Include late penalty fields
      // ============================================================
      late_penalty_enabled: req.body.late_penalty_enabled || false,
      late_penalty_type: req.body.late_penalty_type || 'fixed',
      late_penalty_value: req.body.late_penalty_enabled
        ? parseFloat(req.body.late_penalty_value) || null
        : null,
      late_penalty_days_after: req.body.late_penalty_enabled
        ? parseInt(req.body.late_penalty_days_after) || 7
        : 7,
      due_date_after: parseInt(req.body.due_date_after) || 30,
    };

    console.log('📤 Creating payment type with data:', paymentTypeData);

    const paymentType = await PaymentType.create(paymentTypeData);

    console.log('✅ Payment type created:', paymentType);

    // Get organization name for notifications
    const Organization = require('../models/Organization');
    const organization = await Organization.findById(organizationId);
    const organizationName = organization ? organization.name : 'your organization';

    // Send email notifications to all members in the background
    sendPaymentTypeNotifications(paymentType, organizationId, organizationName, false)
      .then(result => {
        console.log(`✅ Payment type email notifications completed: ${result.sent}/${result.total} sent`);
      })
      .catch(error => {
        console.error('❌ Background email notification failed:', error);
      });

    // Send organization notification
    await notifyOrganization({
      organizationId,
      title: 'New Payment Created 🔔',
      message: `${paymentType.name} - ₦${paymentType.amount} has been created.`,
      type: 'payment',
      metadata: {
        paymentTypeId: paymentType._id
      }
    });

    res.status(201).json({
      success: true,
      data: {
        paymentType
      },
      message: `Payment type "${paymentType.name}" created successfully.`
    });

  } catch (error) {
    console.error('❌ Create payment type error:', error);
    next(error);
  }
};

/**
 * @desc    Create multiple payment types (bulk, scoped to organization)
 */
exports.createBulkPaymentTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const { paymentTypes } = req.body;

    const typesWithOrg = paymentTypes.map(pt => ({
      ...pt,
      organizationId
    }));

    const createdTypes = await PaymentType.insertMany(typesWithOrg);

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
 * @desc    Generate recurring payments from a payment type (scoped)
 * @route   POST /api/payment-types/:id/generate
 * @access  Private/Admin
 */
exports.generateRecurringPayments = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentType = await PaymentType.findOne({
      _id: req.params.id,
      organizationId
    });

    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }

    if (paymentType.frequency === 'one-time') {
      return res.status(400).json({
        success: false,
        message: 'This payment type is not recurring'
      });
    }

    const recurringBillingService = require('../services/recurringBillingService');

    const referenceDate = new Date();
    const period = paymentType.getPeriodForDate(referenceDate);
    const periodKey = paymentType.getPeriodKey(referenceDate);

    const results = await recurringBillingService.generateOrganizationPayments(
      organizationId,
      referenceDate
    );

    res.status(200).json({
      success: true,
      data: {
        paymentType: {
          id: paymentType._id,
          name: paymentType.name,
          frequency: paymentType.frequency
        },
        period: {
          periodKey,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd
        },
        results
      },
      message: `Generated ${results.created} payments for ${paymentType.name}`
    });
  } catch (error) {
    console.error('Generate recurring payments error:', error);
    next(error);
  }
};

/**
 * @desc    Update payment type (scoped)
 */
exports.updatePaymentType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);

    console.log('📥 Updating payment type:', req.body);

    const { frequency, duration_value, duration_unit } = req.body;
    if (frequency && frequency !== 'one-time') {
      if (!duration_value || !duration_unit) {
        return res.status(400).json({
          success: false,
          message: 'Duration value and unit are required for recurring payments'
        });
      }
    }

    if (req.body.name) {
      const existing = await PaymentType.findOne({
        name: req.body.name,
        organizationId,
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Payment type with this name already exists in your organization'
        });
      }
    }

    // ============================================================
    // FIX: Build update data with ALL fields
    // ============================================================
    const updateData = {
      name: req.body.name,
      type: req.body.type,
      description: req.body.description || '',
      amount: req.body.amount,
      is_mandatory: req.body.is_mandatory || false,
      frequency: req.body.frequency || 'one-time',
      updatedBy: req.user.id,
      // ============================================================
      // CRITICAL: Always include duration fields
      // ============================================================
      duration_value: req.body.duration_value !== undefined && req.body.duration_value !== null
        ? parseInt(req.body.duration_value)
        : null,
      duration_unit: req.body.duration_unit || null,
      // ============================================================
      // CRITICAL: Include late penalty fields
      // ============================================================
      late_penalty_enabled: req.body.late_penalty_enabled || false,
      late_penalty_type: req.body.late_penalty_type || 'fixed',
      late_penalty_value: req.body.late_penalty_enabled
        ? parseFloat(req.body.late_penalty_value) || null
        : null,
      late_penalty_days_after: req.body.late_penalty_enabled
        ? parseInt(req.body.late_penalty_days_after) || 7
        : 7,
      due_date_after: parseInt(req.body.due_date_after) || 30,
      isActive: req.body.isActive !== undefined ? req.body.isActive : true,
    };

    console.log('📤 Updating payment type with data:', updateData);

    const paymentType = await PaymentType.findOneAndUpdate(
      { _id: req.params.id, organizationId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }

    const Organization = require('../models/Organization');
    const organization = await Organization.findById(organizationId);
    const organizationName = organization ? organization.name : 'your organization';

    sendPaymentTypeNotifications(paymentType, organizationId, organizationName, true)
      .catch(error => console.error('Failed to send update notifications:', error));

    await notifyOrganization({
      organizationId,
      title: 'New Payment Updated 🔔',
      message: `${paymentType.name} - ₦${paymentType.amount} has been Updated.`,
      type: 'payment',
      metadata: {
        paymentTypeId: paymentType._id
      }
    });

    res.status(200).json({
      success: true,
      data: paymentType,
      message: 'Payment type updated successfully'
    });
  } catch (error) {
    console.error('❌ Update payment type error:', error);
    next(error);
  }
};

/**
 * @desc    Toggle payment type active status (scoped)
 */
exports.togglePaymentTypeStatus = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentType = await PaymentType.findOneAndUpdate(
      { _id: req.params.id, organizationId },
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
 * @desc    Delete payment type (scoped) – only if no associated payments
 */
exports.deletePaymentType = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentsCount = await Payment.countDocuments({
      paymentTypeId: req.params.id,
      organizationId
    });

    if (paymentsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete payment type. It has ${paymentsCount} associated payments in your organization.`
      });
    }

    const paymentType = await PaymentType.findOneAndDelete({
      _id: req.params.id,
      organizationId
    });

    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }

    await notifyOrganization({
      organizationId,
      title: 'Payment Deleted 🔔',
      message: `${paymentType.name} - ₦${paymentType.amount} has been Deleted.`,
      type: 'payment',
      metadata: {
        paymentTypeId: paymentType._id
      }
    });

    res.status(200).json({
      success: true,
      message: 'Payment type deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get payment type usage report (scoped)
 */
exports.getPaymentTypeReport = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
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
          organizationId: new mongoose.Types.ObjectId(organizationId),
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
 * @desc    Export payment types to CSV (scoped)
 */
exports.exportPaymentTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paymentTypes = await PaymentType.find({ organizationId });

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
    res.setHeader('Content-Disposition', `attachment; filename=payment-types-${organizationId}-${Date.now()}.csv`);
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
};

// ============================================================
// NEW: RECURRING BILLING ENDPOINTS
// ============================================================

/**
 * @desc    Get active recurring payment types (for billing scheduler)
 * @route   GET /api/payment-types/recurring
 * @access  Private/Admin
 */
exports.getRecurringTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const { mandatory } = req.query;

    let query = {
      organizationId,
      isActive: true,
      frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] },
      type: { $in: ['dues', 'monthly_dues'] }
    };

    if (mandatory === 'true') {
      query.is_mandatory = true;
    }

    const types = await PaymentType.find(query).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: types,
      count: types.length
    });
  } catch (error) {
    console.error('Get recurring types error:', error);
    next(error);
  }
};

/**
 * @desc    Get mandatory payment types that auto-generate
 * @route   GET /api/payment-types/auto-generate
 * @access  Private/Admin
 */
exports.getAutoGenerateTypes = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);

    const types = await PaymentType.find({
      organizationId,
      isActive: true,
      is_mandatory: true,
      frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] },
      type: { $in: ['dues', 'monthly_dues'] }
    });

    res.status(200).json({
      success: true,
      data: types,
      count: types.length,
      message: types.length === 0 ? 'No auto-generate dues types found' : undefined
    });
  } catch (error) {
    console.error('Get auto-generate types error:', error);
    next(error);
  }
};

/**
 * @desc    Calculate next due date for a payment type
 * @route   GET /api/payment-types/:id/next-due
 * @access  Private/Admin
 */
exports.calculateNextDueDate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromDate } = req.query;
    const organizationId = getOrgId(req);

    const paymentType = await PaymentType.findOne({
      _id: id,
      organizationId
    });

    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }

    const startDate = fromDate ? new Date(fromDate) : new Date();
    const nextDueDate = paymentType.calculateNextDueDate(startDate);

    const period = paymentType.getPeriodForDate(startDate);
    const periodKey = paymentType.getPeriodKey(startDate);

    res.status(200).json({
      success: true,
      data: {
        paymentType: {
          id: paymentType._id,
          name: paymentType.name,
          frequency: paymentType.frequency,
          duration_value: paymentType.duration_value,
          duration_unit: paymentType.duration_unit
        },
        startDate,
        nextDueDate,
        currentPeriod: period,
        currentPeriodKey: periodKey,
        isRecurring: paymentType.isRecurring()
      }
    });
  } catch (error) {
    console.error('Calculate next due date error:', error);
    next(error);
  }
};

/**
 * @desc    Get period info for a payment type
 * @route   GET /api/payment-types/:id/period-info
 * @access  Private/Admin
 */
exports.getPeriodInfo = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    const organizationId = getOrgId(req);

    const paymentType = await PaymentType.findOne({
      _id: id,
      organizationId
    });

    if (!paymentType) {
      return res.status(404).json({
        success: false,
        message: 'Payment type not found'
      });
    }

    const referenceDate = date ? new Date(date) : new Date();
    const period = paymentType.getPeriodForDate(referenceDate);
    const periodKey = paymentType.getPeriodKey(referenceDate);

    const availablePeriods = [];
    if (paymentType.isRecurring()) {
      for (let i = 0; i < 12; i++) {
        const d = new Date(referenceDate);
        d.setMonth(d.getMonth() - i);
        const p = paymentType.getPeriodForDate(d);
        const key = paymentType.getPeriodKey(d);
        availablePeriods.push({
          periodKey: key,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          periodLabel: p.periodLabel
        });
      }
    }

    res.status(200).json({
      success: true,
      data: {
        paymentType: {
          id: paymentType._id,
          name: paymentType.name,
          frequency: paymentType.frequency,
          isRecurring: paymentType.isRecurring()
        },
        referenceDate,
        currentPeriod: period,
        currentPeriodKey: periodKey,
        availablePeriods: availablePeriods.slice(0, 12),
        scheduleText: paymentType.scheduleText
      }
    });
  } catch (error) {
    console.error('Get period info error:', error);
    next(error);
  }
};

/**
 * @desc    Get payment type statistics (enhanced with recurring info)
 * @route   GET /api/payment-types/stats
 * @access  Private/Admin
 */
exports.getPaymentTypeStats = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);

    const [total, active, mandatory, recurring, autoGenerate] = await Promise.all([
      PaymentType.countDocuments({ organizationId }),
      PaymentType.countDocuments({ organizationId, isActive: true }),
      PaymentType.countDocuments({ organizationId, is_mandatory: true }),
      PaymentType.countDocuments({
        organizationId,
        isActive: true,
        frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] }
      }),
      PaymentType.countDocuments({
        organizationId,
        isActive: true,
        is_mandatory: true,
        frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] }
      })
    ]);

    const byFrequency = await PaymentType.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
      { $group: { _id: '$frequency', count: { $sum: 1 } } }
    ]);

    const byType = await PaymentType.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    const amountStats = await PaymentType.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          avgAmount: { $avg: '$amount' },
          minAmount: { $min: '$amount' },
          maxAmount: { $max: '$amount' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        summary: {
          total,
          active,
          inactive: total - active,
          mandatory,
          optional: total - mandatory,
          recurring,
          autoGenerate,
          oneTime: total - recurring
        },
        byFrequency,
        byType,
        amountStats: amountStats[0] || {}
      }
    });
  } catch (error) {
    console.error('Get payment type stats error:', error);
    next(error);
  }
};