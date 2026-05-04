const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');
const Payment = require('../models/Payment');

/**
 * Transaction Controller - Handles income and expenditure operations
 * Manages all financial transactions in the system
 */
class TransactionController {
  /**
   * Record new income
   * @route POST /api/transactions/income
   * @access Private/Admin
   */
  async recordIncome(req, res, next) {
    try {
      const { amount, source, description } = req.body;
      
      // Validate amount
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be greater than 0'
        });
      }

      // Validate source
      if (!source || source.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Source of income is required'
        });
      }

      const income = await Income.create({
        amount,
        source,
        description: description || '',
        createdBy: req.user.id,
        date: new Date(),
        type: 'manual'
      });

      res.status(201).json({
        success: true,
        data: income,
        message: 'Income recorded successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Record new expenditure
   * @route POST /api/transactions/expenditure
   * @access Private/Admin
   */
  async recordExpenditure(req, res, next) {
    try {
      const { amount, purpose, description, receipt } = req.body;
      
      // Validate amount
      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be greater than 0'
        });
      }

      // Validate purpose
      if (!purpose || purpose.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Purpose of expenditure is required'
        });
      }

      // Check if sufficient balance exists
      const totalIncome = await Income.aggregate([
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      
      const totalExpenditure = await Expenditure.aggregate([
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

      const expenditure = await Expenditure.create({
        amount,
        purpose,
        description: description || '',
        receipt: receipt || null,
        createdBy: req.user.id,
        date: new Date()
      });

      res.status(201).json({
        success: true,
        data: expenditure,
        message: 'Expenditure recorded successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Auto-record payment as income (called when payment is successful)
   */
  async recordIncomeFromPayment(paymentData) {
    try {
      const { paymentId, amount, type, userId, paymentTypeId, description } = paymentData;
      
      const income = await Income.create({
        amount,
        source: `Member Payment: ${type.toUpperCase()}`,
        description: description || `Payment from member for ${type}`,
        paymentId,
        userId,
        paymentTypeId,
        createdBy: userId,
        date: new Date(),
        type: 'payment'
      });
      
      return income;
    } catch (error) {
      console.error('Error recording income from payment:', error);
      throw error;
    }
  }

  /**
   * Get total income (including payments)
   * @route GET /api/transactions/total-income
   * @access Private/Admin
   */
  async getTotalIncome(req, res, next) {
    try {
      const [manualIncome, paymentIncome, paymentsTotal] = await Promise.all([
        Income.aggregate([
          { $match: { type: 'manual' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Income.aggregate([
          { $match: { type: 'payment' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.aggregate([
          { $match: { status: 'paid' } },
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
      next(error);
    }
  }

  /**
   * Get all incomes with filters
   * @route GET /api/transactions/income
   * @access Private/Admin
   */
  async getAllIncomes(req, res, next) {
    try {
      const { startDate, endDate, source, type, page = 1, limit = 20 } = req.query;
      
      const query = {};
      
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
      next(error);
    }
  }

  /**
   * Get all expenditures with filters
   * @route GET /api/transactions/expenditure
   * @access Private/Admin
   */
  async getAllExpenditures(req, res, next) {
    try {
      const { startDate, endDate, purpose, page = 1, limit = 20 } = req.query;
      
      const query = {};
      
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
      next(error);
    }
  }

  /**
   * Get single income record
   * @route GET /api/transactions/income/:id
   * @access Private/Admin
   */
  async getIncomeById(req, res, next) {
    try {
      const income = await Income.findById(req.params.id)
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
      next(error);
    }
  }

  /**
   * Get single expenditure record
   * @route GET /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  async getExpenditureById(req, res, next) {
    try {
      const expenditure = await Expenditure.findById(req.params.id)
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
      next(error);
    }
  }

  /**
   * Update income record
   * @route PUT /api/transactions/income/:id
   * @access Private/Admin
   */
  async updateIncome(req, res, next) {
    try {
      const { amount, source, description } = req.body;
      
      const income = await Income.findById(req.params.id);
      
      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found'
        });
      }

      // Don't allow editing payment-type income
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
      next(error);
    }
  }

  /**
   * Update expenditure record
   * @route PUT /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  async updateExpenditure(req, res, next) {
    try {
      const { amount, purpose, description, receipt } = req.body;
      
      const expenditure = await Expenditure.findById(req.params.id);
      
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
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ]);
          const totalExpenditure = await Expenditure.aggregate([
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
      next(error);
    }
  }

  /**
   * Delete income record
   * @route DELETE /api/transactions/income/:id
   * @access Private/Admin
   */
  async deleteIncome(req, res, next) {
    try {
      const income = await Income.findById(req.params.id);
      
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
      next(error);
    }
  }

  /**
   * Delete expenditure record
   * @route DELETE /api/transactions/expenditure/:id
   * @access Private/Admin
   */
  async deleteExpenditure(req, res, next) {
    try {
      const expenditure = await Expenditure.findByIdAndDelete(req.params.id);
      
      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Expenditure deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get transaction summary for dashboard
   * @route GET /api/transactions/summary
   * @access Private
   */
  async getTransactionSummary(req, res, next) {
    try {
      const [totalIncome, totalExpenditure, recentPayments, incomeCount, expenditureCount, incomeByType] = await Promise.all([
        Income.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Payment.find({ status: 'paid' })
          .sort({ paidAt: -1 })
          .limit(5)
          .populate('userId', 'name email'),
        Income.countDocuments(),
        Expenditure.countDocuments(),
        Income.aggregate([
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
        { $match: { date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: '$date' }, month: { $month: '$date' } },
            total: { $sum: '$amount' }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);

      const monthlyExpenditure = await Expenditure.aggregate([
        { $match: { date: { $gte: sixMonthsAgo } } },
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
      next(error);
    }
  }

  /**
   * Get current balance
   * @route GET /api/transactions/balance
   * @access Private/Admin
   */
  async getBalance(req, res, next) {
    try {
      const [totalIncome, totalExpenditure, paymentsTotal] = await Promise.all([
        Income.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Payment.aggregate([
          { $match: { status: 'paid' } },
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
      next(error);
    }
  }

    // Add these methods to your TransactionController class (after the existing methods)

  /**
   * Get all income records for public/member viewing (Read-only)
   * @route GET /api/transactions/income/public
   * @access Private (Authenticated users)
   */
  async getAllIncomesPublic(req, res, next) {
    try {
      const { startDate, endDate, page = 1, limit = 50 } = req.query;
      
      const query = {};
      
      if (startDate && endDate) {
        query.date = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);
      
      const [incomes, total, totalAmount] = await Promise.all([
        Income.find(query)
          .select('-createdBy -updatedBy -__v') // Exclude sensitive fields
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
      next(error);
    }
  }

  /**
   * Get all expenditure records for public/member viewing (Read-only)
   * @route GET /api/transactions/expenditure/public
   * @access Private (Authenticated users)
   */
  async getAllExpendituresPublic(req, res, next) {
    try {
      const { startDate, endDate, page = 1, limit = 50 } = req.query;
      
      const query = {};
      
      if (startDate && endDate) {
        query.date = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);
      
      const [expenditures, total, totalAmount] = await Promise.all([
        Expenditure.find(query)
          .select('-createdBy -updatedBy -__v -receipt') // Exclude sensitive fields
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
      next(error);
    }
  }
  /**
   * Get recent transactions
   * @route GET /api/transactions/recent
   * @access Private/Admin
   */
  async getRecentTransactions(req, res, next) {
    try {
      const { limit = 10 } = req.query;
      const limitNum = parseInt(limit);
      
      const [incomes, expenditures] = await Promise.all([
        Income.find()
          .sort({ createdAt: -1 })
          .limit(limitNum)
          .populate('createdBy', 'name')
          .populate('userId', 'name'),
        Expenditure.find()
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
      next(error);
    }
  }
}


module.exports = new TransactionController();