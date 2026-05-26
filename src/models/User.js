const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  phoneNumber: {
    type: String,
    required: false,
    trim: true,
    match: [/^(\+234|0)[7-9][0-9]{9}$/, 'Please enter a valid Nigerian phone number (e.g., 08012345678 or +2348012345678)'],
    default: ''
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false
  },
  role: {
    type: String,
    enum: ['super-admin', 'super_admin', 'admin', 'member'],
    default: 'member'
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    // organizationId is NOT required for super admins
    required: function() {
      // Only require organizationId for non-super-admin users
      return this.role !== 'super-admin' && this.role !== 'super_admin';
    }
  },
  resetPasswordToken: {
    type: String,
    index: true,
    sparse: true
  },
  resetPasswordExpires: {
    type: Date
  },
  hasPaidRegistration: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
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

// Compound index for unique email per organization (only for non-super-admin)
// Super admins have null organizationId, so this ensures email uniqueness across orgs
userSchema.index({ email: 1, organizationId: 1 }, { 
  unique: true,
  partialFilterExpression: { organizationId: { $exists: true, $ne: null } }
});

// Index for faster tenant-based queries
userSchema.index({ organizationId: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ phoneNumber: 1 }); // Added index for phone number lookups

// Update updatedAt timestamp on save
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);