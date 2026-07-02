const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  paymentTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentType',
    index: true
  },
  name: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['registration', 'dues', 'fine', 'monthly_dues', 'wedding_dues', 'charity_dues', 'leavy', 'outstanding'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
    comment: 'What organization should receive (target amount)'
  },

  // ==================== PARTIAL PAYMENT FIELDS ====================
  targetOrgAmount: {
    type: Number,
    default: 0,
    comment: 'Original target amount organization should receive'
  },
  expectedAmount: {
    type: Number,
    default: 0,
    comment: 'What member was expected to pay (includes fees)'
  },
  remainingAmount: {
    type: Number,
    default: 0,
    comment: 'Remaining balance for partial payments'
  },
  totalPaidSoFar: {
    type: Number,
    default: 0,
    comment: 'Total amount paid so far (sum of all partial payments)'
  },
  isPartial: {
    type: Boolean,
    default: false,
    comment: 'Whether this payment has partial payments'
  },
  parentPaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    default: null,
    comment: 'Original payment ID for partial payments'
  },
  partialPayments: [{
    amount: {
      type: Number,
      required: true,
      comment: 'Amount paid in this partial payment'
    },
    netToOrg: {
      type: Number,
      required: true,
      comment: 'Net amount organization received after fees'
    },
    date: {
      type: Date,
      default: Date.now,
      comment: 'Date of partial payment'
    },
    transactionReference1: {
      type: String,
      comment: 'Transaction reference for this partial payment'
    },
    fees: {
      flutterwaveFee: {   // changed from paystackFee
        type: Number,
        default: 0,
        comment: 'Flutterwave fee deducted (2%)'
      },
      platformFee: {
        type: Number,
        default: 0,
        comment: 'Platform fee deducted (4%)'
      },
      totalFees: {
        type: Number,
        default: 0,
        comment: 'Total fees deducted'
      }
    },
    notes: {
      type: String,
      default: '',
      comment: 'Optional notes for manual partial payments'
    }
  }],

  // Legacy fields for backward compatibility
  paidAmount: {
    type: Number,
    default: 0,
    comment: 'Legacy: Use totalPaidSoFar instead'
  },

  dueDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['paid', 'unpaid', 'pending', 'partial'],
    default: 'unpaid',
    comment: 'partial status indicates partially paid with outstanding balance'
  },
  cool: {
    type: String,
    enum: ['paid', 'unpaid', 'pendinge', 'partial'],
    default: 'unpaid',
    comment: 'partial status indicates partially paid with outstanding balance'
  },
  transactionReference1: {
    type: String,
    unique: true,
    sparse: true
  },
  paidAt: {
    type: Date
  },
  description: {
    type: String
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'Organization ID is required']
  },

  // ==================== FEE TRACKING FIELDS (Flutterwave) ====================
  // Actual amount paid by user (including fees)
  actualAmountPaid: {
    type: Number,
    default: 0,
    comment: 'Actual amount paid by member'
  },
  // Fee deducted by Flutterwave (2% flat)
  flutterwaveFeeDeducted: {   // renamed from paystackFeeDeducted
    type: Number,
    default: 0,
    comment: 'Flutterwave processing fee (2%)'
  },
  // Platform fee deducted (4% of total paid)
  platformFeeDeducted: {
    type: Number,
    default: 0,
    comment: 'Platform service fee (4%)'
  },
  // Net amount sent to organization after all fees
  netToOrganization: {
    type: Number,
    default: 0,
    comment: 'What organization actually received after all fees'
  },
  // Amount after Flutterwave fee before platform split
  afterFlutterwaveAmount: {   // renamed from afterPaystackAmount
    type: Number,
    default: 0,
    comment: 'Amount after Flutterwave fee deduction'
  },

  // Metadata for additional info
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
    comment: 'Additional metadata for tracking'
  },

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// ==================== PRE-SAVE HOOKS ====================

paymentSchema.pre('save', function (next) {
  this.updatedAt = new Date();

  // Auto-set targetOrgAmount if not set
  if (!this.targetOrgAmount && this.amount) {
    this.targetOrgAmount = this.amount;
  }

  // Auto-set remainingAmount if not set
  if (!this.remainingAmount && this.amount) {
    this.remainingAmount = this.amount;
  }

  // Set status to 'paid' when remainingAmount is 0
  if (this.remainingAmount <= 0 && this.status !== 'paid') {
    this.status = 'paid';
    this.paidAt = this.paidAt || new Date();
  }

  // Set status to 'partial' when partially paid
  if (this.totalPaidSoFar > 0 && this.remainingAmount > 0 && this.status !== 'partial') {
    this.status = 'partial';
  }

  next();
});

// ==================== VIRTUAL FIELDS ====================

// Virtual for percentage paid
paymentSchema.virtual('percentagePaid').get(function () {
  if (!this.targetOrgAmount || this.targetOrgAmount === 0) return 0;
  return (this.totalPaidSoFar / this.targetOrgAmount) * 100;
});

