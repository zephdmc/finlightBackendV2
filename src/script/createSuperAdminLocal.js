const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Use local MongoDB (make sure MongoDB is running locally)
const MONGODB_URI = 'mongodb://localhost:27017/agfma';

// Models (defined inline to avoid path issues)
const organizationSchema = new mongoose.Schema({
  name: String,
  slug: { type: String, unique: true },
  paystack: { subaccountCode: String, bankName: String, accountNumber: String, percentageCharge: Number },
  createdAt: { type: Date, default: Date.now }
});
const Organization = mongoose.model('Organization', organizationSchema);

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['super_admin', 'admin', 'member'], default: 'member' },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
  createdAt: { type: Date, default: Date.now }
});
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});
const User = mongoose.model('User', userSchema);

async function init() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to local MongoDB');

    let platformOrg = await Organization.findOne({ slug: 'finlight' });
    if (!platformOrg) {
      platformOrg = await Organization.create({
        name: 'FinLight Platform',
        slug: 'finlight',
        paystack: { subaccountCode: 'PLATFORM_MASTER' }
      });
      console.log('🏢 Platform organization created');
    } else {
      console.log('🏢 Platform organization already exists');
    }

    const existingSuper = await User.findOne({ email: 'super@finlight.com' });
    if (!existingSuper) {
      const hashedPassword = await bcrypt.hash('SuperAdmin123!', 10);
      await User.create({
        name: 'Super Admin',
        email: 'super@finlight.com',
        password: hashedPassword,
        role: 'super_admin',
        organizationId: platformOrg._id
      });
      console.log('👑 Super admin created: super@finlight.com / SuperAdmin123!');
    } else {
      console.log('👑 Super admin already exists');
    }

    console.log('🎉 Done!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

init();
