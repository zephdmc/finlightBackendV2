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

// Index for tenant-based queries
expenditureSchema.index({ organizationId: 1, createdAt: -1 });

// Compound index for filtering by organization and createdBy
expenditureSchema.index({ organizationId: 1, createdBy: 1 });

module.exports = mongoose.model('Expenditure', expenditureSchema);