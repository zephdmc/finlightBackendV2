const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, required: true, trim: true, unique: true, lowercase: true },

  // // Keep Paystack data for old records (optional, can be removed later)
  // paystack: {
  //   subaccountCode: { type: String, default: '' },
  //   bankName: { type: String, default: '' },
  //   accountNumber: { type: String, default: '' },
  //   percentageCharge: { type: Number, default: 0 }
  // },

  // NEW: Flutterwave subaccount details (used by the new payment gateway)
  flutterwave: {
    subaccountId: { type: String, default: '' },   // Required for split payments
    subaccountCode: { type: String, default: '' }, // Optional, for reference
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' }
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

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

organizationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Organization', organizationSchema);