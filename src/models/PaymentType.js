const mongoose = require('mongoose');

/**
 * Payment Type Schema
 * Defines different types of payments that can be created (dues, wedding dues, charity, etc.)
 * Now supports multi-tenant: each organization has its own set of payment types.
 */
const PaymentTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Payment type name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters long'],
    maxlength: [100, 'Name cannot exceed 100 characters']
    // Note: unique constraint is now handled by compound index with organizationId
  },
  type: {
    type: String,
    required: [true, 'Payment type category is required'],
    enum: {
      values: ['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues'],
      message: 'Type must be one of: dues, leavy, registration, monthly_dues, wedding_dues, charity_dues'
    },
    default: 'dues',
    description: 'Category of payment (dues, leavy, registration, etc.)'
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters'],
    default: ''
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: [0, 'Amount cannot be negative'],
    validate: {
      validator: function (value) {
        return value > 0;
      },
      message: 'Amount must be greater than 0'
    }
  },
  is_mandatory: {
    type: Boolean,
    default: false,
    description: 'Whether this payment is mandatory for all members'
  },
  frequency: {
    type: String,
    enum: {
      values: ['one-time', 'weekly', 'monthly', 'quarterly', 'yearly'],
      message: 'Frequency must be one of: one-time, weekly, monthly, quarterly, yearly'
    },
    default: 'one-time'
  },
  duration_value: {
    type: Number,
    min: [1, 'Duration value must be at least 1'],
    validate: {
      validator: function (value) {
        if (this.frequency === 'one-time') return true;
        return value && value > 0;
      },
      message: 'Duration value is required for recurring payments'
    }
  },
  duration_unit: {
    type: String,
    enum: {
      values: ['days', 'weeks', 'months', 'years'],
      message: 'Duration unit must be one of: days, weeks, months, years'
    },
    validate: {
      validator: function (value) {
        if (this.frequency === 'one-time') return true;
        return value && ['days', 'weeks', 'months', 'years'].includes(value);
      },
      message: 'Duration unit is required for recurring payments'
    }
  },
  isActive: {
    type: Boolean,
    default: true,
    description: 'Whether this payment type is active and available for use'
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'Organization ID is required']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    description: 'Admin who created this payment type'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    description: 'Admin who last updated this payment type'
  },
  // ============================================================
  // LATE PAYMENT PENALTY FIELDS
  // ============================================================
  late_penalty_enabled: {
    type: Boolean,
    default: false,
    description: 'Whether late payment penalty applies'
  },
  late_penalty_type: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed',
    description: 'Fixed amount or percentage'
  },
  late_penalty_value: {
    type: Number,
    default: null,
    description: 'Penalty amount (fixed or percentage)'
  },
  late_penalty_days_after: {
    type: Number,
    default: 7,
    description: 'Days after due date when penalty applies'
  },
  due_date_after: {
    type: Number,
    default: 30,
    description: 'Days after creation when payment is due'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ============= INDEXES FOR MULTI-TENANCY =============
// Unique compound index: same payment type name cannot exist twice within one organization
PaymentTypeSchema.index({ organizationId: 1, name: 1 });

// Primary tenant filter index (most queries)
PaymentTypeSchema.index({ organizationId: 1, createdAt: -1 });

// Common query filters per organization
PaymentTypeSchema.index({ organizationId: 1, type: 1 });
PaymentTypeSchema.index({ organizationId: 1, is_mandatory: 1 });
PaymentTypeSchema.index({ organizationId: 1, frequency: 1 });
PaymentTypeSchema.index({ organizationId: 1, isActive: 1 });

// Composite indexes for combined filters
PaymentTypeSchema.index({ organizationId: 1, is_mandatory: 1, isActive: 1 });
PaymentTypeSchema.index({ organizationId: 1, frequency: 1, isActive: 1 });

// ============================================================
// NEW: Index for dues type queries
// ============================================================
PaymentTypeSchema.index({ organizationId: 1, type: 1, isActive: 1 });

// ============= VIRTUAL FIELDS WITH SAFETY CHECKS =============

// Virtual for formatted amount
PaymentTypeSchema.virtual('formattedAmount').get(function () {
  if (this.amount === undefined || this.amount === null) {
    return '₦0';
  }
  return `₦${this.amount.toLocaleString()}`;
});

// Virtual for schedule text
PaymentTypeSchema.virtual('scheduleText').get(function () {
  if (this.frequency === 'one-time') {
    return 'One-time payment';
  }
  if (!this.duration_value || !this.duration_unit) {
    return 'Recurring payment';
  }
  return `Every ${this.duration_value} ${this.duration_unit}`;
});

// Virtual for frequency label
PaymentTypeSchema.virtual('frequencyLabel').get(function () {
  if (!this.frequency) {
    return 'One Time';
  }
  const labels = {
    'one-time': 'One Time',
    'weekly': 'Weekly',
    'monthly': 'Monthly',
    'quarterly': 'Quarterly',
    'yearly': 'Yearly'
  };
  return labels[this.frequency] || this.frequency;
});

// Virtual for status label
PaymentTypeSchema.virtual('statusLabel').get(function () {
  if (this.isActive === undefined || this.isActive === null) {
    return 'Active';
  }
  return this.isActive ? 'Active' : 'Inactive';
});

// Virtual for type label (mandatory/optional)
PaymentTypeSchema.virtual('typeLabel').get(function () {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'Optional';
  }
  return this.is_mandatory ? 'Mandatory' : 'Optional';
});

