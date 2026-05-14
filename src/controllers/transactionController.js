// backend/src/controllers/TransactionController.js
const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');
const Payment = require('../models/Payment');
const mongoose = require('mongoose');

/**
 * Transaction Controller - Handles income and expenditure operations
 * Manages all financial transactions in the system
 * Now fully multi‑tenant: all operations are scoped to the authenticated user's organization.
 */
class TransactionController {
  /**
   * Get organizationId from authenticated user
   * Returns null for super-admin (they have no organization restriction)
   */
  getOrgId = (req) => {
    // Super admin has no organization - they manage all organizations
    if (!req.user) return null;
    if (req.user.role === 'super-admin' || req.user.role === 'super_admin') {
      return null;
    }
    return req.user.organizationId;
  };

  /**
   * Record new income (scoped to organization)
   * @route POST /api/transactions/income
   * @access Private/Admin
   */
  recordIncome = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const { amount, source, description } = req.body;
  
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be greater than 0'
        });
      }
  
      if (!source || source.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Source of income is required'
        });
      }
  
      // FIXED: Always require organizationId
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID is required. Please ensure you are logged into an organization.'
        });
      }
  
      const income = await Income.create({
        amount,
        source,
        description: description || '',
        createdBy: req.user.id,
        organizationId: organizationId,  // ✅ Always set this
        type: 'manual',
        date: new Date()
      });
  
      res.status(201).json({
        success: true,
        data: income,
        message: 'Income recorded successfully'
      });
    } catch (error) {
      console.error('Error in recordIncome:', error);
      next(error);
    }
  };

  /**
   * Record new expenditure (scoped to organization)
   * @route POST /api/transactions/expenditure
   * @access Private/Admin
   */
  recordExpenditure = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { amount, purpose, description, receipt } = req.body;
  
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be greater than 0'
        });
      }
  
      if (!purpose || purpose.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Purpose of expenditure is required'
        });
      }
  
      // FIXED: Always require organizationId for non-super-admin
      if (!organizationId && userRole !== 'super-admin' && userRole !== 'super_admin') {
        return res.status(400).json({
          success: false,
          message: 'Organization ID is required. Please ensure you are logged into an organization.'
        });
      }
  
      // For non-super-admin, check if sufficient balance exists
      if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
        const orgObjectId = new mongoose.Types.ObjectId(organizationId);
        
        const totalIncome = await Income.aggregate([
          { $match: { organizationId: orgObjectId } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
  
        const totalExpenditure = await Expenditure.aggregate([
          { $match: { organizationId: orgObjectId } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
  
        const balance = (totalIncome[0]?.total || 0) - (totalExpenditure[0]?.total || 0);
  
        if (balance < amount) {
          return res.status(400).json({
            success: false,
            message: 'Insufficient funds for this expenditure',
            data: { balance, requested: amount }
          });
        }
      }
  
      // FIXED: Always include organizationId (not conditionally)
      const expenditure = await Expenditure.create({
        amount,
        purpose,
        description: description || '',
        receipt: receipt || null,
        createdBy: req.user.id,
        organizationId: organizationId,  // ✅ Always set this
        date: new Date()
      });
  
      res.status(201).json({
        success: true,
        data: expenditure,
        message: 'Expenditure recorded successfully'
      });
    } catch (error) {
      console.error('Error in recordExpenditure:', error);
      next(error);
    }
  };
  /**
   * Auto-record payment as income (called when payment is successful)
   */
  recordIncomeFromPayment = async (paymentData) => {
    try {
      const { paymentId, amount, type, userId, paymentTypeId, description, organizationId } = paymentData;

      const income = await Income.create({
        amount,
        source: `Member Payment: ${type.toUpperCase()}`,
        description: description || `Payment from member for ${type}`,
        paymentId,
        userId,
        paymentTypeId,
        createdBy: userId,
        organizationId,
        date: new Date(),
        type: 'payment'
      });

      return income;
    } catch (error) {
      console.error('Error recording income from payment:', error);
      throw error;
    }
  };

  /**
   * Get all incomes with filters (scoped to organization)
   * @route GET /api/transactions/income
   * @access Private/Admin
   */
  getAllIncomes = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { startDate, endDate, source, type, page = 1, limit = 20 } = req.query;

      let query = {};
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      if (startDate && endDate) {
        query.date = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      if (source) {
        query.source = { $regex: source, $options: 'i' };
      }

      if (type && type !== 'all') {
        query.type = type;
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);

      const [incomes, total, totalAmount] = await Promise.all([
        Income.find(query)
          .populate('createdBy', 'name email')
          .populate('userId', 'name email')
          .sort({ date: -1, createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        Income.countDocuments(query),
        Income.aggregate([
          { $match: query },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      res.status(200).json({
        success: true,
        data: {
          records: incomes,
          summary: {
            total: totalAmount[0]?.total || 0,
            count: total,
            byType: {
              manual: incomes.filter(i => i.type === 'manual').reduce((sum, i) => sum + i.amount, 0),
              payment: incomes.filter(i => i.type === 'payment').reduce((sum, i) => sum + i.amount, 0)
            }
          },
          pagination: {
            page: parseInt(page),
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum)
          }
        }
      });
    } catch (error) {
      console.error('Error in getAllIncomes:', error);
      next(error);
    }
  };

  /**
   * Get all expenditures with filters (scoped to organization)
   * @route GET /api/transactions/expenditure
   * @access Private/Admin
   */
  getAllExpenditures = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { startDate, endDate, purpose, page = 1, limit = 20 } = req.query;

      let query = {};
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      if (startDate && endDate) {
        query.date = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      if (purpose) {
        query.purpose = { $regex: purpose, $options: 'i' };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);

      const [expenditures, total, totalAmount] = await Promise.all([
        Expenditure.find(query)
          .populate('createdBy', 'name email')
          .sort({ date: -1, createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        Expenditure.countDocuments(query),
        Expenditure.aggregate([
          { $match: query },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      res.status(200).json({
        success: true,
        data: {
          records: expenditures,
          summary: {
            total: totalAmount[0]?.total || 0,
            count: total
          },
          pagination: {
            page: parseInt(page),
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum)
          }
        }
      });
    } catch (error) {
      console.error('Error in getAllExpenditures:', error);
      next(error);
    }
  };

  /**
   * Get single income record (scoped)
   * @route GET /api/transactions/income/:id
   * @access Private/Admin
   */
  getIncomeById = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const income = await Income.findOne(query)
        .populate('createdBy', 'name email')
        .populate('userId', 'name email');

      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found'
        });
      }

      res.status(200).json({
        success: true,
        data: income
      });
    } catch (error) {
      console.error('Error in getIncomeById:', error);
      next(error);
    }
  };

  /**
   * Get single expenditure record (scoped)
   * @route GET /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  getExpenditureById = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const expenditure = await Expenditure.findOne(query)
        .populate('createdBy', 'name email');

      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found'
        });
      }

      res.status(200).json({
        success: true,
        data: expenditure
      });
    } catch (error) {
      console.error('Error in getExpenditureById:', error);
      next(error);
    }
  };

  /**
   * Update income record (scoped)
   * @route PUT /api/transactions/income/:id
   * @access Private/Admin
   */
  updateIncome = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { amount, source, description } = req.body;

      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const income = await Income.findOne(query);

      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found'
        });
      }

      if (income.type === 'payment') {
        return res.status(400).json({
          success: false,
          message: 'Cannot edit income that came from member payments'
        });
      }

      if (amount !== undefined) {
        if (amount <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Amount must be greater than 0'
          });
        }
        income.amount = amount;
      }

      if (source !== undefined) {
        if (source.trim() === '') {
          return res.status(400).json({
            success: false,
            message: 'Source cannot be empty'
          });
        }
        income.source = source;
      }

      if (description !== undefined) {
        income.description = description;
      }

      income.updatedBy = req.user.id;
      await income.save();

      res.status(200).json({
        success: true,
        data: income,
        message: 'Income updated successfully'
      });
    } catch (error) {
      console.error('Error in updateIncome:', error);
      next(error);
    }
  };

  /**
   * Update expenditure record (scoped)
   * @route PUT /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  updateExpenditure = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { amount, purpose, description, receipt } = req.body;

      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const expenditure = await Expenditure.findOne(query);

      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found'
        });
      }

      if (amount !== undefined) {
        if (amount <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Amount must be greater than 0'
          });
        }

        if (amount > expenditure.amount) {
          const difference = amount - expenditure.amount;
          const totalIncome = await Income.aggregate([
            { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ]);
          const totalExpenditure = await Expenditure.aggregate([
            { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ]);
          const currentBalance = (totalIncome[0]?.total || 0) - (totalExpenditure[0]?.total || 0);

          if (currentBalance < difference) {
            return res.status(400).json({
              success: false,
              message: 'Insufficient funds for this increase'
            });
          }
        }

        expenditure.amount = amount;
      }

      if (purpose !== undefined) {
        if (purpose.trim() === '') {
          return res.status(400).json({
            success: false,
            message: 'Purpose cannot be empty'
          });
        }
        expenditure.purpose = purpose;
      }

      if (description !== undefined) {
        expenditure.description = description;
      }

      if (receipt !== undefined) {
        expenditure.receipt = receipt;
      }

      expenditure.updatedBy = req.user.id;
      await expenditure.save();

      res.status(200).json({
        success: true,
        data: expenditure,
        message: 'Expenditure updated successfully'
      });
    } catch (error) {
      console.error('Error in updateExpenditure:', error);
      next(error);
    }
  };

  /**
   * Delete income record (scoped)
   * @route DELETE /api/transactions/income/:id
   * @access Private/Admin
   */
  deleteIncome = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const income = await Income.findOne(query);

      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found'
        });
      }

      if (income.type === 'payment') {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete income that came from member payments'
        });
      }

      await income.deleteOne();

      res.status(200).json({
        success: true,
        message: 'Income deleted successfully'
      });
    } catch (error) {
      console.error('Error in deleteIncome:', error);
      next(error);
    }
  };

  /**
   * Delete expenditure record (scoped)
   * @route DELETE /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  deleteExpenditure = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let query = { _id: req.params.id };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }

      const expenditure = await Expenditure.findOne(query);

      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found'
        });
      }

      await expenditure.deleteOne();

      res.status(200).json({
        success: true,
        message: 'Expenditure deleted successfully'
      });
    } catch (error) {
      console.error('Error in deleteExpenditure:', error);
      next(error);
    }
  };

  /**
   * Get transaction summary for dashboard (scoped)
   * @route GET /api/transactions/summary
   * @access Private
   */
  getTransactionSummary = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
      }

      const orgObjectId = organizationId ? new mongoose.Types.ObjectId(organizationId) : null;
      
      let incomeMatch = {};
      let expenditureMatch = {};
      let paymentMatch = {};
      
      if (orgObjectId) {
        incomeMatch = { organizationId: orgObjectId };
        expenditureMatch = { organizationId: orgObjectId };
        paymentMatch = { organizationId: orgObjectId };
      }

      const [totalIncome, totalExpenditure, recentPayments, incomeCount, expenditureCount, incomeByType] = await Promise.all([
        Income.aggregate([{ $match: incomeMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $match: expenditureMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Payment.find({ ...paymentMatch, status: 'paid' })
          .sort({ paidAt: -1 })
          .limit(5)
          .populate('user', 'name email'),
        Income.countDocuments(incomeMatch),
        Expenditure.countDocuments(expenditureMatch),
        Income.aggregate([
          { $match: incomeMatch },
          {
            $group: {
              _id: '$type',
              total: { $sum: '$amount' },
              count: { $sum: 1 }
            }
          }
        ])
      ]);

      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      const balance = income - expenditure;

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const monthlyIncome = await Income.aggregate([
        { $match: { ...incomeMatch, date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            total: { $sum: '$amount' }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      const monthlyExpenditure = await Expenditure.aggregate([
        { $match: { ...expenditureMatch, date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            total: { $sum: '$amount' }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      res.status(200).json({
        success: true,
        data: {
          totalIncome: income,
          totalExpenditure: expenditure,
          balance,
          incomeBreakdown: incomeByType,
          recentPayments,
          transactionCount: {
            income: incomeCount,
            expenditure: expenditureCount
          },
          monthlyData: {
            income: monthlyIncome,
            expenditure: monthlyExpenditure
          }
        }
      });
    } catch (error) {
      console.error('Error in getTransactionSummary:', error);
      next(error);
    }
  };

  /**
   * Get current balance (scoped)
   * @route GET /api/transactions/balance
   * @access Private/Admin
   */
  getBalance = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let matchCondition = {};
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        matchCondition = { organizationId: new mongoose.Types.ObjectId(organizationId) };
      }

      const [totalIncome, totalExpenditure, paymentsTotal] = await Promise.all([
        Income.aggregate([{ $match: matchCondition }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $match: matchCondition }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Payment.aggregate([
          { $match: { ...matchCondition, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      const payments = paymentsTotal[0]?.total || 0;

      res.status(200).json({
        success: true,
        data: {
          balance: income - expenditure,
          income,
          expenditure,
          payments,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      console.error('Error in getBalance:', error);
      next(error);
    }
  };

  /**
   * Get total income (including payments) – scoped to organization
   * @route GET /api/transactions/total-income
   * @access Private/Admin
   */
  getTotalIncome = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let matchCondition = {};
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        matchCondition = { organizationId: new mongoose.Types.ObjectId(organizationId) };
      }

      const [manualIncome, paymentIncome, paymentsTotal] = await Promise.all([
        Income.aggregate([
          { $match: { ...matchCondition, type: 'manual' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Income.aggregate([
          { $match: { ...matchCondition, type: 'payment' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.aggregate([
          { $match: { ...matchCondition, status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);

      const manualTotal = manualIncome[0]?.total || 0;
      const paymentTotal = paymentIncome[0]?.total || 0;
      const directPaymentTotal = paymentsTotal[0]?.total || 0;

      res.status(200).json({
        success: true,
        data: {
          totalIncome: manualTotal + paymentTotal,
          manualIncome: manualTotal,
          paymentIncome: paymentTotal,
          directPaymentTotal: directPaymentTotal,
          discrepancy: (manualTotal + paymentTotal) - directPaymentTotal
        }
      });
    } catch (error) {
      console.error('Error in getTotalIncome:', error);
      next(error);
    }
  };

  /**
   * Get all income records for public/member viewing (Read-only, scoped)
   * @route GET /api/transactions/income/public
   * @access Private (Authenticated users)
   */
  a/**
 * Get all income records for public/member viewing (Read-only, scoped)
 * @route GET /api/transactions/income/public
 * @access Private (Authenticated users)
 */
async getAllIncomesPublic(req, res, next) {
  try {
    const organizationId = req.user.organizationId;
    const userRole = req.user.role;
    const { startDate, endDate, page = 1, limit = 50 } = req.query;

    let query = {};
    
    // Super admin sees all, regular users see only their organization
    if (userRole !== 'super-admin' && userRole !== 'super_admin') {
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this user'
        });
      }
      query.organizationId = organizationId;
    }

    // FIXED: Use createdAt instead of date
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [incomes, total, totalAmount] = await Promise.all([
      Income.find(query)
        .select('-createdBy -updatedBy -__v')
        .sort({ createdAt: -1 })  // FIXED: Use createdAt instead of date
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Income.countDocuments(query),
      Income.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    console.log(`Found ${incomes.length} income records for organization ${organizationId}`);

    res.status(200).json({
      success: true,
      data: {
        records: incomes,  // ← Wrap in records property
        summary: {
          total: totalAmount[0]?.total || 0,
          count: total
        },
        pagination: {
          page: parseInt(page),
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('Error in getAllIncomesPublic:', error);
    next(error);
  }
}
  


 // Update getAllExpendituresPublic method
/**
 * Get all expenditure records for public/member viewing (Read-only, scoped)
 * @route GET /api/transactions/expenditure/public
 * @access Private (Authenticated users)
 */
async getAllExpendituresPublic(req, res, next) {
  try {
    const organizationId = req.user.organizationId;
    const userRole = req.user.role;
    const { startDate, endDate, page = 1, limit = 50 } = req.query;

    let query = {};
    
    // Super admin sees all, regular users see only their organization
    if (userRole !== 'super-admin' && userRole !== 'super_admin') {
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this user'
        });
      }
      query.organizationId = organizationId;
    }

    // FIXED: Use createdAt instead of date
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const [expenditures, total, totalAmount] = await Promise.all([
      Expenditure.find(query)
        .select('-createdBy -updatedBy -__v -receipt')
        .sort({ createdAt: -1 })  // FIXED: Use createdAt instead of date
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Expenditure.countDocuments(query),
      Expenditure.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    console.log(`Found ${expenditures.length} expenditure records for organization ${organizationId}`);

    res.status(200).json({
      success: true,
      data: {
        records: expenditures,
        summary: {
          total: totalAmount[0]?.total || 0,
          count: total
        },
        pagination: {
          page: parseInt(page),
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('Error in getAllExpendituresPublic:', error);
    next(error);
  }
}

  /**
   * Get recent transactions (scoped)
   * @route GET /api/transactions/recent
   * @access Private/Admin
   */
  getRecentTransactions = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { limit = 10 } = req.query;
      const limitNum = parseInt(limit);

      let incomeQuery = {};
      let expenditureQuery = {};
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        incomeQuery = { organizationId };
        expenditureQuery = { organizationId };
      }

      const [incomes, expenditures] = await Promise.all([
        Income.find(incomeQuery)
          .sort({ createdAt: -1 })
          .limit(limitNum)
          .populate('createdBy', 'name')
          .populate('userId', 'name'),
        Expenditure.find(expenditureQuery)
          .sort({ createdAt: -1 })
          .limit(limitNum)
          .populate('createdBy', 'name')
      ]);

      const transactions = [
        ...incomes.map(inc => ({
          id: inc._id,
          type: 'income',
          subType: inc.type || 'manual',
          amount: inc.amount,
          description: inc.description,
          source: inc.source,
          memberName: inc.userId?.name,
          createdBy: inc.createdBy?.name || 'System',
          createdAt: inc.createdAt,
          date: inc.date
        })),
        ...expenditures.map(exp => ({
          id: exp._id,
          type: 'expenditure',
          amount: exp.amount,
          description: exp.description,
          purpose: exp.purpose,
          createdBy: exp.createdBy?.name || 'System',
          createdAt: exp.createdAt,
          date: exp.date
        }))
      ];

      transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.status(200).json({
        success: true,
        data: transactions.slice(0, limitNum)
      });
    } catch (error) {
      console.error('Error in getRecentTransactions:', error);
      next(error);
    }
  };
}

// Export using arrow function class properties
module.exports = new TransactionController();