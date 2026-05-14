// backend/src/services/PaymentService.js
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const PaymentType = require('../models/PaymentType');
const paystackService = require('./paystackService'); // updated multi‑tenant service
const mongoose = require('mongoose');

/**
 * Payment Service
 * Handles all payment-related business logic
 * Manages payment creation, verification, and reconciliation
 * Now fully multi‑tenant: all operations require organizationId.
 */
class PaymentService {
  /**
   * Create a new payment record
   * @param {Object} paymentData - { userId, type, amount, dueDate, description, createdBy, organizationId }
   * @returns {Promise<Object>} - Created payment
   */
  async createPayment(paymentData) {
    const { userId, type, amount, dueDate, description, createdBy, organizationId } = paymentData;

    if (!organizationId) {
      const error = new Error('Organization ID is required');
      error.statusCode = 400;
      throw error;
    }

    const validTypes = ['registration', 'dues', 'fine'];
    if (!validTypes.includes(type)) {
      const error = new Error('Invalid payment type');
      error.statusCode = 400;
      throw error;
    }

    if (amount <= 0) {
      const error = new Error('Amount must be greater than 0');
      error.statusCode = 400;
      throw error;
    }

    const user = await User.findOne({ _id: userId, organizationId });
    if (!user) {
      const error = new Error('User not found in this organization');
      error.statusCode = 404;
      throw error;
    }

    if (type === 'registration') {
      const existingRegistration = await Payment.findOne({
        user: userId,
        type: 'registration',
        organizationId
      });
      if (existingRegistration) {
        const error = new Error('Registration payment already exists for this user');
        error.statusCode = 400;
        throw error;
      }
    }

    const payment = await Payment.create({
      user: userId,
      type,
      amount,
      dueDate: dueDate || null,
      description,
      status: 'unpaid',
      createdBy: createdBy || userId,
      organizationId
    });

    return payment;
  }

  /**
   * Initialize payment with Paystack (dynamic subaccount per organization)
   * @param {string} paymentId - Payment ID
   * @param {string} userId - User ID
   * @param {string} organizationId - Organization ID (from JWT)
   * @returns {Promise<Object>} - Payment initialization data
   */
  async initializePayment(paymentId, userId, organizationId) {
    const payment = await Payment.findOne({
      _id: paymentId,
      organizationId
    }).populate('user', 'name email');

    if (!payment) {
      const error = new Error('Payment not found');
      error.statusCode = 404;
      throw error;
    }

    // Verify ownership/role
    if (payment.user._id.toString() !== userId) {
      const user = await User.findById(userId);
      if (!user || user.role !== 'admin') {
        const error = new Error('Unauthorized to make this payment');
        error.statusCode = 403;
        throw error;
      }
    }

    if (payment.status === 'paid') {
      const error = new Error('Payment already completed');
      error.statusCode = 400;
      throw error;
    }

    // Use paystackService (updated multi‑tenant)
    const response = await paystackService.initializePayment({
      email: payment.user.email,
      amount: payment.amount,
      organizationId,
      reference: `PAY-${payment._id}-${Date.now()}`,
      metadata: {
        paymentId: payment._id.toString(),
        userId: payment.user._id.toString(),
        type: payment.type,
        description: payment.description
      }
    });

    // Save Paystack reference
    payment.transactionReference = response.data.reference;
    await payment.save();

    return {
      authorizationUrl: response.data.authorization_url,
      reference: response.data.reference,
      paymentId: payment._id
    };
  }

