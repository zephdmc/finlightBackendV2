const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Organization name is required'],
    trim: true,
    unique: true
  },
  slug: {
    type: String,
    required: [true, 'Organization slug is required'],
    trim: true,
    unique: true,
    lowercase: true
  },
  paystack: {
    subaccountCode: { type: String, default: '' },
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    percentageCharge: { type: Number, default: 0 }
  },
  settings: {
    registrationFee: { type: Number, default: 500 },
    currency: { type: String, default: 'NGN' },
    timezone: { type: String, default: 'Africa/Lagos' }
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended'],
    default: 'active'
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

// Update the updatedAt timestamp on save
organizationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Organization', organizationSchema);