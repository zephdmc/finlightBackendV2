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
    comment: 'Total amount for all months in this transaction'
  },

  // ============================================================
  // MONTHS ARRAY - One document per transaction
  // ============================================================
  months: {
    type: [String],
    default: [],
    index: true,
    comment: 'Months covered by this transaction (e.g., ["2026-01", "2026-02"])'
  },
  monthCount: {
    type: Number,
    default: 0,
    comment: 'Number of months in this transaction'
  },
  monthlyPrice: {
    type: Number,
    default: 0,
    comment: 'Price per month (from PaymentType)'
  },

  // ==================== BILLING PERIOD FIELDS (Legacy Support) ====================
  periodStart: {
    type: Date,
    default: null,
    comment: 'Start of the billing period (e.g., 2026-08-01 for August)'
  },
  periodEnd: {
    type: Date,
    default: null,
    comment: 'End of the billing period (e.g., 2026-08-31 for August)'
  },
  periodKey: {
    type: String,
    default: null,
    index: true,
    comment: 'Human-readable period key (e.g., "2026-08", "2026-W34", "2026-Q3")'
  },

  transactionReference: {
    type: String,
    sparse: true
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
  originalAmount: {
    type: Number,
    default: 0,
    comment: 'Original amount from parent payment (for outstanding records)'
  },
  totalNetReceivedSoFar: {
    type: Number,
    default: 0,
    comment: 'Total net amount organization has received from all payments'
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
    transactionReference: {
      type: String,
      comment: 'Transaction reference for this partial payment'
    },
    fees: {
      flutterwaveFee: {
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
  actualAmountPaid: {
    type: Number,
    default: 0,
    comment: 'Actual amount paid by member'
  },
  flutterwaveFeeDeducted: {
    type: Number,
    default: 0,
    comment: 'Flutterwave processing fee (2%)'
  },
  platformFeeDeducted: {
    type: Number,
    default: 0,
    comment: 'Platform service fee (4%)'
  },
  netToOrganization: {
    type: Number,
    default: 0,
    comment: 'What organization actually received after all fees'
  },
  afterFlutterwaveAmount: {
    type: Number,
    default: 0,
    comment: 'Amount after Flutterwave fee deduction'
  },

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

// ==================== INDEXES ====================

// PRIMARY: Multi-tenant index for all queries
paymentSchema.index({ organizationId: 1, createdAt: -1 });

// User-specific queries
paymentSchema.index({ organizationId: 1, user: 1, status: 1 });
paymentSchema.index({ organizationId: 1, user: 1, status: 1, remainingAmount: 1 });

// Payment type queries
paymentSchema.index({ organizationId: 1, paymentTypeId: 1 });

// ============================================================
// NEW: Months array indexes for fast queries
// ============================================================
paymentSchema.index({ organizationId: 1, months: 1 });
paymentSchema.index({ organizationId: 1, user: 1, months: 1 });
paymentSchema.index({ organizationId: 1, paymentTypeId: 1, months: 1 });

// Period-based queries (legacy support)
paymentSchema.index({ organizationId: 1, periodKey: 1, status: 1 });
paymentSchema.index({ organizationId: 1, user: 1, periodKey: 1 });
paymentSchema.index({ organizationId: 1, paymentTypeId: 1, periodKey: 1 });

// Due date queries
paymentSchema.index({ organizationId: 1, status: 1, dueDate: 1 });

// Parent payment for partials
paymentSchema.index({ organizationId: 1, parentPaymentId: 1 });

// Fee tracking
paymentSchema.index({ organizationId: 1, isPartial: 1, status: 1 });
paymentSchema.index({ organizationId: 1, flutterwaveFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, platformFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, netToOrganization: 1 });

// ============================================================
// UNIQUE INDEX: Prevent duplicate transactions
// One member can have only ONE pending/unpaid transaction per payment type
// ============================================================
paymentSchema.index(
  {
    organizationId: 1,
    user: 1,
    paymentTypeId: 1,
    status: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['pending', 'unpaid'] },
      paymentTypeId: { $exists: true, $ne: null }
    },
    name: 'unique_active_payment_per_type'
  }
);

// Keep TTL index for auto-deleting pending payments
paymentSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 86400,
    partialFilterExpression: { status: 'pending' }
  }
);

// ==================== PRE-SAVE HOOKS ====================

paymentSchema.pre('save', function (next) {
  this.updatedAt = new Date();

  // Set monthCount from months array
  if (this.months && this.months.length > 0) {
    this.monthCount = this.months.length;
  }

  if (!this.targetOrgAmount && this.amount) {
    this.targetOrgAmount = this.amount;
  }

  if (!this.remainingAmount && this.amount) {
    this.remainingAmount = this.amount;
  }

  if (this.remainingAmount <= 0 && this.status !== 'paid') {
    this.status = 'paid';
    this.paidAt = this.paidAt || new Date();
  }

  if (this.totalPaidSoFar > 0 && this.remainingAmount > 0 && this.status !== 'partial') {
    this.status = 'partial';
  }

  // Auto-generate periodKey if periodStart is set but periodKey isn't
  if (this.periodStart && !this.periodKey) {
    this.periodKey = this.generatePeriodKey();
  }

  // If months array has data, generate a periodKey from first month
  if (this.months && this.months.length > 0 && !this.periodKey) {
    this.periodKey = this.months[0];
  }

  next();
});