// Virtual for isFullyPaid
paymentSchema.virtual('isFullyPaid').get(function () {
  return this.remainingAmount <= 0;
});

// Virtual for hasOutstandingBalance
paymentSchema.virtual('hasOutstandingBalance').get(function () {
  return this.remainingAmount > 0 && this.status !== 'paid';
});

// Virtual for total fees paid (Flutterwave + platform)
paymentSchema.virtual('totalFeesPaid').get(function () {
  return (this.flutterwaveFeeDeducted || 0) + (this.platformFeeDeducted || 0);
});

// ==================== INSTANCE METHODS ====================

/**
 * Add a partial payment record
 */
paymentSchema.methods.addPartialPayment = function (partialData) {
  this.partialPayments = this.partialPayments || [];
  this.partialPayments.push({
    amount: partialData.amount,
    netToOrg: partialData.netToOrg,
    date: partialData.date || new Date(),
    transactionReference1: partialData.transactionReference1,
    fees: partialData.fees || {
      flutterwaveFee: 0,
      platformFee: 0,
      totalFees: 0
    },
    notes: partialData.notes || ''
  });

  this.totalPaidSoFar = (this.totalPaidSoFar || 0) + partialData.amount;
  this.remainingAmount = (this.targetOrgAmount || this.amount) - this.totalPaidSoFar;
  this.isPartial = this.remainingAmount > 0;

  if (this.remainingAmount <= 0) {
    this.status = 'paid';
    this.paidAt = new Date();
  } else {
    this.status = 'partial';
  }

  return this.save();
};

/**
 * Get outstanding payment record for this payment (if exists)
 */
paymentSchema.methods.getOutstandingRecord = async function () {
  return await mongoose.model('Payment').findOne({
    parentPaymentId: this._id,
    type: 'outstanding',
    status: 'unpaid'
  });
};

/**
 * Check if payment can be paid (not fully paid)
 */
paymentSchema.methods.isPayable = function () {
  return this.status !== 'paid' && (this.remainingAmount > 0);
};

// ==================== STATIC METHODS ====================

/**
 * Find all outstanding payments for a user
 */
paymentSchema.statics.findOutstandingByUser = function (userId, organizationId) {
  return this.find({
    user: userId,
    organizationId: organizationId,
    status: { $in: ['unpaid', 'partial'] },
    remainingAmount: { $gt: 0 }
  }).sort({ dueDate: 1, createdAt: 1 });
};

/**
 * Get total outstanding amount for a user
 */
paymentSchema.statics.getTotalOutstandingByUser = async function (userId, organizationId) {
  const result = await this.aggregate([
    {
      $match: {
        user: mongoose.Types.ObjectId(userId),
        organizationId: mongoose.Types.ObjectId(organizationId),
        status: { $in: ['unpaid', 'partial'] },
        remainingAmount: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$remainingAmount' }
      }
    }
  ]);

  return result.length > 0 ? result[0].total : 0;
};

/**
 * Find all partial payments for a user
 */
paymentSchema.statics.findPartialPaymentsByUser = function (userId, organizationId) {
  return this.find({
    user: userId,
    organizationId: organizationId,
    isPartial: true,
    status: 'partial'
  }).populate('paymentTypeId', 'name type').sort({ createdAt: -1 });
};

// ==================== INDEXES ====================

// Most common: fetch all payments for an organization, sorted by creation
paymentSchema.index({ organizationId: 1, createdAt: -1 });

// Filter by user within an organization
paymentSchema.index({ organizationId: 1, user: 1, status: 1 });

// Filter by payment type within an organization
paymentSchema.index({ organizationId: 1, paymentTypeId: 1 });

// Filter by status and due date (e.g., overdue payments)
paymentSchema.index({ organizationId: 1, status: 1, dueDate: 1 });

// For partial payment chains
paymentSchema.index({ organizationId: 1, parentPaymentId: 1 });

// For finding outstanding payments
paymentSchema.index({ organizationId: 1, user: 1, status: 1, remainingAmount: 1 });

// For finding partial payments
paymentSchema.index({ organizationId: 1, isPartial: 1, status: 1 });

// Fee tracking indexes (Flutterwave + platform)
paymentSchema.index({ organizationId: 1, flutterwaveFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, platformFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, netToOrganization: 1 });

// Transaction reference remains globally unique
paymentSchema.index({ transactionReference1: 1 }, { unique: true, sparse: true });

// Compound index for user outstanding queries
paymentSchema.index({ user: 1, organizationId: 1, status: 1, remainingAmount: 1 });


// Add TTL index to auto-delete pending payments after 24 hours
paymentSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 86400, // 24 hours
    partialFilterExpression: { status: 'pending' }
  }
);

module.exports = mongoose.model('Payment', paymentSchema);