const mongoose = require('mongoose');

/**
 * Payment Type Schema
 * Defines different types of payments that can be created (dues, wedding dues, charity, etc.)
 */
const PaymentTypeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Payment type name is required'],
    unique: true,
    trim: true,
    minlength: [2, 'Name must be at least 2 characters long'],
    maxlength: [100, 'Name cannot exceed 100 characters']
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

// Indexes for better query performance
PaymentTypeSchema.index({ name: 1 });
PaymentTypeSchema.index({ type: 1 });
PaymentTypeSchema.index({ is_mandatory: 1 });
PaymentTypeSchema.index({ frequency: 1 });
PaymentTypeSchema.index({ isActive: 1 });
PaymentTypeSchema.index({ createdAt: -1 });
PaymentTypeSchema.index({ is_mandatory: 1, isActive: 1 });
PaymentTypeSchema.index({ frequency: 1, isActive: 1 });

// ============= VIRTUAL FIELDS WITH SAFETY CHECKS =============

// Virtual for formatted amount - FIXED: Add safety check
PaymentTypeSchema.virtual('formattedAmount').get(function() {
  // Safety check for missing amount
  if (this.amount === undefined || this.amount === null) {
    return '₦0';
  }
  return `₦${this.amount.toLocaleString()}`;
});

// Virtual for schedule text - FIXED: Add safety check for duration fields
PaymentTypeSchema.virtual('scheduleText').get(function() {
  if (this.frequency === 'one-time') {
    return 'One-time payment';
  }
  // Safety check for missing duration fields
  if (!this.duration_value || !this.duration_unit) {
    return 'Recurring payment';
  }
  return `Every ${this.duration_value} ${this.duration_unit}`;
});

// Virtual for frequency label - FIXED: Add safety check
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

// Virtual for status label - FIXED: Add safety check
PaymentTypeSchema.virtual('statusLabel').get(function() {
  if (this.isActive === undefined || this.isActive === null) {
    return 'Active';
  }
  return this.isActive ? 'Active' : 'Inactive';
});

// Virtual for type label (mandatory/optional) - FIXED: Add safety check
PaymentTypeSchema.virtual('typeLabel').get(function() {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'Optional';
  }
  return this.is_mandatory ? 'Mandatory' : 'Optional';
});

// Virtual for type color - FIXED: Add safety check
PaymentTypeSchema.virtual('typeColor').get(function() {
  if (this.is_mandatory === undefined || this.is_mandatory === null) {
    return 'green';
  }
  return this.is_mandatory ? 'red' : 'green';
});

// Virtual for category label - FIXED: Add safety check
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

// Method to calculate next due date based on frequency
PaymentTypeSchema.methods.calculateNextDueDate = function(startDate = new Date()) {
  if (this.frequency === 'one-time') {
    return null;
  }
  
  // Safety check for missing duration fields
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

// Method to check if payment type is valid for use
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

// Static method to get active payment types
PaymentTypeSchema.statics.getActiveTypes = function() {
  return this.find({ isActive: true }).sort({ createdAt: -1 });
};

// Static method to get mandatory payment types
PaymentTypeSchema.statics.getMandatoryTypes = function() {
  return this.find({ is_mandatory: true, isActive: true }).sort({ createdAt: -1 });
};

// Static method to get optional payment types
PaymentTypeSchema.statics.getOptionalTypes = function() {
  return this.find({ is_mandatory: false, isActive: true }).sort({ createdAt: -1 });
};

// Static method to get types by frequency
PaymentTypeSchema.statics.getByFrequency = function(frequency) {
  return this.find({ frequency, isActive: true }).sort({ createdAt: -1 });
};

// Static method to get types by category
PaymentTypeSchema.statics.getByCategory = function(category) {
  return this.find({ type: category, isActive: true }).sort({ createdAt: -1 });
};

// Pre-save middleware
PaymentTypeSchema.pre('save', function(next) {
  // Ensure duration fields are present for recurring payments
  if (this.frequency !== 'one-time') {
    if (!this.duration_value || !this.duration_unit) {
      next(new Error('Duration value and unit are required for recurring payments'));
    }
  }
  
  // Clean up description if empty
  if (this.description === '') {
    this.description = undefined;
  }
  
  // Ensure type has a default if not provided
  if (!this.type) {
    this.type = 'dues';
  }
  
  next();
});

// Post-save middleware
PaymentTypeSchema.post('save', function(doc) {
  console.log(`Payment type created/updated: ${doc.name} (Category: ${doc.type})`);
});

// Post-remove middleware
PaymentTypeSchema.post('remove', function(doc) {
  console.log(`Payment type removed: ${doc.name}`);
});

module.exports = mongoose.model('PaymentType', PaymentTypeSchema);