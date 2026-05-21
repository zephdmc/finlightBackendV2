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
      validator: function(value) {
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
      values: ['one-time', 'monthly', 'quarterly', 'yearly'],
      message: 'Frequency must be one of: one-time, monthly, quarterly, yearly'
    },
    default: 'one-time'
  },
  duration_value: {
    type: Number,
    min: [1, 'Duration value must be at least 1'],
    validate: {
      validator: function(value) {
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
      validator: function(value) {
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

// ============= VIRTUAL FIELDS WITH SAFETY CHECKS =============

// Virtual for formatted amount
PaymentTypeSchema.virtual('formattedAmount').get(function() {
  if (this.amount === undefined || this.amount === null) {
    return '₦0';
  }
  return `₦${this.amount.toLocaleString()}`;
});

// Virtual for schedule text
PaymentTypeSchema.virtual('scheduleText').get(function() {
  if (this.frequency === 'one-time') {
    return 'One-time payment';
  }
  if (!this.duration_value || !this.duration_unit) {
    return 'Recurring payment';
  }
  return `Every ${this.duration_value} ${this.duration_unit}`;
});

// Virtual for frequency label
PaymentTypeSchema.virtual('frequencyLabel').get(function() {
  if (!this.frequency) {
    return 'One Time';
  }
  const labels = {
    'one-time': 'One Time',
    'monthly': 'Monthly',
    'quarterly': 'Quarterly',
    'yearly': 'Yearly'
  };
  return labels[this.frequency] || this.frequency;
});

// Virtual for status label
PaymentTypeSchema.virtual('statusLabel').get(function() {
  if (this.isActive === undefined || this.isActive === null) {
    return 'Active';
  }
  return this.isActive ? 'Active' : 'Inactive';
});

// Virtual for type label (mandatory/optional)
PaymentTypeSchema.virtual('typeLabel').get(function() {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'Optional';
  }
  return this.is_mandatory ? 'Mandatory' : 'Optional';
});

// Virtual for type color
PaymentTypeSchema.virtual('typeColor').get(function() {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'green';
  }
  return this.is_mandatory ? 'red' : 'green';
});

// Virtual for category label
PaymentTypeSchema.virtual('categoryLabel').get(function() {
  if (!this.type) {
    return 'Dues';
  }
  const labels = {
    'dues': 'Dues',
    'leavy': 'Leavy',
    'registration': 'Registration',
    'monthly_dues': 'Monthly Dues',
    'wedding_dues': 'Wedding Dues',
    'charity_dues': 'Charity Dues'
  };
  return labels[this.type] || this.type || 'Dues';
});

// ============= INSTANCE METHODS =============
PaymentTypeSchema.methods.calculateNextDueDate = function(startDate = new Date()) {
  if (this.frequency === 'one-time') {
    return null;
  }
  if (!this.duration_value || !this.duration_unit) {
    return null;
  }
  const date = new Date(startDate);
  switch(this.duration_unit) {
    case 'days':
      date.setDate(date.getDate() + this.duration_value);
      break;
    case 'weeks':
      date.setDate(date.getDate() + (this.duration_value * 7));
      break;
    case 'months':
      date.setMonth(date.getMonth() + this.duration_value);
      break;
    case 'years':
      date.setFullYear(date.getFullYear() + this.duration_value);
      break;
    default:
      return null;
  }
  return date;
};

PaymentTypeSchema.methods.isValid = function() {
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
PaymentTypeSchema.statics.getActiveTypes = function(organizationId) {
  return this.find({ organizationId, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getMandatoryTypes = function(organizationId) {
  return this.find({ organizationId, is_mandatory: true, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getOptionalTypes = function(organizationId) {
  return this.find({ organizationId, is_mandatory: false, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getByFrequency = function(organizationId, frequency) {
  return this.find({ organizationId, frequency, isActive: true }).sort({ createdAt: -1 });
};

PaymentTypeSchema.statics.getByCategory = function(organizationId, category) {
  return this.find({ organizationId, type: category, isActive: true }).sort({ createdAt: -1 });
};

// ============= MIDDLEWARE =============
PaymentTypeSchema.pre('save', function(next) {
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

PaymentTypeSchema.post('save', function(doc) {
  console.log(`Payment type created/updated: ${doc.name} (Org: ${doc.organizationId}, Category: ${doc.type})`);
});

PaymentTypeSchema.post('remove', function(doc) {
  console.log(`Payment type removed: ${doc.name} from organization ${doc.organizationId}`);
});

module.exports = mongoose.model('PaymentType', PaymentTypeSchema);