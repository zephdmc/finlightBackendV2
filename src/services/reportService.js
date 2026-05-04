const User = require('../models/User');
const Payment = require('../models/Payment');
const Income = require('../models/Income');
const Expenditure = require('../models/Expenditure');

// @desc    Get financial summary
// @route   GET /api/reports/summary
// @access  Private
exports.getSummary = async (req, res, next) => {
  try {
    const [totalIncome, totalExpenditure, totalMembers, unpaidPayments] = await Promise.all([
      Income.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expenditure.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
      User.countDocuments({ role: 'member' }),
      Payment.aggregate([
        { $match: { status: 'unpaid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
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
        outstandingPayments: outstanding,
        paidMembers: await Payment.countDocuments({ type: 'registration', status: 'paid' })
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get paid members report
// @route   GET /api/reports/paid-members
// @access  Private/Admin
exports.getPaidMembers = async (req, res, next) => {
  try {
    const paidMembers = await Payment.find({ type: 'registration', status: 'paid' })
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

// @desc    Get outstanding payments report
// @route   GET /api/reports/outstanding
// @access  Private/Admin
exports.getOutstandingPayments = async (req, res, next) => {
  try {
    const outstanding = await Payment.find({ status: 'unpaid' })
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

// @desc    Get income report
// @route   GET /api/reports/income
// @access  Private/Admin
exports.getIncomeReport = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    const query = {};
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

// @desc    Get expenditure report
// @route   GET /api/reports/expenditure
// @access  Private/Admin
exports.getExpenditureReport = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    const query = {};
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