// Virtual for type color
PaymentTypeSchema.virtual('typeColor').get(function () {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'green';
  }
  return this.is_mandatory ? 'red' : 'green';
});

// Virtual for category label
PaymentTypeSchema.virtual('categoryLabel').get(function () {
  if (!this.type) {
    return 'Dues';
  }
  const labels = {
    'dues': 'Dues',
    'leavy': 'Levy',
    'registration': 'Registration',
    'monthly_dues': 'Monthly Dues',
    'wedding_dues': 'Wedding Dues',
    'charity_dues': 'Charity Dues'
  };
  return labels[this.type] || this.type || 'Dues';
});

// ============================================================
// NEW: Virtual to check if this is a dues type (for display)
// ============================================================
PaymentTypeSchema.virtual('isDuesType').get(function () {
  return this.type === 'dues' || this.type === 'monthly_dues';
});

// ============================================================
// NEW: Virtual to get monthly price (for Payment model)
// ============================================================
PaymentTypeSchema.virtual('monthlyPrice').get(function () {
  return this.amount;
});

// ============= INSTANCE METHODS =============

/**
 * Calculate the next due date from a start date
 * IMPROVED: Handles month-end edge cases properly
 * 
 * @param {Date} startDate - The starting date (defaults to now)
 * @param {Object} options - Optional configuration
 * @param {boolean} options.endOfMonth - If true, returns end of month (for periodEnd)
 * @returns {Date|null} - The calculated next date or null if one-time
 */
PaymentTypeSchema.methods.calculateNextDueDate = function (startDate = new Date(), options = {}) {
  if (this.frequency === 'one-time') {
    return null;
  }
  if (!this.duration_value || !this.duration_unit) {
    return null;
  }

  const date = new Date(startDate);
  const { endOfMonth = false } = options;

  switch (this.duration_unit) {
    case 'days':
      date.setDate(date.getDate() + this.duration_value);
      break;
    case 'weeks':
      date.setDate(date.getDate() + (this.duration_value * 7));
      break;
    case 'months':
      const originalDay = date.getDate();
      date.setMonth(date.getMonth() + this.duration_value);
      if (date.getDate() !== originalDay) {
        // Keep the last day of the month
      }
      break;
    case 'years':
      date.setFullYear(date.getFullYear() + this.duration_value);
      break;
    default:
      return null;
  }

  if (endOfMonth && this.duration_unit === 'months') {
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    date.setDate(date.getDate() - 1);
  }

  return date;
};

