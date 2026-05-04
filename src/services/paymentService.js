const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const paystackConfig = require('../config/paystack');
const mongoose = require('mongoose');

/**
 * Payment Service
 * Handles all payment-related business logic
 * Manages payment creation, verification, and reconciliation
 */
class PaymentService {
  /**
   * Create a new payment record
   * @param {Object} paymentData - Payment data
   * @returns {Promise<Object>} - Created payment
   */
  async createPayment(paymentData) {
    const { userId, type, amount, dueDate, description, createdBy } = paymentData;
    
    // Validate payment type
    const validTypes = ['registration', 'dues', 'fine'];
    if (!validTypes.includes(type)) {
      const error = new Error('Invalid payment type');
      error.statusCode = 400;
      throw error;
    }
    
    // Validate amount
    if (amount <= 0) {
      const error = new Error('Amount must be greater than 0');
      error.statusCode = 400;
      throw error;
    }
    
    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }
    
    // For registration, check if already exists
    if (type === 'registration') {
      const existingRegistration = await Payment.findOne({
        user: userId,
        type: 'registration'
      });
      
      if (existingRegistration) {
        const error = new Error('Registration payment already exists for this user');
        error.statusCode = 400;
        throw error;
      }
    }
    
    // Create payment
    const payment = await Payment.create({
      user: userId,
      type,
      amount,
      dueDate: dueDate || null,
      description,
      status: 'unpaid',
      createdBy: createdBy || userId
    });
    
