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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient queries
paymentSchema.index({ user: 1, status: 1 });
paymentSchema.index({ type: 1, dueDate: 1 });
paymentSchema.index({ paymentTypeId: 1 });
paymentSchema.index({ parentPaymentId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);