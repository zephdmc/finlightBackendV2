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
   * Get organizationId from authenticated user
   */
  getOrgId(req) {
    return req.user.organizationId;
  }

  /**
   * Get overall financial summary (scoped to organization)
   * @route GET /api/reports/summary
   */
  async getSummary(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const [totalIncome, totalExpenditure, totalMembers, unpaidPayments, paidMembers] = await Promise.all([
        Income.aggregate([
          { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Expenditure.aggregate([
          { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        User.countDocuments({ role: 'member', organizationId }),
        Payment.aggregate([
          { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), status: 'unpaid' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.countDocuments({ type: 'registration', status: 'paid', organizationId })
      ]);

      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      const outstanding = unpaidPayments[0]?.total || 0;

      // Get recent activity for dashboard (scoped)
      const recentTransactions = await this.getRecentTransactions(5, organizationId);

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
   * Get paid members report (scoped)
   * @route GET /api/reports/paid-members
   */
  async getPaidMembers(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { startDate, endDate, page = 1, limit = 50 } = req.query;

      const query = { type: 'registration', status: 'paid', organizationId };

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
   * Get outstanding payments report (scoped)
   * @route GET /api/reports/outstanding
   */
  async getOutstandingPayments(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { type, page = 1, limit = 50 } = req.query;

      const query = { status: 'unpaid', organizationId };
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
   * Get income report with filters (scoped)
   * @route GET /api/reports/income
   */
  async getIncomeReport(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { startDate, endDate, source, page = 1, limit = 50 } = req.query;

      const query = { organizationId };

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
      next(error);
    }
  }

  /**
   * Get expenditure report with filters (scoped)
   * @route GET /api/reports/expenditure
   */
  async getExpenditureReport(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { startDate, endDate, purpose, page = 1, limit = 50 } = req.query;

      const query = { organizationId };

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
      next(error);
    }
  }

  /**
   * Get member payment report (for specific member) – scoped to organization
   * @route GET /api/reports/member/:userId
   */
  async getMemberPaymentReport(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { userId } = req.params;
      const { startDate, endDate } = req.query;

      // Ensure the target user belongs to the same organization
      const targetUser = await User.findOne({ _id: userId, organizationId });
      if (!targetUser) {
        return res.status(404).json({
          success: false,
          message: 'Member not found in your organization'
        });
      }

      if (req.user.role !== 'admin' && req.user.id !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this report'
        });
      }

      const query = { user: userId, organizationId };

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
   * Get monthly financial summary (for charts) – scoped
   * @route GET /api/reports/monthly-summary
   */
  async getMonthlySummary(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { year = new Date().getFullYear() } = req.query;

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      const [monthlyIncome, monthlyExpenditure] = await Promise.all([
        Income.aggregate([
          {
            $match: {
              organizationId: new mongoose.Types.ObjectId(organizationId),
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
              organizationId: new mongoose.Types.ObjectId(organizationId),
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
   * Get recent transactions (helper method, now tenant-aware)
   * @param {number} limit
   * @param {string} organizationId
   */
  async getRecentTransactions(limit = 10, organizationId) {
    const [incomes, expenditures] = await Promise.all([
      Income.find({ organizationId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('createdBy', 'name'),
      Expenditure.find({ organizationId })
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
   * Export report as CSV (scoped to organization)
   * @route GET /api/reports/export/:type
   */
  async exportReport(req, res, next) {
    try {
      const organizationId = this.getOrgId(req);
      const { type } = req.params;
      const { startDate, endDate } = req.query;

      let data = [];
      let filename = '';
      let headers = [];

      // Build date filter scoped by organization
      const dateFilter = { organizationId };
      if (startDate && endDate) {
        dateFilter.createdAt = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }

      switch (type) {
        case 'income': {
          const incomes = await Income.find(dateFilter)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });

          filename = `income_report_${organizationId}_${new Date().toISOString().split('T')[0]}.csv`;
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
          const expenditures = await Expenditure.find(dateFilter)
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 });

          filename = `expenditure_report_${organizationId}_${new Date().toISOString().split('T')[0]}.csv`;
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
          const payments = await Payment.find(dateFilter)
            .populate('user', 'name email')
            .sort({ createdAt: -1 });

          filename = `payments_report_${organizationId}_${new Date().toISOString().split('T')[0]}.csv`;
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
          const members = await User.find({ role: 'member', organizationId })
            .select('-password')
            .sort({ createdAt: -1 });

          filename = `members_report_${organizationId}_${new Date().toISOString().split('T')[0]}.csv`;
          headers = ['Name', 'Email', 'Role', 'Registration Date', 'Has Paid Registration'];

          // Get payment status for each member (scoped)
          const membersWithStatus = await Promise.all(members.map(async (member) => {
            const registrationPayment = await Payment.findOne({
              user: member._id,
              type: 'registration',
              status: 'paid',
              organizationId
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

      csvRows.push(csvHeaders.join(','));

      for (const row of data) {
        const values = csvHeaders.map(header => {
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

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');

      res.status(200).send(csvContent);
    } catch (error) {
      console.error('Export error:', error);
      next(error);
    }
  }
}

module.exports = new ReportController();