// ==================== VIRTUAL FIELDS ====================

paymentSchema.virtual('percentagePaid').get(function () {
  if (!this.targetOrgAmount || this.targetOrgAmount === 0) return 0;
  return (this.totalPaidSoFar / this.targetOrgAmount) * 100;
});

paymentSchema.virtual('isFullyPaid').get(function () {
  return this.remainingAmount <= 0;
});

paymentSchema.virtual('hasOutstandingBalance').get(function () {
  return this.remainingAmount > 0 && this.status !== 'paid';
});

paymentSchema.virtual('totalFeesPaid').get(function () {
  return (this.flutterwaveFeeDeducted || 0) + (this.platformFeeDeducted || 0);
});

paymentSchema.virtual('periodDisplay').get(function () {
  if (this.months && this.months.length > 0) {
    return this.months.join(', ');
  }
  if (!this.periodStart) return 'One-time';
  if (this.periodKey) return this.periodKey;
  return 'Unknown';
});

paymentSchema.virtual('periodSummary').get(function () {
  if (this.months && this.months.length > 0) {
    return `${this.months.length} month(s)`;
  }
  if (!this.periodStart) return 'One-time';
  return this.periodStart.toLocaleDateString('default', {
    month: 'long',
    year: 'numeric'
  });
});

paymentSchema.virtual('isPeriodPayment').get(function () {
  return (this.months && this.months.length > 0) || (this.periodStart !== null && this.periodStart !== undefined);
});

// ============================================================
// NEW: Virtual to get months that are NOT paid (for partial)
// ============================================================
paymentSchema.virtual('unpaidMonths').get(function () {
  // This is a placeholder - actual unpaid months tracking
  // would require a separate model or field
  return [];
});

// ==================== INSTANCE METHODS ====================

/**
 * Generate a period key from periodStart and frequency
 * Examples: "2026-08", "2026-W34", "2026-Q3"
 */
paymentSchema.methods.generatePeriodKey = function () {
  if (!this.periodStart) return null;

  const date = new Date(this.periodStart);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');

  return `${year}-${month}`;
};

/**
 * Check if this payment belongs to a specific period
 */
paymentSchema.methods.belongsToPeriod = function (periodKey) {
  if (this.months && this.months.length > 0) {
    return this.months.includes(periodKey);
  }
  if (!this.periodKey) return false;
  return this.periodKey === periodKey;
};

/**
 * Check if this payment is for the current period
 */
paymentSchema.methods.isCurrentPeriod = function () {
  if (!this.periodStart) return false;

  const now = new Date();
  const currentPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return this.periodStart >= currentPeriodStart;
};

/**
 * Add partial payment (existing method - keep as is)
 */