/**
 * Get the billing period for a specific date
 * This is the core method for determining which period a payment belongs to
 * 
 * @param {Date} referenceDate - The date to calculate the period for
 * @returns {Object} - { periodStart, periodEnd, periodLabel }
 */
PaymentTypeSchema.methods.getPeriodForDate = function (referenceDate = new Date()) {
  if (this.frequency === 'one-time') {
    return {
      periodStart: null,
      periodEnd: null,
      periodLabel: 'One-time'
    };
  }

  const date = new Date(referenceDate);
  let periodStart = new Date(date);
  let periodEnd = new Date(date);
  let periodLabel = '';

  switch (this.frequency) {
    case 'weekly': {
      const day = date.getDay();
      const diff = day === 0 ? 6 : day - 1;
      periodStart.setDate(date.getDate() - diff);
      periodStart.setHours(0, 0, 0, 0);

      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 6);
      periodEnd.setHours(23, 59, 59, 999);

      const weekNumber = getWeekNumber(periodStart);
      periodLabel = `Week ${weekNumber}, ${periodStart.getFullYear()}`;
      break;
    }

    case 'monthly': {
      periodStart = new Date(date.getFullYear(), date.getMonth(), 1);
      periodStart.setHours(0, 0, 0, 0);

      periodEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      periodEnd.setHours(23, 59, 59, 999);

      periodLabel = periodStart.toLocaleString('default', {
        month: 'long',
        year: 'numeric'
      });
      break;
    }

    case 'quarterly': {
      const quarterMonth = Math.floor(date.getMonth() / 3) * 3;
      periodStart = new Date(date.getFullYear(), quarterMonth, 1);
      periodStart.setHours(0, 0, 0, 0);

      periodEnd = new Date(date.getFullYear(), quarterMonth + 3, 0);
      periodEnd.setHours(23, 59, 59, 999);

      const quarter = Math.floor(date.getMonth() / 3) + 1;
      periodLabel = `Q${quarter} ${date.getFullYear()}`;
      break;
    }

    case 'yearly': {
      periodStart = new Date(date.getFullYear(), 0, 1);
      periodStart.setHours(0, 0, 0, 0);

      periodEnd = new Date(date.getFullYear(), 11, 31);
      periodEnd.setHours(23, 59, 59, 999);

      periodLabel = `${date.getFullYear()}`;
      break;
    }

    default: {
      periodStart = null;
      periodEnd = null;
      periodLabel = 'One-time';
    }
  }

  return { periodStart, periodEnd, periodLabel };
};

/**
 * Get a simple period key for database storage
 * Example: "2026-08", "2026-W34", "2026-Q3"
 */
PaymentTypeSchema.methods.getPeriodKey = function (referenceDate = new Date()) {
  if (this.frequency === 'one-time') {
    return null;
  }

  const date = new Date(referenceDate);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');

  switch (this.frequency) {
    case 'weekly': {
      const weekNumber = getWeekNumber(date);
      return `${year}-W${String(weekNumber).padStart(2, '0')}`;
    }
    case 'monthly':
      return `${year}-${month}`;
    case 'quarterly': {
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return `${year}-Q${quarter}`;
    }
    case 'yearly':
      return `${year}`;
    default:
      return null;
  }
};

// ============================================================
// DUES-SPECIFIC METHODS (NEW)
// ============================================================

/**
 * Get the monthly price for this payment type
 * @returns {number} - The amount (price per month)
 */
PaymentTypeSchema.methods.getMonthlyPrice = function () {
  return this.amount;
};

/**
 * Check if this payment type should auto-generate recurring payments
 * Only dues types that are mandatory, active, and recurring
 * @returns {boolean} - True if should auto-generate
 */
PaymentTypeSchema.methods.shouldAutoGenerate = function () {
  return this.isActive &&
    this.is_mandatory &&
    this.frequency !== 'one-time' &&
    this.isDuesType
};

/**
 * Check if this payment type is recurring
 * Only dues types with frequency other than 'one-time'
 * @returns {boolean} - True if recurring
 */
PaymentTypeSchema.methods.isRecurring = function () {
  return this.frequency !== 'one-time' &&
    this.isActive &&
    this.isDuesType
};