  /**
   * Verify payment and update records (scoped by organizationId when possible)
   * @param {string} reference - Transaction reference
   * @param {string} [organizationId] - Optional organizationId (will use metadata)
   * @returns {Promise<Object>} - Verification result
   */
  async verifyPayment(reference, organizationId = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // First find payment by reference, optionally scoped
      let payment;
      if (organizationId) {
        payment = await Payment.findOne({ transactionReference: reference, organizationId });
      } else {
        payment = await Payment.findOne({ transactionReference: reference });
      }

      if (!payment) {
        const error = new Error('Payment not found');
        error.statusCode = 404;
        throw error;
      }

      if (payment.status === 'paid') {
        await session.commitTransaction();
        session.endSession();
        return { verified: true, payment, message: 'Payment already verified' };
      }

      const verification = await paystackService.verifyPayment(reference);
      if (verification.data.status === 'success') {
        const amountPaid = verification.data.amount / 100;
        const expectedAmount = payment.expectedAmount || payment.amount;

        // Partial payment handling
        if (amountPaid < expectedAmount) {
          // Handle partial payment inline
          const remainingAmount = expectedAmount - amountPaid;
          payment.paidAmount = amountPaid;
          payment.remainingAmount = remainingAmount;
          payment.isPartial = true;
          payment.status = 'partial';
          payment.paidAt = new Date();
          await payment.save({ session });

          // Create outstanding payment record
          await Payment.create([{
            user: payment.user,
            name: `${payment.name} (Outstanding Balance)`,
            type: payment.type,
            amount: remainingAmount,
            expectedAmount: remainingAmount,
            paidAmount: 0,
            remainingAmount: remainingAmount,
            isPartial: false,
            parentPaymentId: payment._id,
            paymentTypeId: payment.paymentTypeId,
            organizationId: payment.organizationId,
            description: `Remaining balance of ₦${remainingAmount.toLocaleString()} for ${payment.name}`,
            status: 'unpaid',
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          }], { session });

          await Income.create([{
            amount: amountPaid,
            source: `${payment.type} - ${payment.description || 'Payment'} (Partial)`,
            date: new Date(),
            description: `Partial payment of ₦${amountPaid.toLocaleString()} for ${payment.name}. Remaining: ₦${remainingAmount.toLocaleString()}`,
            paymentId: payment._id,
            paymentType: payment.type,
            userId: payment.user,
            organizationId: payment.organizationId,
            transactionReference: reference,
            isPartial: true
          }], { session });

          await session.commitTransaction();
          session.endSession();

          return {
            verified: true,
            payment,
            isPartial: true,
            paidAmount: amountPaid,
            remainingAmount,
            message: `Partial payment of ₦${amountPaid.toLocaleString()} received`
          };
        } else {
          // Full payment
          payment.status = 'paid';
          payment.paidAmount = amountPaid;
          payment.remainingAmount = 0;
          payment.paidAt = new Date();
          await payment.save({ session });

          if (payment.type === 'registration') {
            await User.findByIdAndUpdate(
              payment.user,
              { hasPaidRegistration: true },
              { session }
            );
          }

          await Income.create([{
            amount: payment.amount,
            source: `Payment: ${payment.type.toUpperCase()}`,
            description: `${payment.type} payment from member`,
            paymentId: payment._id,
            paymentType: payment.type,
            userId: payment.user,
            organizationId: payment.organizationId,
            transactionReference: reference
          }], { session });

          await session.commitTransaction();
          session.endSession();

          return {
            verified: true,
            payment,
            message: 'Payment verified successfully'
          };
        }
      } else {
        await session.abortTransaction();
        session.endSession();
        const error = new Error('Payment verification failed');
        error.statusCode = 400;
        error.paymentStatus = verification.data.status;
        throw error;
      }
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Get user payments with filtering (scoped to organization)
   * @param {string} userId - User ID
   * @param {string} organizationId - Organization ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payments data
   */
  async getUserPayments(userId, organizationId, filters = {}) {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = filters;

    const query = { user: userId, organizationId };
    if (status) query.status = status;
    if (type) query.type = type;
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [payments, total] = await Promise.all([
      Payment.find(query)
        .populate('paymentTypeId', 'name description')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Payment.countDocuments(query)
    ]);

    // Calculate summary (same as original but scoped)
    let totalPaid = 0;
    let totalOutstanding = 0;
    let totalPartialRemaining = 0;
    const byType = {};

    payments.forEach(payment => {
      const isPaid = payment.status === 'paid';
      const isPartial = payment.status === 'partial';
      const isUnpaid = payment.status === 'unpaid';

      if (isPaid) {
        totalPaid += payment.amount;
      } else if (isPartial) {
        const paid = payment.paidAmount || 0;
        const remaining = payment.remainingAmount || (payment.expectedAmount - paid);
        totalPaid += paid;
        totalPartialRemaining += remaining;
      } else if (isUnpaid) {
        totalOutstanding += payment.amount;
      }

      const typeKey = payment.type;
      if (!byType[typeKey]) {
        byType[typeKey] = { paid: 0, unpaid: 0, partial: 0, partialRemaining: 0, total: 0 };
      }
      if (isPaid) byType[typeKey].paid += payment.amount;
      else if (isPartial) {
        byType[typeKey].partial += payment.paidAmount || 0;
        byType[typeKey].partialRemaining += payment.remainingAmount || 0;
      } else if (isUnpaid) byType[typeKey].unpaid += payment.amount;
      byType[typeKey].total += payment.amount;
    });

    const summary = {
      totalPaid,
      totalOutstanding: totalOutstanding + totalPartialRemaining,
      totalPartialRemaining,
      byType
    };

    return {
      records: payments,
      summary,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    };
  }

  /**
   * Get all payments (Admin) – scoped to organization
   * @param {string} organizationId - Organization ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payments data
   */
 // backend/src/services/paymentService.js - Update getAllPayments method

async getAllPayments(filters = {}) {
  const { status, type, userId, startDate, endDate, page = 1, limit = 20 } = filters;
  
  // Get organizationId from the authenticated user (passed via req.user)
  // This should be passed from the controller
  const organizationId = filters.organizationId;
  const userRole = filters.userRole;
  
  const query = {};
  
  // Super admin sees all, regular admin sees only their organization
  if (userRole !== 'super-admin' && userRole !== 'super_admin') {
    if (!organizationId) {
      throw new Error('Organization ID required for non-super-admin users');
    }
    query.organizationId = organizationId;
  }
  
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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Payment.countDocuments(query)
  ]);
  
  // Calculate totals
  const totals = await Payment.aggregate([
    { $match: query },
    { $group: {
      _id: '$status',
      total: { $sum: '$amount' },
      count: { $sum: 1 }
    }}
  ]);
  
