// backend/src/controllers/reportsController.js
const User = require('../models/User');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');
const mongoose = require('mongoose');

// Helper to get organizationId from authenticated user
const getOrgId = (req) => req.user.organizationId;

// @desc    Get financial summary (scoped to organization)
// @route   GET /api/reports/summary
// @access  Private
exports.getSummary = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);

    const [totalIncome, totalExpenditure, totalMembers, unpaidPayments] = await Promise.all([
      Income.aggregate([
        { $match: { organizationId: orgObjectId } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Expenditure.aggregate([
        { $match: { organizationId: orgObjectId } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      User.countDocuments({ role: 'member', organizationId }),
      Payment.aggregate([
        { $match: { organizationId: orgObjectId, status: 'unpaid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const income = totalIncome[0]?.total || 0;
    const expenditure = totalExpenditure[0]?.total || 0;
    const outstanding = unpaidPayments[0]?.total || 0;
    const paidMembers = await Payment.countDocuments({
      type: 'registration',
      status: 'paid',
      organizationId
    });

    res.status(200).json({
      success: true,
      data: {
        totalIncome: income,
        totalExpenditure: expenditure,
        totalBalance: income - expenditure,
        totalMembers,
        outstandingPayments: outstanding,
        paidMembers
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get paid members report (scoped to organization)
// @route   GET /api/reports/paid-members
// @access  Private/Admin
exports.getPaidMembers = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const paidMembers = await Payment.find({
      type: 'registration',
      status: 'paid',
      organizationId
    })
      .populate('user', 'name email')
      .select('user paidAt');

    res.status(200).json({
      success: true,
      data: paidMembers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get outstanding payments report (scoped to organization)
// @route   GET /api/reports/outstanding
// @access  Private/Admin
exports.getOutstandingPayments = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const outstanding = await Payment.find({
      status: 'unpaid',
      organizationId
    })
      .populate('user', 'name email')
      .sort({ dueDate: 1 });

    res.status(200).json({
      success: true,
      data: outstanding
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get income report (scoped to organization)
// @route   GET /api/reports/income
// @access  Private/Admin
exports.getIncomeReport = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const { startDate, endDate } = req.query;

    const query = { organizationId };
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const incomes = await Income.find(query)
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });

    const total = incomes.reduce((sum, inc) => sum + inc.amount, 0);

    res.status(200).json({
      success: true,
      data: {
        total,
        records: incomes
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expenditure report (scoped to organization)
// @route   GET /api/reports/expenditure
// @access  Private/Admin
exports.getExpenditureReport = async (req, res, next) => {
  try {
    const organizationId = getOrgId(req);
    const { startDate, endDate } = req.query;

    const query = { organizationId };
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const expenditures = await Expenditure.find(query)
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });

    const total = expenditures.reduce((sum, exp) => sum + exp.amount, 0);

    res.status(200).json({
      success: true,
      data: {
        total,
        records: expenditures
      }
    });
  } catch (error) {
    next(error);
  }
};