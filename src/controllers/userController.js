// backend/src/controllers/UserController.js
const User = require('../models/User');
const Payment = require('../models/Payment');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { sendMemberWelcomeEmail } = require('../services/emailServiceBrevo');
const Organization = require('../models/Organization');
const { addToEmailQueue } = require('../services/emailQueue');
/**
 * User Controller - Handles all user management operations
 * Manages member registration, profile updates, and user listings
 * Now fully multi‑tenant: each user belongs to an organization (except super-admin)
 */
class UserController {
  /**
   * Helper: get organizationId from authenticated user
   * Returns null for super-admin (they have no organization restriction)
   */
  getOrgId(req) {
    // Super admin has no organization - they manage all organizations
    // Check for both possible role formats
    if (!req.user) return null;
    if (req.user.role === 'super-admin' || req.user.role === 'super_admin') {
      return null;
    }
    return req.user.organizationId;
  }

  /**
   * Helper: check if user can access this organization's data
   */
  async canAccessOrg(req, organizationId) {
    // Super admin can access any organization
    if (req.user.role === 'super-admin' || req.user.role === 'super_admin') {
      return true;
    }
    // Regular users can only access their own organization
    return req.user.organizationId && req.user.organizationId.toString() === organizationId.toString();
  }

  /**
   * Get all users (members only for non-admin) – scoped to organization
   * Super admin sees all users across all organizations
   * @route GET /api/users
   * @access Private
   */
  async getAllUsers(req, res, next) {
    try {
      const userRole = req.user.role;
      const { page = 1, limit = 20, role, search } = req.query;

      console.log('=== getAllUsers Debug ===');
      console.log('User Role:', userRole);
      console.log('OrganizationId:', req.user.organizationId);
      console.log('Query params:', { page, limit, role, search });

      let query = {};

      // Super admin sees all users
      if (userRole === 'super-admin' || userRole === 'super_admin') {
        console.log('Super admin - no organization filter');
        if (role) query.role = role;
      }
      // Regular admin sees only their organization's users
      else {
        const organizationId = req.user.organizationId;

        if (!organizationId) {
          console.error('No organizationId found for admin user');
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found for this user'
          });
        }

        query.organizationId = organizationId;
        console.log('Admin - filtering by organization:', organizationId.toString());

        // If not admin role (like member), only show members
        if (userRole !== 'admin') {
          query.role = 'member';
        } else if (role) {
          query.role = role;
        }
      }