  const paidTotal = totals.find(t => t._id === 'paid')?.total || 0;
  const unpaidTotal = totals.find(t => t._id === 'unpaid')?.total || 0;
  
  return {
    records: payments,
    summary: {
      totalPaid: paidTotal,
      totalUnpaid: unpaidTotal,
      totalPayments: paidTotal + unpaidTotal,
      count: total
    },
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  };
}

  /**
   * Get outstanding payments for a user (scoped)
   * @param {string} userId - User ID
   * @param {string} organizationId - Organization ID
   * @returns {Promise<Object>} - Outstanding payments
   */
  async getOutstandingPayments(userId, organizationId) {
    const payments = await Payment.find({
      user: userId,
      organizationId,
      status: { $in: ['unpaid', 'partial'] }
    }).populate('paymentTypeId', 'name description').sort({ dueDate: 1 });

    let totalOutstanding = 0;
    const processedPayments = payments.map(payment => {
      let amountOutstanding;
      let displayAmount;
      if (payment.status === 'partial') {
        amountOutstanding = payment.remainingAmount || (payment.expectedAmount - payment.paidAmount);
        displayAmount = amountOutstanding;
      } else {
        amountOutstanding = payment.amount;
        displayAmount = payment.amount;
      }
      totalOutstanding += amountOutstanding;
      return {
        _id: payment._id,
        name: payment.name,
        description: payment.description,
        amount: displayAmount,
        originalAmount: payment.expectedAmount || payment.amount,
        paidAmount: payment.paidAmount || 0,
        remainingAmount: amountOutstanding,
        type: payment.type,
        status: payment.status,
        isPartial: payment.status === 'partial',
        dueDate: payment.dueDate,
        paymentTypeId: payment.paymentTypeId,
        createdAt: payment.createdAt
      };
    });

    return {
      payments: processedPayments,
      totalOutstanding,
      count: processedPayments.length
    };
  }

  /**
   * Process bulk payments (Admin) – scoped to organization
   * @param {Array} paymentsData - Array of { userId, type, amount, dueDate, description, createdBy }
   * @param {string} organizationId - Organization ID
   * @returns {Promise<Object>} - Processing results
   */
  async processBulkPayments(paymentsData, organizationId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    const results = { successful: [], failed: [] };

    try {
      for (const data of paymentsData) {
        try {
          const payment = await this.createPayment({
            ...data,
            createdBy: data.createdBy,
            organizationId
          });
          results.successful.push({
            id: payment._id,
            userId: data.userId,
            type: data.type,
            amount: data.amount
          });
        } catch (error) {
          results.failed.push({
            userId: data.userId,
            type: data.type,
            error: error.message
          });
        }
      }
      await session.commitTransaction();
      session.endSession();
      return results;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Generate payment summary for reporting (scoped)
   * @param {string} organizationId - Organization ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payment summary
   */
  async getPaymentSummary(organizationId, filters = {}) {
    const { startDate, endDate } = filters;
    const query = { organizationId };
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const [byType, byStatus, totalRevenue] = await Promise.all([
      Payment.aggregate([
        { $match: query },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: query },
        { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: { ...query, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    return {
      byType: byType.reduce((acc, item) => {
        acc[item._id] = { total: item.total, count: item.count };
        return acc;
      }, {}),
      byStatus: byStatus.reduce((acc, item) => {
        acc[item._id] = { total: item.total, count: item.count };
        return acc;
      }, {}),
      totalRevenue: totalRevenue[0]?.total || 0,
      period: { startDate, endDate }
    };
  }

  /**
   * Handle Paystack webhook events (uses metadata.organizationId)
   * @param {Object} event - Webhook event data
   * @returns {Promise<Object>} - Processing result
   */
  async handleWebhook(event) {
    const { event: eventType, data } = event;
    if (eventType === 'charge.success') {
      const organizationId = data.metadata?.organizationId;
      return await this.verifyPayment(data.reference, organizationId);
    }
    console.log('Unhandled webhook event:', eventType);
    return { received: true, event: eventType };
  }

  /**
   * Get pending payments for a user (payment types not yet paid) – scoped to organization
   * @param {string} userId - User ID
   * @param {string} organizationId - Organization ID
   * @returns {Promise<Object>} Pending payments
   */
  async getPendingPayments(userId, organizationId) {
    const paymentTypes = await PaymentType.find({ isActive: true, organizationId });
    const existingPayments = await Payment.find({
      user: userId,
      organizationId,
      status: 'paid'
    });

    const paidTypeIds = existingPayments.map(p => p.paymentTypeId?.toString()).filter(id => id);

    const pendingPaymentTypes = paymentTypes.filter(
      type => !paidTypeIds.includes(type._id.toString())
    );

    const pendingPayments = pendingPaymentTypes.map(type => ({
      _id: type._id,
      name: type.name,
      description: type.description,
      amount: type.amount,
      type: type.type,
      isMandatory: type.is_mandatory || false,
      status: 'pending'
    }));

    return {
      records: pendingPayments,
      total: pendingPayments.length
    };
  }
}

module.exports = new PaymentService();