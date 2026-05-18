const mongoose = require('mongoose');

const expenditureSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  purpose: {
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
  receipt: {
    type: String
  },
  // ✅ ADDED: Metadata for tracking fee-related expenditures
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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

// Indexes
expenditureSchema.index({ organizationId: 1, createdAt: -1 });
expenditureSchema.index({ organizationId: 1, createdBy: 1 });
expenditureSchema.index({ organizationId: 1, purpose: 1 }); // ✅ Added for fee filtering
expenditureSchema.index({ 'metadata.feeType': 1 }); // ✅ Added for fee type queries

expenditureSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Expenditure', expenditureSchema);