paymentSchema.methods.addPartialPayment = function (partialData) {
  this.partialPayments = this.partialPayments || [];
  this.partialPayments.push({
    amount: partialData.amount,
    netToOrg: partialData.netToOrg,
    date: partialData.date || new Date(),
    transactionReference: partialData.transactionReference,
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
 * Get outstanding record (existing method - keep as is)
 */
paymentSchema.methods.getOutstandingRecord = async function () {
  return await mongoose.model('Payment').findOne({
    parentPaymentId: this._id,
    type: 'outstanding',
    status: 'unpaid'
  });
};

/**
 * Check if payment is payable (existing method - keep as is)
 */
paymentSchema.methods.isPayable = function () {
  return this.status !== 'paid' && (this.remainingAmount > 0);
};

// ============================================================
// NEW: Add months to this payment (for batch updates)
// ============================================================
paymentSchema.methods.addMonths = function (newMonths) {
  const existingMonths = this.months || [];
  const uniqueNewMonths = newMonths.filter(m => !existingMonths.includes(m));

  if (uniqueNewMonths.length === 0) {
    return { added: 0, total: existingMonths.length };
  }

  this.months = [...existingMonths, ...uniqueNewMonths];
  this.monthCount = this.months.length;
  this.amount = this.monthCount * this.monthlyPrice;
  this.targetOrgAmount = this.amount;
  this.expectedAmount = Math.ceil(this.amount / 0.96);
  this.remainingAmount = this.amount - (this.totalPaidSoFar || 0);
  this.status = 'pending';

  return { added: uniqueNewMonths.length, total: this.months.length };
};

// ==================== STATIC METHODS ====================

/**
 * Find outstanding payments by user (updated to support period filtering)
 */
paymentSchema.statics.findOutstandingByUser = function (userId, organizationId, options = {}) {
  const query = {
    user: userId,
    organizationId: organizationId,
    status: { $in: ['unpaid', 'partial'] },
    remainingAmount: { $gt: 0 }
  };

  if (options.periodKey) {
    query.months = options.periodKey;
  }

  if (options.fromDate) {
    query.periodStart = { $gte: options.fromDate };
  }
  if (options.toDate) {
    query.periodEnd = { $lte: options.toDate };
  }

  return this.find(query)
    .populate('paymentTypeId', 'name type frequency')
    .sort({ createdAt: -1 });
};

/**
 * Get total outstanding by user (updated with period support)
 */
paymentSchema.statics.getTotalOutstandingByUser = async function (userId, organizationId, options = {}) {
  const match = {
    user: mongoose.Types.ObjectId(userId),
    organizationId: mongoose.Types.ObjectId(organizationId),
    status: { $in: ['unpaid', 'partial'] },
    remainingAmount: { $gt: 0 }
  };

  if (options.periodKey) {
    match.months = options.periodKey;
  }

  const result = await this.aggregate([
    { $match: match },
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
 * Find partial payments by user (existing - keep as is)
 */
paymentSchema.statics.findPartialPaymentsByUser = function (userId, organizationId) {
  return this.find({
    user: userId,
    organizationId: organizationId,
    isPartial: true,
    status: 'partial'
  }).populate('paymentTypeId', 'name type').sort({ createdAt: -1 });
};

/**
 * Find payments for a specific period and payment type
 * Used by the billing scheduler to check if a payment already exists
 */
paymentSchema.statics.findPeriodPayment = function (organizationId, userId, paymentTypeId, periodKey) {
  return this.findOne({
    organizationId,
    user: userId,
    paymentTypeId,
    months: periodKey,
    status: { $in: ['unpaid', 'partial', 'paid'] }
  });
};

/**
 * Find or create a period payment (upsert pattern)
 * Used by the billing scheduler
 */
paymentSchema.statics.findOrCreatePeriodPayment = async function (data) {
  const {
    organizationId,
    user,
    paymentTypeId,
    periodStart,
    periodEnd,
    periodKey,
    name,
    type,
    amount,
    isMandatory
  } = data;

  let payment = await this.findOne({
    organizationId,
    user,
    paymentTypeId,
    months: periodKey
  });

  if (!payment) {
    payment = new this({
      organizationId,
      user,
      paymentTypeId,
      periodStart,
      periodEnd,
      periodKey,
      months: [periodKey],
      monthCount: 1,
      monthlyPrice: amount,
      name,
      type,
      amount,
      targetOrgAmount: amount,
      expectedAmount: amount,
      remainingAmount: amount,
      status: 'unpaid',
      dueDate: periodEnd || new Date()
    });
    await payment.save();
  }

  return payment;
};

/**
 * Get all unpaid period payments for a user
 */
paymentSchema.statics.getUnpaidPeriodPayments = function (userId, organizationId) {
  return this.find({
    user: userId,
    organizationId,
    status: 'unpaid',
    months: { $exists: true, $ne: [] }
  })
    .populate('paymentTypeId', 'name type frequency amount')
    .sort({ createdAt: 1 });
};

/**
 * Get payment history with period grouping
 */
paymentSchema.statics.getPaymentHistoryByPeriod = function (userId, organizationId) {
  return this.aggregate([
    {
      $match: {
        user: mongoose.Types.ObjectId(userId),
        organizationId: mongoose.Types.ObjectId(organizationId),
        months: { $exists: true, $ne: [] }
      }
    },
    {
      $unwind: '$months'
    },
    {
      $group: {
        _id: {
          periodKey: '$months',
          paymentTypeId: '$paymentTypeId'
        },
        payments: { $push: '$$ROOT' },
        totalAmount: { $sum: '$amount' },
        totalPaid: { $sum: '$totalPaidSoFar' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.periodKey': -1 } }
  ]);
};

// ============================================================
// NEW: Get dues summary for a user (all payments combined)
// ============================================================
paymentSchema.statics.getDuesSummary = async function (userId, organizationId) {
  const payments = await this.find({
    user: userId,
    organizationId: organizationId,
    type: { $in: ['dues', 'monthly_dues'] }
  });

  const paidMonths = [];
  const unpaidMonths = [];

  payments.forEach(p => {
    if (p.months && p.months.length > 0) {
      if (p.status === 'paid') {
        paidMonths.push(...p.months);
      } else {
        unpaidMonths.push(...p.months);
      }
    }
  });

  return {
    paidMonths: [...new Set(paidMonths)].sort(),
    unpaidMonths: [...new Set(unpaidMonths)].sort(),
    totalPaidMonths: paidMonths.length,
    totalUnpaidMonths: unpaidMonths.length,
    totalAmount: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    totalPaid: payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + (p.amount || 0), 0),
    payments: payments
  };
};

// ==================== POST HOOKS ====================

paymentSchema.post('save', function (doc) {
  if (doc.status === 'paid' && doc.paidAt) {
    console.log(`Payment ${doc._id} marked as paid at ${doc.paidAt}`);
  }
});

paymentSchema.post('remove', function (doc) {
  console.log(`Payment ${doc._id} removed for user ${doc.user}`);
});

module.exports = mongoose.model('Payment', paymentSchema);