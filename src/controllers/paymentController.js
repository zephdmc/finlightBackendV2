const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');
const paystackService = require('../services/paystackService');
const PaymentType = require('../models/PaymentType');
const crypto = require('crypto');

// Helper function for partial payments
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
  
  // Create outstanding payment record for remaining amount
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

// @desc    Initialize payment
// @route   POST /api/payments/initialize
// @access  Private
exports.initializePayment = async (req, res, next) => {
  try {
    const { paymentId } = req.body;
    
    const payment = await Payment.findById(paymentId).populate('user', 'name email');
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    if (payment.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already completed'
      });
    }
    
    const paymentData = {
      email: payment.user.email,
      amount: payment.amount * 100,
      reference: `PAY-${payment._id}-${Date.now()}`,
      metadata: {
        paymentId: payment._id,
        userId: payment.user._id,
        type: payment.type,
        expectedAmount: payment.expectedAmount || payment.amount
      }
    };
    
    const response = await paystackService.initializePayment(paymentData);
    
    payment.transactionReference = paymentData.reference;
    await payment.save();
    
    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: response.data.authorization_url,
        reference: paymentData.reference
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create direct payment (Admin only - no Paystack)
// @route   POST /api/payments/admin-direct
// @access  Private/Admin
exports.createAdminDirectPayment = async (req, res, next) => {
    try {
      const { userId, type, amount, dueDate, description, paymentTypeId, paidAt } = req.body;
      
      console.log('Admin direct payment request:', req.body);
      
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required'
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
      
      const existingPayment = await Payment.findOne({
        user: userId,
        paymentTypeId: paymentTypeId,
        status: 'paid'
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
        status: 'paid',
        paidAt: paidAt || new Date(),
        transactionReference: `ADMIN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      });
      
      await payment.populate('user', 'name email');
      
      if (type === 'registration') {
        await User.findByIdAndUpdate(userId, { hasPaidRegistration: true });
      }
      
      // Record as income
      try {
        const incomeData = {
          amount: payment.amount,
          source: `${type} - ${description || 'Payment'}`,
          date: payment.paidAt || new Date(),
          description: description || `${type} payment recorded by admin`,
          paymentId: payment._id,
          paymentType: type,
          userId: userId,
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

// @desc    Get outstanding payments
// @route   GET /api/payments/outstanding
// @access  Private
exports.getOutstandingPayments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const outstandingPayments = await Payment.find({
      user: userId,
      status: 'unpaid',
      name: { $regex: 'Outstanding Balance', $options: 'i' }
    }).populate('paymentTypeId', 'name description');
    
    const regularUnpaid = await Payment.find({
      user: userId,
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

// @desc    Verify payment (for Paystack callback)
// @route   GET /api/payments/verify/:reference
// @access  Private
exports.verifyPayment = async (req, res, next) => {
  try {
    const { reference } = req.params;
    console.log('Verifying payment reference:', reference);
    
    let payment = await Payment.findOne({ transactionReference: reference });
    
    if (!payment) {
      const match = reference.match(/PAY-([a-f0-9]+)-/);
      if (match && match[1]) {
        payment = await Payment.findById(match[1]);
      }
    }
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    if (payment.status === 'paid') {
      return res.status(200).json({
        success: true,
        data: payment,
        message: 'Payment already verified'
      });
    }
    
    const verification = await paystackService.verifyPayment(reference);
    
    if (verification.data && verification.data.status === 'success') {
      const amountPaid = verification.data.amount / 100;
      const expectedAmount = payment.expectedAmount || payment.amount;
      
      // Check for partial payment
      if (amountPaid < expectedAmount) {
        const partialResult = await handlePartialPayment(payment, amountPaid, reference);
        
        return res.status(200).json({
          success: true,
          data: {
            payment: payment,
            isPartial: true,
            paidAmount: amountPaid,
            remainingAmount: partialResult.remainingAmount,
            outstandingPayment: partialResult.outstandingPayment
          },
          message: `Partial payment of ₦${amountPaid.toLocaleString()} received. Remaining balance: ₦${partialResult.remainingAmount.toLocaleString()}`
        });
      } else {
        payment.status = 'paid';
        payment.paidAmount = amountPaid;
        payment.remainingAmount = 0;
        payment.paidAt = new Date();
        await payment.save();
        
        if (payment.type === 'registration') {
          await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
        }
        
        await Income.create({
          amount: payment.amount,
          source: `${payment.type} - ${payment.description || 'Payment'}`,
          date: payment.paidAt,
          description: payment.description || `${payment.type} payment via Paystack`,
          paymentId: payment._id,
          paymentType: payment.type,
          userId: payment.user,
          transactionReference: payment.transactionReference
        });
        
        res.status(200).json({
          success: true,
          data: payment,
          message: 'Payment verified successfully'
        });
      }
    } else {
      res.status(400).json({
        success: false,
        message: 'Payment verification failed'
      });
    }
  } catch (error) {
    console.error('Verification error:', error);
    next(error);
  }
};

// @desc    Mark a fine as paid (Admin)
// @route   PUT /api/payments/:id/mark-paid
// @access  Private/Admin
exports.markFineAsPaid = async (req, res, next) => {
  try {
    const { paidAt } = req.body;
    
    console.log('=== MARK FINE AS PAID ===');
    console.log('Fine ID:', req.params.id);
    
    const payment = await Payment.findById(req.params.id).populate('user', 'name email');
    
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

// @desc    Create payment (Admin)
// @route   POST /api/payments
// @access  Private/Admin
exports.createPayment = async (req, res, next) => {
  try {
    const { userId, type, amount, dueDate, description, paymentTypeId } = req.body;
    
    const payment = await Payment.create({
      user: userId,
      type,
      amount,
      dueDate,
      description,
      paymentTypeId,
      status: 'unpaid'
    });
    
    res.status(201).json({
      success: true,
      data: payment,
      message: 'Payment created successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user payments
// @route   GET /api/payments
// @access  Private
exports.getUserPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find({ user: req.user.id })
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

// @desc    Get all payments (Admin)
// @route   GET /api/payments/all
// @access  Private/Admin
exports.getAllPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find()
      .populate('user', 'name email')
      .populate('paymentTypeId', 'name description')
      .sort({ createdAt: -1 });
    
    const summary = {
      total: payments.length,
      totalAmount: payments.reduce((sum, p) => sum + p.amount, 0),
      paid: payments.filter(p => p.status === 'paid').length,
      unpaid: payments.filter(p => p.status === 'unpaid').length,
      totalPaidAmount: payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0),
      totalUnpaidAmount: payments.filter(p => p.status === 'unpaid').reduce((sum, p) => sum + p.amount, 0)
    };
    
    res.status(200).json({
      success: true,
      data: payments,
      summary
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payment
// @route   GET /api/payments/:id
// @access  Private
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id)
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

// @desc    Update payment (Admin)
// @route   PUT /api/payments/:id
// @access  Private/Admin
exports.updatePayment = async (req, res, next) => {
  try {
    const { amount, dueDate, description, status, paidAt } = req.body;
    
    const payment = await Payment.findById(req.params.id);
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    if (status) {
      payment.status = status;
    }
    if (paidAt) {
      payment.paidAt = paidAt;
    }
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

// @desc    Delete payment (Admin)
// @route   DELETE /api/payments/:id
// @access  Private/Admin
exports.deletePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    
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

/**
 * Get pending payments for a member
 * @route GET /api/payments/pending
 * @access Private
 */
exports.getPendingPayments = async (req, res, next) => {
    try {
      const userId = req.user.id;
      
      const paymentTypes = await PaymentType.find({ isActive: true });
      
      const existingPayments = await Payment.find({ 
        user: userId,
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
}

// @desc    Get payment statistics (Admin)
// @route   GET /api/payments/stats
// @access  Private/Admin
exports.getPaymentStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    let dateFilter = {};
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

/**
 * @desc    Create payment for member (no admin required, for Paystack flow)
 * @route   POST /api/payments/member-payment
 * @access  Private
 */
exports.createMemberPayment = async (req, res, next) => {
  try {
    const { name, type, amount, description, paymentTypeId } = req.body;
    const userId = req.user.id;
    
    if (!name || !type || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }
    
    // Check if there's already an outstanding payment for this payment type
    const existingOutstanding = await Payment.findOne({
      user: userId,
      paymentTypeId: paymentTypeId,
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

// @desc    Webhook for Paystack
// @route   POST /api/payments/webhook
// @access  Public
exports.handleWebhook = async (req, res, next) => {
  try {
    const event = req.body;
    
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }
    
    if (event.event === 'charge.success') {
      const { reference, amount } = event.data;
      const amountPaid = amount / 100;
      
      let payment = await Payment.findOne({ transactionReference: reference });
      
      if (!payment) {
        payment = await Payment.findOne({ 
          transactionReference: { $regex: `PENDING-.*${reference.substring(0, 10)}` }
        });
      }
      
      if (payment && payment.status !== 'paid' && payment.status !== 'partial') {
        const expectedAmount = payment.expectedAmount || payment.amount;
        
        // Check for partial payment
        if (amountPaid < expectedAmount) {
          const partialResult = await handlePartialPayment(payment, amountPaid, reference);
          
          await Income.create({
            amount: amountPaid,
            source: `${payment.type} - ${payment.description || 'Payment'} (Partial)`,
            date: new Date(),
            description: `Partial payment of ₦${amountPaid.toLocaleString()} for ${payment.name}. Remaining: ₦${partialResult.remainingAmount.toLocaleString()}`,
            paymentId: payment._id,
            paymentType: payment.type,
            userId: payment.user,
            transactionReference: reference,
            isPartial: true
          });
          
          console.log(`Partial payment processed. Remaining balance: ${partialResult.remainingAmount}`);
        } else {
          payment.status = 'paid';
          payment.paidAmount = amountPaid;
          payment.remainingAmount = 0;
          payment.paidAt = new Date();
          payment.transactionReference = reference;
          await payment.save();
          
          await Income.create({
            amount: payment.amount,
            source: `${payment.type} - ${payment.description || 'Payment'}`,
            date: new Date(),
            description: payment.description || `${payment.type} payment via Paystack`,
            paymentId: payment._id,
            paymentType: payment.type,
            userId: payment.user,
            transactionReference: reference
          });
          
          console.log(`Full payment processed for ${payment._id}`);
        }
        
        if (payment.type === 'registration') {
          await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
        }
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    next(error);
  }
};