      // Add search filter
      if (search && search.trim()) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phoneNumber: { $regex: search, $options: 'i' } } // Added phoneNumber search
        ];
        console.log('Search query:', search);
      }

      console.log('Final query:', JSON.stringify(query, null, 2));

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const limitNum = parseInt(limit);

      // Execute queries
      const [users, total] = await Promise.all([
        User.find(query)
          .select('-password')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        User.countDocuments(query)
      ]);

      console.log(`Found ${users.length} users out of ${total} total`);

      // Get payment status for members (only if needed)
      const usersWithPaymentStatus = await Promise.all(
        users.map(async (user) => {
          if (user.role === 'member') {
            const paymentQuery = { user: user._id, type: 'registration' };
            if (userRole !== 'super-admin' && userRole !== 'super_admin' && req.user.organizationId) {
              paymentQuery.organizationId = req.user.organizationId;
            }
            const registrationPayment = await Payment.findOne(paymentQuery).lean();

            return {
              ...user,
              phoneNumber: user.phoneNumber || '', // Added phoneNumber
              registrationStatus: registrationPayment?.status || 'unpaid',
              registrationAmount: registrationPayment?.amount || 500,
              registrationPaidAt: registrationPayment?.paidAt || null
            };
          }
          return {
            ...user,
            phoneNumber: user.phoneNumber || '' // Added phoneNumber
          };
        })
      );

      res.status(200).json({
        success: true,
        data: {
          records: usersWithPaymentStatus,
          pagination: {
            page: parseInt(page),
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
            hasNext: skip + limitNum < total,
            hasPrev: skip > 0
          }
        }
      });
    } catch (error) {
      console.error('Error in getAllUsers DETAILS:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch users',
        error: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }

  /**
   * Get single user by ID – scoped to organization
   * @route GET /api/users/:id
   * @access Private
   */
  getUserById = async (req, res, next) => {
    try {
      const { id } = req.params;
      const userRole = req.user.role;

      let user;
      if (userRole === 'super-admin' || userRole === 'super_admin') {
        user = await User.findById(id).select('-password');
      } else {
        const organizationId = this.getOrgId(req);
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        user = await User.findOne({ _id: id, organizationId }).select('-password');
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (userRole !== 'super-admin' && userRole !== 'super_admin' && userRole !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this user'
        });
      }

      let payments = [];
      if (user.role === 'member') {
        const paymentQuery = { user: user._id };
        if (userRole !== 'super-admin' && userRole !== 'super_admin' && req.user.organizationId) {
          paymentQuery.organizationId = req.user.organizationId;
        }
        payments = await Payment.find(paymentQuery).sort({ createdAt: -1 });
      }

      // Return user with phoneNumber
      res.status(200).json({
        success: true,
        data: {
          user: {
            ...user.toObject(),
            phoneNumber: user.phoneNumber || ''
          },
          payments: payments.length > 0 ? payments : undefined
        }
      });
    } catch (error) {
      console.error('Error in getUserById:', error);
      next(error);
    }
  };

  /**
   * Register new member (Admin only) – scoped to organization
   * @route POST /api/users/register
   * @access Private/Admin
   */
  registerMember = async (req, res, next) => {
    try {
      const userRole = req.user.role;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        return res.status(400).json({
          success: false,
          message: 'Super admin cannot create members directly. Please use the organization creation endpoint.'
        });
      }

      const organizationId = this.getOrgId(req);
      const { name, email, phoneNumber, password, role = 'member' } = req.body;

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this admin user'
        });
      }

      // Check if user exists within the same organization
      const existingUser = await User.findOne({ email, organizationId });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists in your organization'
        });
      }

      // Create user with phoneNumber
      const user = await User.create({
        name,
        email,
        phoneNumber: phoneNumber || '',
        password,
        role,
        organizationId
      });



      // Get organization name for the message
      const organization = await Organization.findById(organizationId);
      // const organizationName = organization ? organization.name : 'your organization';
      // ✅ QUEUE the email instead of sending directly
      const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
      addToEmailQueue({
        name: `member-welcome-${user._id}-${Date.now()}`,
        maxRetries: 5,
        retryDelay: 2000,
        task: async () => {
          await sendMemberWelcomeEmail(user.email, user.name, organization.name, loginUrl, password);
          console.log(`✅ Welcome email sent to ${user.email}`);
        }
      });


      // If member, create registration payment record
      if (role === 'member') {
        await Payment.create({
          user: user._id,
          name: `${name} - Registration Fee`,
          type: 'registration',
          amount: 500,
          status: 'unpaid',
          dueDate: new Date(),
          description: 'Registration fee for new member',
          organizationId
        });
      }




      // ✅ CORRECTED RESPONSE - No extra 'data' wrapper
      res.status(201).json({
        success: true,
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phoneNumber: user.phoneNumber || '',
          role: user.role,
          organizationId: user.organizationId,
          hasPaidRegistration: user.hasPaidRegistration
        },
        message: `${user.role === 'admin' ? 'Admin' : 'Member'} registered successfully!`
      });
    } catch (error) {
      console.error('Registration error:', error);
      next(error);
    }
  };

  /**
   * Update user profile – scoped to organization
   * @route PUT /api/users/:id
   * @access Private
   */
  async updateUser(req, res, next) {
    try {
      const { id } = req.params;
      const { name, email, phoneNumber, password, role } = req.body; // Added phoneNumber
      const userRole = req.user.role;

      let user;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        user = await User.findById(id);
      } else {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        user = await User.findOne({ _id: id, organizationId });
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (userRole !== 'super-admin' && userRole !== 'super_admin' && userRole !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to update this user'
        });
      }

      if (name) user.name = name;
      if (phoneNumber) user.phoneNumber = phoneNumber; // Added phoneNumber update
      if (email && (userRole === 'admin' || userRole === 'super-admin' || userRole === 'super_admin')) user.email = email;
      if (role && (userRole === 'admin' || userRole === 'super-admin' || userRole === 'super_admin')) user.role = role;
      if (password) user.password = password;

      await user.save();
      // Get organization name for the message
      const organization = await Organization.findById(user.organizationId);
      // const organizationName = organization ? organization.name : 'your organization';


      const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
      addToEmailQueue({
        name: `member-welcome-${user._id}-${Date.now()}`,
        maxRetries: 5,
        retryDelay: 2000,
        task: async () => {
          await sendMemberWelcomeEmail(user.email, user.name, organization.name, loginUrl, password);
          console.log(`✅ Welcome email sent to ${user.email}`);
        }
      });

      res.status(200).json({
        success: true,
        data: {
          id: user._id,
          name: user.name,
          email: user.email,
          phoneNumber: user.phoneNumber || '', // Added phoneNumber
          role: user.role
        },
        message: 'User updated successfully'
      });
    } catch (error) {
      console.error('Error in updateUser:', error);
      next(error);
    }
  }

  /**
   * Delete user – scoped to organization
   * @route DELETE /api/users/:id
   * @access Private/Admin
   */
  async deleteUser(req, res, next) {
    try {
      const { id } = req.params;
      const userRole = req.user.role;

      if (req.user.id === id) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete your own account'
        });
      }

      let user;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        user = await User.findById(id);
      } else {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        user = await User.findOne({ _id: id, organizationId });
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.role === 'super-admin' || user.role === 'super_admin') {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete super admin account'
        });
      }

      await User.findByIdAndDelete(id);
      await Payment.deleteMany({ user: id });

      res.status(200).json({
        success: true,
        message: 'User deleted successfully'
      });
    } catch (error) {
      console.error('Error in deleteUser:', error);
      next(error);
    }
  }

  /**
   * Get user statistics – scoped to organization
   * @route GET /api/users/stats
   * @access Private/Admin
   */
  async getUserStats(req, res, next) {
    try {
      const userRole = req.user.role;
      let statsQuery = {};
      let paymentMatch = { type: 'registration' };

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        statsQuery = {};
        paymentMatch = { type: 'registration' };
      } else {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        statsQuery = { organizationId };
        paymentMatch = { type: 'registration', organizationId: new mongoose.Types.ObjectId(organizationId) };
      }

      const [totalMembers, totalAdmins, registrationStats] = await Promise.all([
        User.countDocuments({ ...statsQuery, role: 'member' }),
        User.countDocuments({ ...statsQuery, role: 'admin' }),
        Payment.aggregate([
          { $match: paymentMatch },
          { $group: { _id: '$status', count: { $sum: 1 } } }
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
      console.error('Error in getUserStats:', error);
      next(error);
    }
  }

  /**
   * Bulk import members (Admin only) – scoped to organization
   * @route POST /api/users/bulk-import
   * @access Private/Admin
   */
  async bulkImportMembers(req, res, next) {
    try {
      const userRole = req.user.role;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        return res.status(400).json({
          success: false,
          message: 'Super admin cannot bulk import members. Please use the organization creation endpoint.'
        });
      }

      const organizationId = req.user.organizationId;
      const { members } = req.body;

      if (!members || !Array.isArray(members) || members.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Please provide an array of members to import'
        });
      }

      const results = { successful: [], failed: [] };

      for (const memberData of members) {
        try {
          const { name, email, phoneNumber, password = 'default123' } = memberData; // Added phoneNumber

          const existingUser = await User.findOne({ email, organizationId });
          if (existingUser) {
            results.failed.push({ email, reason: 'User already exists in this organization' });
            continue;
          }

          const user = await User.create({
            name,
            email,
            phoneNumber: phoneNumber || '', // Added phoneNumber
            password,
            role: 'member',
            organizationId
          });

          await Payment.create({
            user: user._id,
            type: 'registration',
            amount: 500,
            status: 'unpaid',
            dueDate: new Date(),
            organizationId
          });

          results.successful.push({ id: user._id, name, email, phoneNumber: phoneNumber || '' });
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
      console.error('Error in bulkImportMembers:', error);
      next(error);
    }
  }

  /**
   * Reset user password – scoped to organization
   * @route POST /api/users/:id/reset-password
   * @access Private/Admin
   */
  async resetPassword(req, res, next) {
    try {
      const { id } = req.params;
      const { newPassword } = req.body;
      const userRole = req.user.role;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters long'
        });
      }

      let user;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        user = await User.findById(id);
      } else {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        user = await User.findOne({ _id: id, organizationId });
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      user.password = newPassword;
      await user.save();

      res.status(200).json({
        success: true,
        message: 'Password reset successfully'
      });
    } catch (error) {
      console.error('Error in resetPassword:', error);
      next(error);
    }
  }

  /**
   * Get member payment summary (for dashboard) – scoped to organization
   * @route GET /api/users/:id/payment-summary
   * @access Private
   */
  async getMemberPaymentSummary(req, res, next) {
    try {
      const { id } = req.params;
      const userRole = req.user.role;

      let user;

      if (userRole === 'super-admin' || userRole === 'super_admin') {
        user = await User.findById(id);
      } else {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
          return res.status(400).json({
            success: false,
            message: 'Organization ID not found'
          });
        }
        user = await User.findOne({ _id: id, organizationId });
      }

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (userRole !== 'super-admin' && userRole !== 'super_admin' && userRole !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this information'
        });
      }

      const paymentQuery = { user: id };
      if (userRole !== 'super-admin' && userRole !== 'super_admin' && req.user.organizationId) {
        paymentQuery.organizationId = req.user.organizationId;
      }
      const payments = await Payment.find(paymentQuery);

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
      console.error('Error in getMemberPaymentSummary:', error);
      next(error);
    }
  }
}

module.exports = new UserController();