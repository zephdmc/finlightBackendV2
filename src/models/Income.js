const mongoose = require('mongoose');

const incomeSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  // Add to Income schema
  type: {
    type: String,
    enum: ['manual', 'payment'],
    default: 'manual'
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paymentTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentType'
  },
  source: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'Organization ID is required']
  },
  reference: {
    type: String,
    unique: true,
    sparse: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
updatedBy: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User'
},
updatedAt: {
  type: Date
}

});

// Index for tenant-based queries (most common: get incomes for an organization)
incomeSchema.index({ organizationId: 1, createdAt: -1 });

// Index for filtering by organization and type (manual vs payment)
incomeSchema.index({ organizationId: 1, type: 1 });

// Index for looking up by paymentId within an organization
incomeSchema.index({ organizationId: 1, paymentId: 1 });

module.exports = mongoose.model('Income', incomeSchema);