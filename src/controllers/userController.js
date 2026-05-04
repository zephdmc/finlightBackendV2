const User = require('../models/User');
const Payment = require('../models/Payment');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

/**
 * User Controller - Handles all user management operations
 * Manages member registration, profile updates, and user listings
 */
class UserController {
  /**
   * Get all users (members only for non-admin)
   * @route GET /api/users
   * @access Private
   */
  async getAllUsers(req, res, next) {
    try {
      const { page = 1, limit = 20, role, search } = req.query;
      
      const query = {};
      
      // If not admin, only show members
      if (req.user.role !== 'admin') {
        query.role = 'member';
      } else if (role) {
        query.role = role;
      }
      
      // Search by name or email
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [users, total] = await Promise.all([
        User.find(query)
          .select('-password')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        User.countDocuments(query)
      ]);

      // Get payment status for members
      const usersWithPaymentStatus = await Promise.all(
        users.map(async (user) => {
          if (user.role === 'member') {
            const registrationPayment = await Payment.findOne({
              user: user._id,
              type: 'registration'
            });
            
            return {
              ...user.toObject(),
              registrationStatus: registrationPayment?.status || 'unpaid'
            };
          }
          return user.toObject();
        })
      );

      res.status(200).json({
        success: true,
        data: {
          records: usersWithPaymentStatus,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get single user by ID
   * @route GET /api/users/:id
   * @access Private
   */
  async getUserById(req, res, next) {
    try {
      const { id } = req.params;
      
      // Check authorization - user can only view themselves unless admin
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this user'
        });
      }

      const user = await User.findById(id).select('-password');
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Get user's payment records if member
      let payments = [];
      if (user.role === 'member') {
        payments = await Payment.find({ user: user._id })
          .sort({ createdAt: -1 });
      }

      res.status(200).json({
        success: true,
        data: {
          user,
          payments: payments.length > 0 ? payments : undefined
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Register new member (Admin only)
   * @route POST /api/users/register
   * @access Private/Admin
   */
  async registerMember(req, res, next) {
    // REMOVED TRANSACTIONS - Fixed version
    try {
      const { name, email, password, role = 'member' } = req.body;
      
      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists'
        });
      }

      // Create user (without transaction)
      const user = await User.create({
        name,
        email,
        password,
        role
      });

      // If member, create registration payment record (without transaction)
      if (role === 'member') {
        await Payment.create({
          user: user._id,
          type: 'registration',
          amount: 500, // Registration fee
          status: 'unpaid',
          dueDate: new Date(),
          description: 'Registration fee for new member'
        });
      }

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
          }
        },
        message: 'Member registered successfully'
      });
    } catch (error) {
      console.error('Registration error:', error);
      next(error);
    }
  }
/**
 * Update user profile
 * @route PUT /api/users/:id
 * @access Private
 */
async updateUser(req, res, next) {
    try {
      const { id } = req.params;
      const { name, email, password, role } = req.body;
      
      // Check authorization
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to update this user'
        });
      }
  
      const user = await User.findById(id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
  
      // Update fields
      if (name) user.name = name;
      if (email && req.user.role === 'admin') user.email = email;
      if (role && req.user.role === 'admin') user.role = role;
      if (password) {
        user.password = password; // Just assign - model's pre-save will hash it
      }
      
      await user.save();
  
      // Return user without password
      const userResponse = {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      };
  
      res.status(200).json({
        success: true,
        data: userResponse,
        message: 'User updated successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete user (Admin only)
   * @route DELETE /api/users/:id
   * @access Private/Admin
   */
  async deleteUser(req, res, next) {
    // REMOVED TRANSACTIONS - Fixed version
    try {
      const { id } = req.params;
      
      // Prevent admin from deleting themselves
      if (req.user.id === id) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete your own account'
        });
      }

      const user = await User.findById(id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Delete user and associated payments
      await User.findByIdAndDelete(id);
      await Payment.deleteMany({ user: id });

      res.status(200).json({
        success: true,
        message: 'User deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user statistics (Admin only)
   * @route GET /api/users/stats
   * @access Private/Admin
   */
  async getUserStats(req, res, next) {
    try {
      const [totalMembers, totalAdmins, registrationStats] = await Promise.all([
        User.countDocuments({ role: 'member' }),
        User.countDocuments({ role: 'admin' }),
        Payment.aggregate([
          { $match: { type: 'registration' } },
          { $group: {
            _id: '$status',
            count: { $sum: 1 }
          }}
        ])
      ]);

      const paidRegistrations = registrationStats.find(s => s._id === 'paid')?.count || 0;
      const unpaidRegistrations = registrationStats.find(s => s._id === 'unpaid')?.count || 0;

      res.status(200).json({
        success: true,
        data: {
          totalMembers,
          totalAdmins,
          registrationStatus: {
            paid: paidRegistrations,
            unpaid: unpaidRegistrations,
            total: totalMembers
          },
          registrationPercentage: totalMembers > 0 
            ? (paidRegistrations / totalMembers) * 100 
            : 0
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk import members (Admin only)
   * @route POST /api/users/bulk-import
   * @access Private/Admin
   */
  async bulkImportMembers(req, res, next) {
    // REMOVED TRANSACTIONS - Fixed version
    try {
      const { members } = req.body;
      
      if (!members || !Array.isArray(members) || members.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Please provide an array of members to import'
        });
      }

      const results = {
        successful: [],
        failed: []
      };

      for (const memberData of members) {
        try {
          const { name, email, password = 'default123' } = memberData;
          
          // Check if user exists
          const existingUser = await User.findOne({ email });
          if (existingUser) {
            results.failed.push({ email, reason: 'User already exists' });
            continue;
          }

          // Create user
          const user = await User.create({
            name,
            email,
            password,
            role: 'member'
          });

          // Create registration payment
          await Payment.create({
            user: user._id,
            type: 'registration',
            amount: 500,
            status: 'unpaid',
            dueDate: new Date()
          });

          results.successful.push({ id: user._id, name, email });
        } catch (error) {
          results.failed.push({ email: memberData.email, reason: error.message });
        }
      }

      res.status(200).json({
        success: true,
        data: results,
        message: `Imported ${results.successful.length} members successfully, ${results.failed.length} failed`
      });
    } catch (error) {
      next(error);
    }
  }

/**
 * Reset user password (Admin only)
 * @route POST /api/users/:id/reset-password
 * @access Private/Admin
 */
async resetPassword(req, res, next) {
    try {
      const { id } = req.params;
      const { newPassword } = req.body;
      
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters long'
        });
      }
  
      const user = await User.findById(id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
  
      // Just assign - let the model's pre-save middleware handle hashing
      user.password = newPassword;
      await user.save();
  
      res.status(200).json({
        success: true,
        message: 'Password reset successfully'
      });
    } catch (error) {
      next(error);
    }
  }
  /**
   * Get member payment summary (for dashboard)
   * @route GET /api/users/:id/payment-summary
   * @access Private
   */
  async getMemberPaymentSummary(req, res, next) {
    try {
      const { id } = req.params;
      
      // Check authorization
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this information'
        });
      }

      const payments = await Payment.find({ user: id });
      
      const summary = {
        totalPaid: 0,
        totalOutstanding: 0,
        registrationPaid: false,
        duesPaid: 0,
        finesPaid: 0,
        payments: []
      };

      payments.forEach(payment => {
        if (payment.status === 'paid') {
          summary.totalPaid += payment.amount || 0;
          if (payment.type === 'registration') summary.registrationPaid = true;
          if (payment.type === 'dues') summary.duesPaid += payment.amount || 0;
          if (payment.type === 'fine') summary.finesPaid += payment.amount || 0;
        } else {
          summary.totalOutstanding += payment.amount || 0;
        }
        
        summary.payments.push({
          id: payment._id,
          type: payment.type,
          amount: payment.amount,
          status: payment.status,
          dueDate: payment.dueDate,
          paidAt: payment.paidAt
        });
      });

      res.status(200).json({
        success: true,
        data: summary
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new UserController();