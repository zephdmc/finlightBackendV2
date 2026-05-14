// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    
    if (!token) {
      console.log('No token provided for:', req.method, req.url);
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Token decoded:', { id: decoded.id, role: decoded.role });
    
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      console.log('User not found for ID:', decoded.id);
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }
    
    console.log('User found:', { 
      id: user._id, 
      role: user.role, 
      organizationId: user.organizationId 
    });
    
    // For admin and member roles, organizationId is required
    // For super-admin, it's optional
    if (user.role !== 'super-admin' && user.role !== 'super_admin') {
      if (!user.organizationId) {
        console.log('User has no organizationId:', user.email);
        return res.status(401).json({
          success: false,
          message: 'User account not properly configured. Please contact support.'
        });
      }
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }
};

const roleCheck = (...roles) => {
  return (req, res, next) => {
    // Super admin has access to everything (check both formats)
    if (req.user.role === 'super-admin' || req.user.role === 'super_admin') {
      console.log('Super admin access granted for:', req.user.email);
      return next();
    }
    
    // Check if user's role is in the allowed roles
    if (!roles.includes(req.user.role)) {
      console.log(`Role check failed: ${req.user.role} not in [${roles.join(', ')}] for route: ${req.method} ${req.url}`);
      return res.status(403).json({
        success: false,
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    
    console.log(`Role check passed: ${req.user.role} authorized for route: ${req.method} ${req.url}`);
    next();
  };
};

module.exports = { protect, roleCheck };