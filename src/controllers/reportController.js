// backend/src/controllers/ReportController.js
const User = require('../models/User');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');
const mongoose = require('mongoose');

/**
 * Report Controller - Handles all reporting functionality
 * Provides comprehensive financial and membership reports
 * Now fully multi‑tenant: every query is filtered by organizationId.
 */
class ReportController {
  /**
   * Helper: get organizationId from authenticated user
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
   * Get overall financial summary (scoped to organization)
   * @route GET /api/reports/summary
   */
  getSummary = async (req, res, next) => {
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

      const [totalIncome, totalExpenditure, totalMembers, unpaidPayments, paidMembers] = await Promise.all([
        Income.aggregate([{ $match: matchCondition }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $match: matchCondition }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
        User.countDocuments({ ...matchCondition, role: 'member' }),
        Payment.aggregate([
          { $match: { ...matchCondition, status: 'unpaid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.countDocuments({ ...matchCondition, type: 'registration', status: 'paid' })
      ]);

      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      const outstanding = unpaidPayments[0]?.total || 0;

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
          timestamp: new Date()
        }
      });
    } catch (error) {
      console.error('Error in getSummary:', error);
      next(error);
    }
  };

  /**
   * Get paid members report (scoped)
   * @route GET /api/reports/paid-members
   */
  getPaidMembers = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { startDate, endDate, page = 1, limit = 50 } = req.query;

      let query = { type: 'registration', status: 'paid' };
      
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
      console.error('Error in getPaidMembers:', error);
      next(error);
    }
  };

  /**
   * Get outstanding payments report (scoped)
   * @route GET /api/reports/outstanding
   */
  getOutstandingPayments = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { type, page = 1, limit = 50 } = req.query;

      let query = { status: 'unpaid' };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        query.organizationId = organizationId;
      }
      
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
      console.error('Error in getOutstandingPayments:', error);
      next(error);
    }
  };

  /**
   * Get income report with filters (scoped)
   * @route GET /api/reports/income
   */
  getIncomeReport = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { startDate, endDate, source, page = 1, limit = 50 } = req.query;

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
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              avgAmount: { $avg: '$amount' }
            }
          }
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
      console.error('Error in getIncomeReport:', error);
      next(error);
    }
  };

  /**
   * Get expenditure report with filters (scoped)
   * @route GET /api/reports/expenditure
   */
  getExpenditureReport = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { startDate, endDate, purpose, page = 1, limit = 50 } = req.query;

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
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
              count: { $sum: 1 },
              avgAmount: { $avg: '$amount' }
            }
          }
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
      console.error('Error in getExpenditureReport:', error);
      next(error);
    }
  };

  /**
   * Get member payment report (for specific member) – scoped to organization
   * @route GET /api/reports/member/:userId
   */
  getMemberPaymentReport = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { userId } = req.params;
      const { startDate, endDate } = req.query;

      // Ensure the target user belongs to the same organization (for non-super-admin)
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        const targetUser = await User.findOne({ _id: userId, organizationId });
        if (!targetUser) {
          return res.status(404).json({
            success: false,
            message: 'Member not found in your organization'
          });
        }
      }

      if (userRole !== 'super-admin' && userRole !== 'super_admin' && userRole !== 'admin' && req.user.id !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this report'
        });
      }

      const query = { user: userId };
      if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
        query.organizationId = organizationId;
      }

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
      console.error('Error in getMemberPaymentReport:', error);
      next(error);
    }
  };

  /**
   * Get monthly financial summary (for charts) – scoped
   * @route GET /api/reports/monthly-summary
   */
  getMonthlySummary = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { year = new Date().getFullYear() } = req.query;

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      let incomeMatch = { createdAt: { $gte: startDate, $lte: endDate } };
      let expenditureMatch = { createdAt: { $gte: startDate, $lte: endDate } };
      
      if (userRole !== 'super-admin' && userRole !== 'super_admin') {
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }
        incomeMatch.organizationId = new mongoose.Types.ObjectId(organizationId);
        expenditureMatch.organizationId = new mongoose.Types.ObjectId(organizationId);
      }

      const [monthlyIncome, monthlyExpenditure] = await Promise.all([
        Income.aggregate([
          { $match: incomeMatch },
          {
            $group: {
              _id: { $month: '$createdAt' },
              total: { $sum: '$amount' }
            }
          }
        ]),
        Expenditure.aggregate([
          { $match: expenditureMatch },
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
      console.error('Error in getMonthlySummary:', error);
      next(error);
    }
  };

  /**
   * Get detailed financial overview with trends
   * @route GET /api/reports/financial-overview
   */
  getFinancialOverview = async (req, res, next) => {
    try {
      const { period = 'month' } = req.query;
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      const validPeriods = ['week', 'month', 'year'];
      const safePeriod = validPeriods.includes(period) ? period : 'month';
      
      let startDate;
      const endDate = new Date();
      
      switch(safePeriod) {
        case 'week':
          startDate = new Date(endDate);
          startDate.setDate(endDate.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(endDate);
          startDate.setMonth(endDate.getMonth() - 1);
          break;
        case 'year':
          startDate = new Date(endDate);
          startDate.setFullYear(endDate.getFullYear() - 1);
          break;
        default:
          startDate = new Date(endDate);
          startDate.setMonth(endDate.getMonth() - 1);
      }
      
      const MAX_DATE_RANGE_DAYS = 730;
      const dateRangeDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
      if (dateRangeDays > MAX_DATE_RANGE_DAYS) {
        return res.status(400).json({
          success: false,
          message: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`
        });
      }
      
      let filter = { createdAt: { $gte: startDate, $lte: endDate } };
      if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
        filter.organizationId = new mongoose.Types.ObjectId(organizationId);
      }
      
      const [incomeData, expenditureData, topSources, topPurposes] = await Promise.all([
        Income.aggregate([
          { $match: filter },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Expenditure.aggregate([
          { $match: filter },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Income.aggregate([
          { $match: filter },
          { $group: { _id: '$source', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 5 }
        ]),
        Expenditure.aggregate([
          { $match: filter },
          { $group: { _id: '$purpose', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 5 }
        ])
      ]);
      
      res.status(200).json({
        success: true,
        data: {
          period: safePeriod,
          dateRange: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
          summary: {
            totalIncome: incomeData[0]?.total || 0,
            totalExpenditure: expenditureData[0]?.total || 0,
            netFlow: (incomeData[0]?.total || 0) - (expenditureData[0]?.total || 0),
            transactionCount: {
              income: incomeData[0]?.count || 0,
              expenditure: expenditureData[0]?.count || 0
            }
          },
          topSources,
          topPurposes
        }
      });
    } catch (error) {
      console.error('Financial overview error:', error);
      next(error);
    }
  };

  /**
   * Get member payment performance metrics
   * @route GET /api/reports/member-performance
   */
  getMemberPerformance = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      
      let filter = {};
      if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
        filter.organizationId = new mongoose.Types.ObjectId(organizationId);
      }
      
      const [totalMembers, paidMembers, outstandingTotals] = await Promise.all([
        User.countDocuments({ role: 'member', ...filter }),
        Payment.countDocuments({ type: 'registration', status: 'paid', ...filter }),
        Payment.aggregate([
          { $match: { status: 'unpaid', ...filter } },
          { $group: { _id: '$user', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 10 }
        ])
      ]);
      
      const topOutstanding = await Promise.all(
        outstandingTotals.map(async (item) => {
          const userFilter = { _id: item._id };
          if (organizationId && userRole !== 'super-admin' && userRole !== 'super_admin') {
            userFilter.organizationId = organizationId;
          }
          const user = await User.findOne(userFilter).select('name email');
          return { user, totalOutstanding: item.total };
        })
      );
      
      const paymentRate = totalMembers > 0 ? (paidMembers / totalMembers) * 100 : 0;
      
      res.status(200).json({
        success: true,
        data: {
          totalMembers,
          paidMembers,
          unpaidMembers: totalMembers - paidMembers,
          paymentRate: Math.round(paymentRate * 100) / 100,
          topOutstanding: topOutstanding.filter(item => item.user !== null),
          registrationFee: 500
        }
      });
    } catch (error) {
      console.error('Member performance error:', error);
      next(error);
    }
  };

  /**
   * Export report as CSV (scoped to organization)
   * @route GET /api/reports/export/:type
   */
  exportReport = async (req, res, next) => {
    try {
      const organizationId = this.getOrgId(req);
      const userRole = req.user.role;
      const { type } = req.params;
      const { startDate, endDate } = req.query;

      console.log('Export report - Type:', type, 'OrganizationId:', organizationId);

      let data = [];
      let headers = [];

      // Build query based on user role
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
        query.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      switch (type) {
        case 'income': {
          const incomes = await Income.find(query)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });

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
          const expenditures = await Expenditure.find(query)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });

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
          const payments = await Payment.find(query)
            .populate('user', 'name email')
            .sort({ createdAt: -1 });

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
          const membersQuery = { role: 'member' };
          if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
            membersQuery.organizationId = organizationId;
          }
          
          const members = await User.find(membersQuery)
            .select('-password')
            .sort({ createdAt: -1 });

          headers = ['Name', 'Email', 'Registration Date', 'Has Paid Registration'];

          const membersWithStatus = await Promise.all(members.map(async (member) => {
            let paymentQuery = { user: member._id, type: 'registration', status: 'paid' };
            if (userRole !== 'super-admin' && userRole !== 'super_admin' && organizationId) {
              paymentQuery.organizationId = organizationId;
            }
            
            const registrationPayment = await Payment.findOne(paymentQuery);

            return {
              'Name': member.name,
              'Email': member.email,
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
      const csvRows = [];
      csvRows.push(headers.join(','));

      for (const row of data) {
        const values = headers.map(header => {
          let value = row[header] || '';
          value = String(value).replace(/"/g, '""');
          if (value.includes(',') || value.includes('\n') || value.includes('"')) {
            value = `"${value}"`;
          }
          return value;
        });
        csvRows.push(values.join(','));
      }

      const csvContent = csvRows.join('\n');
      const filename = `${type}_report_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');

      res.status(200).send(csvContent);
    } catch (error) {
      console.error('Export error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to export report'
      });
    }
  };
}

// Create instance and export
const reportController = new ReportController();
module.exports = reportController;