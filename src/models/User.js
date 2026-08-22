const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  phoneNumber: {
    type: String,
    required: false,
    trim: true,
    match: [/^(\+234|0)[7-9][0-9]{9}$/, 'Please enter a valid Nigerian phone number (e.g., 08012345678 or +2348012345678)'],
    default: ''
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false
  },
  role: {
    type: String,
    enum: ['super-admin', 'super_admin', 'admin', 'member'],
    default: 'member'
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    // organizationId is NOT required for super admins
    required: function () {
      // Only require organizationId for non-super-admin users
      return this.role !== 'super-admin' && this.role !== 'super_admin';
    }
  },
  resetPasswordToken: {
    type: String,
    index: true,
    sparse: true
  },
  resetPasswordExpires: {
    type: Date
  },
  hasPaidRegistration: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
  },

  // ==================== BILLING FIELDS (NEW) ====================
  /**
   * When this member became eligible for recurring billing
   * If not set, defaults to createdAt date
   */
  billingStartDate: {
    type: Date,
    default: null,
    comment: 'Date when recurring billing should start for this member'
  },

  /**
   * Billing status for this member
   * - active: Normal billing
   * - paused: Temporarily skip billing
   * - suspended: No billing until reinstated
   * - exempt: Never bill this member
   */
  billingStatus: {
    type: String,
    enum: ['active', 'paused', 'suspended', 'exempt'],
    default: 'active',
    comment: 'Billing status for recurring payments'
  },

  /**
   * Optional: Override the organization's default billing cycle for this member
   * Useful if some members have special arrangements
   */
  billingCycleOverride: {
    type: String,
    enum: ['weekly', 'monthly', 'quarterly', 'yearly'],
    default: null,
    comment: 'Override the default billing cycle for this member'
  },

  /**
   * Optional: Custom amount override for this member
   * Useful for members with special rates
   */
  amountOverride: {
    type: Number,
    default: null,
    min: 0,
    comment: 'Custom amount for this member (overrides PaymentType amount)'
  },

  /**
   * Optional: Payment method preference
   */
  preferredPaymentMethod: {
    type: String,
    enum: ['flutterwave', 'bank_transfer', 'cash', 'manual'],
    default: 'flutterwave'
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

// Compound index for unique email per organization (only for non-super-admin)
// Super admins have null organizationId, so this ensures email uniqueness across orgs
userSchema.index({ email: 1, organizationId: 1 }, {
  unique: true,
  partialFilterExpression: { organizationId: { $exists: true, $ne: null } }
});

// Index for faster tenant-based queries
userSchema.index({ organizationId: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ phoneNumber: 1 }); // Added index for phone number lookups

// NEW: Index for billing queries
userSchema.index({ organizationId: 1, billingStatus: 1, isActive: 1 });
userSchema.index({ organizationId: 1, billingStartDate: 1 });
userSchema.index({ organizationId: 1, isActive: 1, billingStatus: 1, billingStartDate: 1 });

// ==================== VIRTUAL FIELDS ====================

/**
 * Check if member is eligible for billing
 */
userSchema.virtual('isBillingEligible').get(function () {
  // Super admins don't get billed
  if (this.role === 'super-admin' || this.role === 'super_admin') {
    return false;
  }

  // Must be active
  if (!this.isActive) {
    return false;
  }

  // Check billing status
  if (this.billingStatus === 'suspended' || this.billingStatus === 'exempt') {
    return false;
  }

  // Must have an organization
  if (!this.organizationId) {
    return false;
  }

  return true;
});

/**
 * Get the effective billing start date
 * Falls back to createdAt if billingStartDate is not set
 */
userSchema.virtual('effectiveBillingStartDate').get(function () {
  return this.billingStartDate || this.createdAt;
});

/**
 * Check if billing should run for this member
 */
userSchema.virtual('shouldBill').get(function () {
  if (!this.isBillingEligible) return false;
  if (this.billingStatus === 'paused') return false;
  if (this.billingStatus === 'suspended') return false;
  return true;
});

/**
 * Get billing status label
 */
userSchema.virtual('billingStatusLabel').get(function () {
  const labels = {
    'active': 'Active',
    'paused': 'Paused',
    'suspended': 'Suspended',
    'exempt': 'Exempt'
  };
  return labels[this.billingStatus] || this.billingStatus;
});

// ==================== INSTANCE METHODS ====================

/**
 * Check if this member should be billed for a specific payment type
 * @param {Object} paymentType - The payment type to check
 * @returns {boolean} - True if the member should be billed
 */
userSchema.methods.shouldBeBilledFor = function (paymentType) {
  // Check basic eligibility
  if (!this.isBillingEligible) return false;

  // Check if payment type is active and mandatory
  if (!paymentType.isActive) return false;
  if (!paymentType.is_mandatory) return false;

  // Check if payment type is recurring
  if (paymentType.frequency === 'one-time') return false;

  // If billing is paused, don't bill
  if (this.billingStatus === 'paused') return false;

  return true;
};

/**
 * Get the amount to bill for this member for a specific payment type
 * Uses amountOverride if set, otherwise uses payment type amount
 */
userSchema.methods.getBillingAmount = function (paymentType) {
  if (this.amountOverride !== null && this.amountOverride !== undefined) {
    return this.amountOverride;
  }
  return paymentType.amount;
};

/**
 * Get the billing frequency for this member
 * Uses billingCycleOverride if set, otherwise uses payment type frequency
 */
userSchema.methods.getBillingFrequency = function (paymentType) {
  if (this.billingCycleOverride) {
    return this.billingCycleOverride;
  }
  return paymentType.frequency;
};

/**
 * Check if member has a pending overdue payment
 * @param {Date} cutoffDate - Date to check against
 * @returns {Promise<boolean>} - True if member has overdue payments
 */
userSchema.methods.hasOverduePayments = async function (organizationId, cutoffDate) {
  const Payment = mongoose.model('Payment');
  const overdueCount = await Payment.countDocuments({
    user: this._id,
    organizationId: organizationId,
    status: { $in: ['unpaid', 'partial'] },
    remainingAmount: { $gt: 0 },
    dueDate: { $lt: cutoffDate || new Date() }
  });
  return overdueCount > 0;
};

/**
 * Pause billing for this member
 */
userSchema.methods.pauseBilling = async function () {
  this.billingStatus = 'paused';
  this.updatedAt = new Date();
  return this.save();
};

/**
 * Resume billing for this member
 */
userSchema.methods.resumeBilling = async function () {
  this.billingStatus = 'active';
  this.updatedAt = new Date();
  return this.save();
};

/**
 * Suspend billing for this member (more severe than pause)
 */
userSchema.methods.suspendBilling = async function () {
  this.billingStatus = 'suspended';
  this.updatedAt = new Date();
  return this.save();
};

/**
 * Exempt this member from billing entirely
 */
userSchema.methods.exemptFromBilling = async function () {
  this.billingStatus = 'exempt';
  this.updatedAt = new Date();
  return this.save();
};

/**
 * Get all members eligible for billing in an organization
 * @param {ObjectId} organizationId - The organization ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Array of eligible members
 */
userSchema.statics.getEligibleForBilling = function (organizationId, options = {}) {
  const query = {
    organizationId,
    isActive: true,
    billingStatus: 'active',
    role: { $nin: ['super-admin', 'super_admin'] }
  };

  // Optional: filter by billing start date
  if (options.fromDate) {
    query.$or = [
      { billingStartDate: { $gte: options.fromDate } },
      { createdAt: { $gte: options.fromDate } }
    ];
  }

  if (options.toDate) {
    query.billingStartDate = { ...query.billingStartDate, $lte: options.toDate };
  }

  return this.find(query)
    .select('name email phoneNumber billingStartDate amountOverride billingCycleOverride')
    .sort({ name: 1 });
};

/**
 * Get all members with overdue payments in an organization
 */
userSchema.statics.getWithOverduePayments = async function (organizationId, daysOverdue = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOverdue);

  const Payment = mongoose.model('Payment');

  // Get all users with overdue payments
  const overduePayments = await Payment.aggregate([
    {
      $match: {
        organizationId: mongoose.Types.ObjectId(organizationId),
        status: { $in: ['unpaid', 'partial'] },
        remainingAmount: { $gt: 0 },
        dueDate: { $lt: cutoffDate }
      }
    },
    {
      $group: {
        _id: '$user',
        totalOutstanding: { $sum: '$remainingAmount' },
        paymentCount: { $sum: 1 },
        oldestDueDate: { $min: '$dueDate' }
      }
    }
  ]);

  // Get user details for each
  const userIds = overduePayments.map(p => p._id);
  const users = await this.find({
    _id: { $in: userIds },
    organizationId
  }).select('name email phoneNumber');

  // Combine data
  return overduePayments.map(payment => {
    const user = users.find(u => u._id.toString() === payment._id.toString());
    return {
      ...payment,
      user
    };
  });
};

// ==================== PRE-SAVE HOOKS ====================

// Update updatedAt timestamp on save
userSchema.pre('save', function (next) {
  this.updatedAt = Date.now();

  // If billingStartDate is not set, set it to createdAt
  if (!this.billingStartDate && this.isNew) {
    this.billingStartDate = this.createdAt;
  }

  next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ==================== INSTANCE METHODS ====================

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);