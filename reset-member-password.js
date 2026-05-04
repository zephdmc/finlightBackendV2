// reset-member-password.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Your MongoDB connection string
const MONGODB_URI = 'mongodb://localhost:27017/agfma';

// Define schema
const userSchema = new mongoose.Schema({
  email: String,
  password: String,
  name: String,
  role: String
});

const User = mongoose.model('User', userSchema);

async function resetPassword() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected successfully!\n');
    
    const email = 'member@agfma.com';
    const newPassword = 'member123';
    
    // Generate new hash
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    console.log('New password hash:', hashedPassword);
    console.log('');
    
    // Update user
    const result = await User.updateOne(
      { email: email },
      { $set: { password: hashedPassword } }
    );
    
    if (result.modifiedCount > 0) {
      console.log('✅ Password reset successfully!\n');
      console.log('Email:', email);
      console.log('New Password:', newPassword);
      console.log('\nYou can now login with these credentials.');
    } else if (result.matchedCount > 0) {
      console.log('⚠️ User found but password was not modified (might be the same)');
    } else {
      console.log('❌ User not found with email:', email);
      console.log('\nAvailable users:');
      const users = await User.find({}, 'email name');
      users.forEach(u => console.log(`  - ${u.email} (${u.name})`));
    }
    
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

resetPassword();