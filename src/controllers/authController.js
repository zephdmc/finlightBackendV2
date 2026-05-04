const User = require('../models/User');
const Payment = require('../models/Payment');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  });
};
// @desc    Register user
// @route   POST /api/auth/register
// @access  Public (Admin only from frontend)
exports.register = async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { name, email, password, role } = req.body;
      
      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User already exists'
        });
      }
      
      // Check member registration limit (only for member role)
      if (role === 'member' || !role) {
        const memberCount = await User.countDocuments({ role: 'member' });
        
        // Set maximum member limit (can be configured via environment variable)
        const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS) || 25;
        
        if (memberCount >= MAX_MEMBERS) {
          return res.status(400).json({
            success: false,
            message: `Member registration limit reached. Maximum of ${MAX_MEMBERS} members allowed.`,
            data: {
              currentMembers: memberCount,
              maxMembers: MAX_MEMBERS
            }
          });
        }
      }
      
      // Create user
      const user = await User.create({
        name,
        email,
        password,
        role: role || 'member'
      });
      
      // If member, create registration payment record
      if (user.role === 'member') {
        await Payment.create({
          user: user._id,
          type: 'registration',
          amount: 500, // Registration fee
          status: 'unpaid'
        });
      }
      
      const token = generateToken(user._id);
      
      res.status(201).json({
        success: true,
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          hasPaidRegistration: user.hasPaidRegistration
        }
      });
    } catch (error) {
      next(error);
    }
  };

// @desc    Verify admin pin
// @route   POST /api/auth/verify-admin-pin
// @access  Private/Admin
exports.verifyAdminPin = async (req, res, next) => {
    try {
      const { pin } = req.body;
      
      // Get admin's stored pin (you should store this securely in the database)
      // For now, you can use environment variable
      const adminPin = process.env.ADMIN_PIN || '1234'; // Change this to a secure pin
      
      if (pin === adminPin) {
        res.status(200).json({
          success: true,
          message: 'PIN verified successfully'
        });
      } else {
        res.status(401).json({
          success: false,
          message: 'Invalid admin PIN'
        });
      }
    } catch (error) {
      next(error);
    }
  };

// // @desc    Login user
// // @route   POST /api/auth/login
// // @access  Public
// exports.login = async (req, res, next) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }
    
//     const { email, password } = req.body;
//     console.log(email,"hello")
//     // Check for user
//     const user = await User.findOne({ email }).select('+password');
//       if (!user) {
//         console.log(user)
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid credentials'
//       });
//     }
    
//     // Check password
//     const isMatch = await user.comparePassword(password);
//     if (!isMatch) {
//       return res.status(401).json({
//         success: false,
//         message: 'Invalid credentials'
//       });
//     }
    
//     const token = generateToken(user._id);
    
//     res.status(200).json({
//       success: true,
//       token,
//       user: {
//         id: user._id,
//         name: user.name,
//         email: user.email,
//         role: user.role,
//         hasPaidRegistration: user.hasPaidRegistration
//       }
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// @desc    Check member registration limit status
// @route   GET /api/auth/check-member-limit
// @access  Private/Admin
exports.checkMemberLimit = async (req, res, next) => {
    try {
      const memberCount = await User.countDocuments({ role: 'member' });
      const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS) || 25;
      const availableSlots = Math.max(0, MAX_MEMBERS - memberCount);
      const isFull = memberCount >= MAX_MEMBERS;
      
      res.status(200).json({
        success: true,
        data: {
          currentMembers: memberCount,
          maxMembers: MAX_MEMBERS,
          availableSlots: availableSlots,
          isFull: isFull,
          percentageFull: (memberCount / MAX_MEMBERS) * 100
        }
      });
    } catch (error) {
      next(error);
    }
  };
// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      
      const { email, password } = req.body;
      console.log("=== LOGIN ATTEMPT ===");
      console.log("Email:", email);
      console.log("Password length:", password?.length);
      
      // Check for user
      const user = await User.findOne({ email }).select('+password');
      console.log("User found:", user ? "Yes" : "No");
      
      if (!user) {
        console.log("User not found for email:", email);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }
      
      console.log("User password hash:", user.password);
      console.log("Password hash length:", user.password?.length);
      
      // Check password
      const isMatch = await user.comparePassword(password);
      console.log("Password match result:", isMatch);
      
      if (!isMatch) {
        console.log("Password mismatch for user:", email);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }
      
      const token = generateToken(user._id);
      
      res.status(200).json({
        success: true,
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        }
      });
    } catch (error) {
      console.error("Login error:", error);
      next(error);
    }
  };

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    
    res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    next(error);
  }
};