    return payment;
  }

  /**
   * Initialize payment with Paystack
   * @param {string} paymentId - Payment ID
   * @param {string} userId - User ID
   * @returns {Promise<Object>} - Payment initialization data
   */
  async initializePayment(paymentId, userId) {
    const payment = await Payment.findById(paymentId).populate('user', 'name email');
    
    if (!payment) {
      const error = new Error('Payment not found');
      error.statusCode = 404;
      throw error;
    }
    
    // Verify ownership
    if (payment.user._id.toString() !== userId && payment.user.role !== 'admin') {
      const error = new Error('Unauthorized to make this payment');
      error.statusCode = 403;
      throw error;
    }
    
    // Check if already paid
    if (payment.status === 'paid') {
      const error = new Error('Payment already completed');
      error.statusCode = 400;
      throw error;
    }
    
    // Generate unique reference
    const reference = paystackConfig.generateReference(payment.type.toUpperCase());
    
    // Prepare payment data for Paystack
    const paymentData = {
      email: payment.user.email,
      amount: paystackConfig.formatAmount(payment.amount),
      reference,
      metadata: {
        paymentId: payment._id.toString(),
        userId: payment.user._id.toString(),
        type: payment.type,
        description: payment.description
      },
      callbackUrl: `${process.env.FRONTEND_URL}/payment/callback`
    };
    
    // Initialize with Paystack
    const response = await paystackConfig.initializeTransaction(paymentData);
    
    // Update payment with reference
    payment.transactionReference = reference;
    await payment.save();
    
    return {
      authorizationUrl: response.data.authorization_url,
      reference,
      paymentId: payment._id
    };
  }

  /**
   * Verify payment and update records
   * @param {string} reference - Transaction reference
   * @returns {Promise<Object>} - Verification result
   */
  async verifyPayment(reference) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // Find payment by reference
      const payment = await Payment.findOne({ transactionReference: reference });
      
      if (!payment) {
        const error = new Error('Payment not found');
        error.statusCode = 404;
        throw error;
      }
      
      // Check if already verified
      if (payment.status === 'paid') {
        return {
          verified: true,
          payment,
          message: 'Payment already verified'
        };
      }
      
      // Verify with Paystack
      const verification = await paystackConfig.verifyTransaction(reference);
      
      if (verification.data.status === 'success') {
        // Update payment status
        payment.status = 'paid';
        payment.paidAt = new Date();
        await payment.save({ session });
        
        // If registration payment, update user
        if (payment.type === 'registration') {
          await User.findByIdAndUpdate(
            payment.user,
            { hasPaidRegistration: true },
            { session }
          );
        }
        
        // Record as income
        await Income.create([{
          amount: payment.amount,
          source: `Payment: ${payment.type.toUpperCase()}`,
          description: `${payment.type} payment from user`,
          createdBy: payment.user,
          reference: reference
        }], { session });
        
        await session.commitTransaction();
        session.endSession();
        
        return {
          verified: true,
          payment,
          message: 'Payment verified successfully'
        };
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
   * Get user payments with filtering
   * @param {string} userId - User ID
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payments data
   */
  /**
 * Get user payments with filtering
 * @param {string} userId - User ID
 * @param {Object} filters - Filter options
 * @returns {Promise<Object>} - Payments data
 */
async getUserPayments(userId, filters = {}) {
  const { status, type, startDate, endDate, page = 1, limit = 20 } = filters;
  
  const query = { user: userId };
  
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
  
  // Calculate summary - handle partial payments correctly
  let totalPaid = 0;
  let totalOutstanding = 0;
  let totalPartialRemaining = 0;
  const byType = {};
  
  payments.forEach(payment => {
    let amountForSummary;
    let isPaidStatus = payment.status === 'paid';
    let isPartialStatus = payment.status === 'partial';
    let isUnpaidStatus = payment.status === 'unpaid';
    
    if (isPaidStatus) {
      amountForSummary = payment.amount;
      totalPaid += payment.amount;
    } else if (isPartialStatus) {
      const remaining = payment.remainingAmount || (payment.expectedAmount - (payment.paidAmount || 0));
      amountForSummary = payment.paidAmount || 0;
      totalPaid += payment.paidAmount || 0;
      totalPartialRemaining += remaining;
    } else if (isUnpaidStatus) {
      amountForSummary = 0;
      totalOutstanding += payment.amount;
    }
    
    // Group by type
    const typeKey = payment.type;
    if (!byType[typeKey]) {
      byType[typeKey] = {
        paid: 0,
        unpaid: 0,
        partial: 0,
        partialRemaining: 0,
        total: 0
      };
    }
    
    if (isPaidStatus) {
      byType[typeKey].paid += payment.amount;
    } else if (isPartialStatus) {
      byType[typeKey].partial += payment.paidAmount || 0;
      byType[typeKey].partialRemaining += payment.remainingAmount || 0;
    } else if (isUnpaidStatus) {
      byType[typeKey].unpaid += payment.amount;
    }
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
   * Get all payments (Admin)
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payments data
   */
  async getAllPayments(filters = {}) {
    const { status, type, userId, startDate, endDate, page = 1, limit = 20 } = filters;
    
    const query = {};
    
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
 * Get outstanding payments for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} - Outstanding payments
 */
async getOutstandingPayments(userId) {
  // Get both unpaid and partial payments
  const payments = await Payment.find({
    user: userId,
    status: { $in: ['unpaid', 'partial'] }
  }).populate('paymentTypeId', 'name description').sort({ dueDate: 1 });
  
  // Calculate total outstanding (including remaining amounts for partial payments)
  let totalOutstanding = 0;
  
  const processedPayments = payments.map(payment => {
    let amountOutstanding;
    let displayAmount;
    
    if (payment.status === 'partial') {
      // For partial payments, use remainingAmount
      amountOutstanding = payment.remainingAmount || (payment.expectedAmount - payment.paidAmount);
      displayAmount = payment.remainingAmount || amountOutstanding;
    } else {
      // For unpaid payments, use full amount
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
   * Process bulk payments (Admin)
   * @param {Array} paymentsData - Array of payment data
   * @returns {Promise<Object>} - Processing results
   */
  async processBulkPayments(paymentsData) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    const results = {
      successful: [],
      failed: []
    };
    
    try {
      for (const paymentData of paymentsData) {
        try {
          const payment = await this.createPayment({
            ...paymentData,
            createdBy: paymentData.createdBy
          });
          
          results.successful.push({
            id: payment._id,
            userId: paymentData.userId,
            type: paymentData.type,
            amount: paymentData.amount
          });
        } catch (error) {
          results.failed.push({
            userId: paymentData.userId,
            type: paymentData.type,
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
   * Generate payment summary for reporting
   * @param {Object} filters - Filter options
   * @returns {Promise<Object>} - Payment summary
   */
  async getPaymentSummary(filters = {}) {
    const { startDate, endDate } = filters;
    
    const query = {};
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const [byType, byStatus, totalRevenue] = await Promise.all([
      Payment.aggregate([
        { $match: query },
        { $group: {
          _id: '$type',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }}
      ]),
      Payment.aggregate([
        { $match: query },
        { $group: {
          _id: '$status',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }}
      ]),
      Payment.aggregate([
        { $match: { ...query, status: 'paid' } },
        { $group: {
          _id: null,
          total: { $sum: '$amount' }
        }}
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
   * Handle Paystack webhook events
   * @param {Object} event - Webhook event data
   * @returns {Promise<Object>} - Processing result
   */
  async handleWebhook(event) {
    const { event: eventType, data } = event;
    
    switch (eventType) {
      case 'charge.success':
        return await this.verifyPayment(data.reference);
      
      case 'transfer.success':
        console.log('Transfer successful:', data);
        // Handle successful transfers if needed
        break;
      
      case 'transfer.failed':
        console.log('Transfer failed:', data);
        // Handle failed transfers
        break;
      
      default:
        console.log('Unhandled webhook event:', eventType);
    }
    
    return { received: true, event: eventType };
    }
    /**
 * Get pending payments for a user (payment types not yet paid)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Pending payments
 */
async getPendingPayments(userId) {
    try {
      // Get all active payment types
      const PaymentType = require('../models/PaymentType');
      const paymentTypes = await PaymentType.find({ isActive: true });
      
      // Get existing paid payments for this user
      const Payment = require('../models/Payment');
      const existingPayments = await Payment.find({ 
        user: userId,
        status: 'paid'
      });
      
      // Get payment type IDs that the user has already paid
      const paidTypeIds = existingPayments
        .map(p => p.paymentType?.toString())
        .filter(id => id);
      
      // Filter out payment types that have already been paid
      const pendingPaymentTypes = paymentTypes.filter(
        type => !paidTypeIds.includes(type._id.toString())
      );
      
      // Format the response
      const pendingPayments = pendingPaymentTypes.map(type => ({
        _id: type._id,
        name: type.name,
        description: type.description,
        amount: type.amount,
        type: type.type,
        isMandatory: type.isMandatory || false,
        status: 'pending'
      }));
      
      return {
        records: pendingPayments,
        total: pendingPayments.length
      };
    } catch (error) {
      console.error('Error getting pending payments:', error);
      throw error;
    }
  }
}


module.exports = new PaymentService();