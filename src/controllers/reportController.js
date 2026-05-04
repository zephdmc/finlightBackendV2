const User = require('../models/User');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');
const mongoose = require('mongoose');

/**
 * Report Controller - Handles all reporting functionality
 * Provides comprehensive financial and membership reports
 */
class ReportController {
  /**
   * Get overall financial summary
   * @route GET /api/reports/summary
   */
  async getSummary(req, res, next) {
    try {
      const [totalIncome, totalExpenditure, totalMembers, unpaidPayments, paidMembers] = await Promise.all([
        Income.aggregate([
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Expenditure.aggregate([
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        User.countDocuments({ role: 'member' }),
        Payment.aggregate([
          { $match: { status: 'unpaid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.countDocuments({ type: 'registration', status: 'paid' })
      ]);

      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      const outstanding = unpaidPayments[0]?.total || 0;

      // Get recent activity for dashboard
      const recentTransactions = await this.getRecentTransactions(5);

      res.status(200).json({
        success: true,
        data: {
          totalIncome: income,
          totalExpenditure: expenditure,
          totalBalance: income - expenditure,
          totalMembers,
          paidMembers,
          outstandingPayments: outstanding,
          registrationFee: 500,
          recentTransactions,
          timestamp: new Date()
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get paid members report
   * @route GET /api/reports/paid-members
   */
  async getPaidMembers(req, res, next) {
    try {
      const { startDate, endDate, page = 1, limit = 50 } = req.query;
      
      const query = { type: 'registration', status: 'paid' };
      
      if (startDate && endDate) {
        query.paidAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [paidMembers, total] = await Promise.all([
        Payment.find(query)
          .populate('user', 'name email createdAt')
          .select('paidAt amount')
          .sort({ paidAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        Payment.countDocuments(query)
      ]);

      res.status(200).json({
        success: true,
        data: {
          records: paidMembers,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get outstanding payments report
   * @route GET /api/reports/outstanding
   */
  async getOutstandingPayments(req, res, next) {
    try {
      const { type, page = 1, limit = 50 } = req.query;
      
      const query = { status: 'unpaid' };
      if (type) query.type = type;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [outstanding, total] = await Promise.all([
        Payment.find(query)
          .populate('user', 'name email')
          .sort({ dueDate: 1, createdAt: 1 })
          .skip(skip)
          .limit(parseInt(limit)),
        Payment.countDocuments(query)
      ]);

      const totalAmount = outstanding.reduce((sum, payment) => sum + payment.amount, 0);

      res.status(200).json({
        success: true,
        data: {
          records: outstanding,
          totalAmount,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get income report with filters
   * @route GET /api/reports/income
   */
  async getIncomeReport(req, res, next) {
    try {
      const { startDate, endDate, source, page = 1, limit = 50 } = req.query;
      
      const query = {};
      
      if (startDate && endDate) {
        query.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }
      
      if (source) {
        query.source = { $regex: source, $options: 'i' };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [incomes, total, summary] = await Promise.all([
        Income.find(query)
          .populate('createdBy', 'name')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        Income.countDocuments(query),
        Income.aggregate([
          { $match: query },
          { $group: { 
            _id: null, 
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            avgAmount: { $avg: '$amount' }
          } }
        ])
      ]);

      res.status(200).json({
        success: true,
        data: {
          records: incomes,
          summary: {
            total: summary[0]?.total || 0,
            count: summary[0]?.count || 0,
            average: summary[0]?.avgAmount || 0
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
      next(error);
    }
  }

  /**
   * Get expenditure report with filters
   * @route GET /api/reports/expenditure
   */
  async getExpenditureReport(req, res, next) {
    try {
      const { startDate, endDate, purpose, page = 1, limit = 50 } = req.query;
      
      const query = {};
      
      if (startDate && endDate) {
        query.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }
      
      if (purpose) {
        query.purpose = { $regex: purpose, $options: 'i' };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [expenditures, total, summary] = await Promise.all([
        Expenditure.find(query)
          .populate('createdBy', 'name')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        Expenditure.countDocuments(query),
        Expenditure.aggregate([
          { $match: query },
          { $group: { 
            _id: null, 
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            avgAmount: { $avg: '$amount' }
          } }
        ])
      ]);

      res.status(200).json({
        success: true,
        data: {
          records: expenditures,
          summary: {
            total: summary[0]?.total || 0,
            count: summary[0]?.count || 0,
            average: summary[0]?.avgAmount || 0
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
      next(error);
    }
  }

  /**
   * Get member payment report (for specific member)
   * @route GET /api/reports/member/:userId
   */
  async getMemberPaymentReport(req, res, next) {
    try {
      const { userId } = req.params;
      const { startDate, endDate } = req.query;

      if (req.user.role !== 'admin' && req.user.id !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this report'
        });
      }

      const query = { user: userId };
      
      if (startDate && endDate) {
        query.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      const [payments, user] = await Promise.all([
        Payment.find(query).sort({ createdAt: -1 }),
        User.findById(userId).select('name email')
      ]);

      const totalPaid = payments
        .filter(p => p.status === 'paid')
        .reduce((sum, p) => sum + p.amount, 0);
      
      const totalOutstanding = payments
        .filter(p => p.status === 'unpaid')
        .reduce((sum, p) => sum + p.amount, 0);

      res.status(200).json({
        success: true,
        data: {
          member: user,
          summary: {
            totalPaid,
            totalOutstanding,
            totalPayments: payments.length,
            paidCount: payments.filter(p => p.status === 'paid').length,
            unpaidCount: payments.filter(p => p.status === 'unpaid').length
          },
          payments
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get monthly financial summary (for charts)
   * @route GET /api/reports/monthly-summary
   */
  async getMonthlySummary(req, res, next) {
    try {
      const { year = new Date().getFullYear() } = req.query;
      
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      const [monthlyIncome, monthlyExpenditure] = await Promise.all([
        Income.aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate }
            }
          },
          {
            $group: {
              _id: { $month: '$createdAt' },
              total: { $sum: '$amount' }
            }
          }
        ]),
        Expenditure.aggregate([
          {
            $match: {
              createdAt: { $gte: startDate, $lte: endDate }
            }
          },
          {
            $group: {
              _id: { $month: '$createdAt' },
              total: { $sum: '$amount' }
            }
          }
        ])
      ]);

      const months = Array.from({ length: 12 }, (_, i) => i + 1);
      const incomeByMonth = {};
      const expenditureByMonth = {};

      monthlyIncome.forEach(item => {
        incomeByMonth[item._id] = item.total;
      });
      
      monthlyExpenditure.forEach(item => {
        expenditureByMonth[item._id] = item.total;
      });

      const data = months.map(month => ({
        month,
        monthName: new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' }),
        income: incomeByMonth[month] || 0,
        expenditure: expenditureByMonth[month] || 0,
        balance: (incomeByMonth[month] || 0) - (expenditureByMonth[month] || 0)
      }));

      res.status(200).json({
        success: true,
        data: {
          year: parseInt(year),
          monthlyData: data,
          totalIncome: data.reduce((sum, m) => sum + m.income, 0),
          totalExpenditure: data.reduce((sum, m) => sum + m.expenditure, 0)
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get recent transactions (helper method)
   */
  async getRecentTransactions(limit = 10) {
    const [incomes, expenditures] = await Promise.all([
      Income.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('createdBy', 'name'),
      Expenditure.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('createdBy', 'name')
    ]);

    const transactions = [
      ...incomes.map(inc => ({
        id: inc._id,
        type: 'income',
        amount: inc.amount,
        description: inc.description,
        reference: inc.source,
        createdBy: inc.createdBy?.name || 'System',
        createdAt: inc.createdAt
      })),
      ...expenditures.map(exp => ({
        id: exp._id,
        type: 'expenditure',
        amount: exp.amount,
        description: exp.description,
        reference: exp.purpose,
        createdBy: exp.createdBy?.name || 'System',
        createdAt: exp.createdAt
      }))
    ];

    return transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
  }

  /**
   * Export report as CSV
   * @route GET /api/reports/export/:type
   */
  async exportReport(req, res, next) {
    try {
      const { type } = req.params;
      const { startDate, endDate } = req.query;
      
      let data = [];
      let filename = '';
      let headers = [];
      
      // Build date filter
      const dateFilter = {};
      if (startDate && endDate) {
        dateFilter.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }
      
      switch(type) {
        case 'income': {
          // Fetch income data directly
          const incomes = await Income.find(dateFilter)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });
          
          filename = `income_report_${new Date().toISOString().split('T')[0]}.csv`;
          headers = ['Date', 'Description', 'Source', 'Amount', 'Recorded By'];
          
          data = incomes.map(item => ({
            'Date': new Date(item.createdAt).toLocaleDateString(),
            'Description': item.description || 'N/A',
            'Source': item.source || 'N/A',
            'Amount': item.amount || 0,
            'Recorded By': item.createdBy?.name || 'System'
          }));
          break;
        }
          
        case 'expenditure': {
          // Fetch expenditure data directly
          const expenditures = await Expenditure.find(dateFilter)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });
          
          filename = `expenditure_report_${new Date().toISOString().split('T')[0]}.csv`;
          headers = ['Date', 'Purpose', 'Description', 'Amount', 'Recorded By'];
          
          data = expenditures.map(item => ({
            'Date': new Date(item.createdAt).toLocaleDateString(),
            'Purpose': item.purpose || 'N/A',
            'Description': item.description || 'N/A',
            'Amount': item.amount || 0,
            'Recorded By': item.createdBy?.name || 'System'
          }));
          break;
        }
          
        case 'payments': {
          // Fetch payments data directly
          const payments = await Payment.find(dateFilter)
            .populate('user', 'name email')
            .sort({ createdAt: -1 });
          
          filename = `payments_report_${new Date().toISOString().split('T')[0]}.csv`;
          headers = ['Date', 'Member Name', 'Member Email', 'Payment Type', 'Amount', 'Status', 'Reference'];
          
          data = payments.map(item => ({
            'Date': new Date(item.createdAt).toLocaleDateString(),
            'Member Name': item.user?.name || 'N/A',
            'Member Email': item.user?.email || 'N/A',
            'Payment Type': item.type || 'N/A',
            'Amount': item.amount || 0,
            'Status': item.status || 'N/A',
            'Reference': item.transactionReference || 'N/A'
          }));
          break;
        }
          
        case 'members': {
          // Fetch members data directly
          const members = await User.find({ role: 'member' })
            .select('-password')
            .sort({ createdAt: -1 });
          
          filename = `members_report_${new Date().toISOString().split('T')[0]}.csv`;
          headers = ['Name', 'Email', 'Role', 'Registration Date', 'Has Paid Registration'];
          
          // Get payment status for each member
          const membersWithStatus = await Promise.all(members.map(async (member) => {
            const registrationPayment = await Payment.findOne({
              user: member._id,
              type: 'registration',
              status: 'paid'
            });
            
            return {
              'Name': member.name,
              'Email': member.email,
              'Role': member.role,
              'Registration Date': new Date(member.createdAt).toLocaleDateString(),
              'Has Paid Registration': registrationPayment ? 'Yes' : 'No'
            };
          }));
          
          data = membersWithStatus;
          break;
        }
          
        default:
          return res.status(400).json({
            success: false,
            message: 'Invalid report type. Valid types: income, expenditure, payments, members'
          });
      }
      
      if (data.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No data found for the selected report'
        });
      }
      
      // Generate CSV content
      const csvHeaders = headers;
      const csvRows = [];
      
      // Add headers
      csvRows.push(csvHeaders.join(','));
      
      // Add data rows
      for (const row of data) {
        const values = csvHeaders.map(header => {
          let value = row[header] || '';
          // Convert to string and escape quotes
          value = String(value).replace(/"/g, '""');
          // Wrap in quotes if contains comma, newline, or quote
          if (value.includes(',') || value.includes('\n') || value.includes('"')) {
            value = `"${value}"`;
          }
          return value;
        });
        csvRows.push(values.join(','));
      }
      
      const csvContent = csvRows.join('\n');
      
      // Set response headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      
      // Send CSV file
      res.status(200).send(csvContent);
      
    } catch (error) {
      console.error('Export error:', error);
      next(error);
    }
  }
}

module.exports = new ReportController();