/**
 * Check if this payment type is valid (all required fields present)
 * @returns {boolean} - True if valid
 */
PaymentTypeSchema.methods.isValid = function () {
  if (!this.isActive) return false;
  if (!this.name) return false;
  if (!this.type) return false;
  if (!this.amount || this.amount <= 0) return false;
  if (this.frequency !== 'one-time') {
    if (!this.duration_value || !this.duration_unit) return false;
  }
  return true;
};

// ============= STATIC METHODS (SCOPED BY ORGANIZATION) =============

PaymentTypeSchema.statics.getActiveTypes = function (organizationId) {
  return this.find({ organizationId, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getMandatoryTypes = function (organizationId) {
  return this.find({ organizationId, is_mandatory: true, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getOptionalTypes = function (organizationId) {
  return this.find({ organizationId, is_mandatory: false, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getByFrequency = function (organizationId, frequency) {
  return this.find({ organizationId, frequency, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getByCategory = function (organizationId, category) {
  return this.find({ organizationId, type: category, isActive: true }).sort({ createdAt: -1 });
};

// ============================================================
// UPDATED: Get active recurring payment types (ONLY DUES)
// ============================================================
PaymentTypeSchema.statics.getActiveRecurringTypes = function (organizationId) {
  return this.find({
    organizationId,
    isActive: true,
    frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] },
    type: { $in: ['dues', 'monthly_dues'] }  // Only dues!
  }).sort({ createdAt: -1 });
};

// ============================================================
// UPDATED: Get auto-generate types (ONLY DUES)
// ============================================================
PaymentTypeSchema.statics.getAutoGenerateTypes = function (organizationId) {
  return this.find({
    organizationId,
    isActive: true,
    is_mandatory: true,
    frequency: { $in: ['weekly', 'monthly', 'quarterly', 'yearly'] },
    type: { $in: ['dues', 'monthly_dues'] }  // Only dues!
  }).sort({ createdAt: -1 });
};

// ============================================================
// NEW: Get only dues types (both mandatory and optional)
// ============================================================
PaymentTypeSchema.statics.getDuesTypes = function (organizationId, includeInactive = false) {
  const query = {
    organizationId,
    type: { $in: ['dues', 'monthly_dues'] }
  };
  if (!includeInactive) {
    query.isActive = true;
  }
  return this.find(query).sort({ is_mandatory: -1, name: 1 });
};

// ============================================================
// NEW: Get mandatory dues types only
// ============================================================
PaymentTypeSchema.statics.getMandatoryDues = function (organizationId) {
  return this.find({
    organizationId,
    type: { $in: ['dues', 'monthly_dues'] },
    is_mandatory: true,
    isActive: true
  }).sort({ name: 1 });
};

// ============================================================
// NEW: Get optional dues types only
// ============================================================
PaymentTypeSchema.statics.getOptionalDues = function (organizationId) {
  return this.find({
    organizationId,
    type: { $in: ['dues', 'monthly_dues'] },
    is_mandatory: false,
    isActive: true
  }).sort({ name: 1 });
};

// ============= MIDDLEWARE =============

PaymentTypeSchema.pre('save', function (next) {
  if (this.frequency !== 'one-time') {
    if (!this.duration_value || !this.duration_unit) {
      next(new Error('Duration value and unit are required for recurring payments'));
    }
  }
  if (this.description === '') {
    this.description = undefined;
  }
  if (!this.type) {
    this.type = 'dues';
  }
  next();
});

PaymentTypeSchema.post('save', function (doc) {
  console.log(`Payment type created/updated: ${doc.name} (Org: ${doc.organizationId}, Category: ${doc.type})`);
});

PaymentTypeSchema.post('remove', function (doc) {
  console.log(`Payment type removed: ${doc.name} from organization ${doc.organizationId}`);
});

// ============= HELPER FUNCTIONS =============

/**
 * Get ISO week number (Monday-based)
 */
function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

module.exports = mongoose.model('PaymentType', PaymentTypeSchema);