// const mongoose = require('mongoose');

// const paymentSchema = new mongoose.Schema({
//   user: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true
//   },
//   paymentTypeId: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'PaymentType',
//     index: true
//   },
//   name: {
//     type: String,
//     required: true
//   },
//   type: {
//     type: String,
//     enum: ['registration', 'dues', 'fine', 'monthly_dues', 'wedding_dues', 'charity_dues', 'leavy'],
//     required: true
//   },
//   amount: {
//     type: Number,
//     required: true,
//     min: 0
//   },
//   expectedAmount: {
//     type: Number,
//     default: function() { return this.amount; }
//   },
//   paidAmount: {
//     type: Number,
//     default: 0
//   },
//   remainingAmount: {
//     type: Number,
//     default: function() { return this.amount; }
//   },
//   isPartial: {
//     type: Boolean,
//     default: false
//   },
//   parentPaymentId: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Payment',
//     default: null
//   },
//   dueDate: {
//     type: Date,
//     default: null
//   },
//   status: {
//     type: String,
//     enum: ['paid', 'unpaid', 'pending', 'partial'],
//     default: 'unpaid'
//   },
//   transactionReference: {
//     type: String,
//     unique: true,
//     sparse: true
//   },
//   paidAt: {
//     type: Date
//   },
//   description: {
//     type: String
//   },
//   organizationId: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Organization',
//     required: [true, 'Organization ID is required']
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now
//   }
// });

// // Indexes for multi-tenant queries
// // Most common: fetch all payments for an organization, sorted by creation
// paymentSchema.index({ organizationId: 1, createdAt: -1 });

// // Filter by user within an organization
// paymentSchema.index({ organizationId: 1, user: 1, status: 1 });

// // Filter by payment type within an organization
// paymentSchema.index({ organizationId: 1, paymentTypeId: 1 });

// // Filter by status and due date (e.g., overdue payments)
// paymentSchema.index({ organizationId: 1, status: 1, dueDate: 1 });

// // For partial payment chains
// paymentSchema.index({ organizationId: 1, parentPaymentId: 1 });

// // Keep existing indexes that are still useful, but scope them with organizationId where possible.
// // Note: transactionReference remains globally unique (fine as is).

// module.exports = mongoose.model('Payment', paymentSchema);


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
    enum: ['registration', 'dues', 'fine', 'monthly_dues', 'wedding_dues', 'charity_dues', 'leavy'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  expectedAmount: {
    type: Number,
    default: function() { return this.amount; }
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  remainingAmount: {
    type: Number,
    default: function() { return this.amount; }
  },
  isPartial: {
    type: Boolean,
    default: false
  },
  parentPaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    default: null
  },
  dueDate: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['paid', 'unpaid', 'pending', 'partial'],
    default: 'unpaid'
  },
  transactionReference: {
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
  
  // ==================== FEE TRACKING FIELDS ====================
  // Actual amount paid by user (after Paystack fee deduction)
  actualAmountPaid: {
    type: Number,
    default: 0
  },
  // Fee deducted by Paystack (1.5% + ₦100 for amounts ≥ ₦2,500)
  paystackFeeDeducted: {
    type: Number,
    default: 0
  },
  // Platform fee deducted (4% of after-Paystack amount)
  platformFeeDeducted: {
    type: Number,
    default: 0
  },
  // Net amount sent to organization after all fees
  netToOrganization: {
    type: Number,
    default: 0
  },
  // Amount after Paystack fee before platform split
  afterPaystackAmount: {
    type: Number,
    default: 0
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

// Update updatedAt on save
paymentSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

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

// Fee tracking indexes for reporting
paymentSchema.index({ organizationId: 1, paystackFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, platformFeeDeducted: 1 });
paymentSchema.index({ organizationId: 1, netToOrganization: 1 });

// Transaction reference remains globally unique
paymentSchema.index({ transactionReference: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Payment', paymentSchema);