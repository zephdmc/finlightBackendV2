// models/Organization.js
const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  slug: { type: String, required: true, unique: true },  // e.g., "agfma"
  paystack: {
    subaccountCode: { type: String, required: true },   // "ACCT_xxxxx"
    bankName: String,
    accountNumber: String,
    percentageCharge: { type: Number, default: 0 }       // optional split %
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Organization', organizationSchema);