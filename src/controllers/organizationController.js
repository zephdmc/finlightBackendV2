// backend/src/controllers/organizationController.js
const Organization = require('../models/Organization');
const User = require('../models/User');
const mongoose = require('mongoose');

/**
 * Organization Controller (Super Admin only)
 */
class OrganizationController {
  /**
   * Helper: ensure user is super_admin (handles both formats)
   */
  requireSuperAdmin(req, res, next) {
    const isSuperAdmin = req.user?.role === 'super_admin' || 
                        req.user?.role === 'super-admin';
    
    if (!isSuperAdmin) {
      console.log(`Access denied. User role: ${req.user?.role}`);
      return res.status(403).json({ 
        success: false, 
        message: 'Super admin access required' 
      });
    }
    next();
  }

  /**
   * Get all organizations
   * @route GET /api/admin/organizations
   */
  async getAllOrganizations(req, res, next) {
    try {
      const organizations = await Organization.find().sort({ createdAt: -1 });
      
      // Get admin counts for each organization
      const orgsWithDetails = await Promise.all(
        organizations.map(async (org) => {
          const adminCount = await User.countDocuments({ 
            organizationId: org._id, 
            role: 'admin' 
          });
          
          const primaryAdmin = await User.findOne({ 
            organizationId: org._id, 
            role: 'admin' 
          }).select('name email');
          
          const memberCount = await User.countDocuments({ 
            organizationId: org._id, 
            role: 'member' 
          });
          
          return {
            ...org.toObject(),
            adminCount,
            memberCount,
            primaryAdmin: primaryAdmin || null
          };
        })
      );
      
      res.status(200).json({ 
        success: true, 
        data: orgsWithDetails 
      });
    } catch (error) {
      console.error('Error in getAllOrganizations:', error);
      res.status(500).json({ 
        success: false, 
        message: error.message || 'Failed to fetch organizations' 
      });
    }
  }

  /**
   * Create a new organization (NO TRANSACTIONS - for standalone MongoDB)
   * @route POST /api/admin/organizations
   */
  async createOrganization(req, res, next) {
    try {
      const { name, slug, paystack, adminEmail, adminName, adminPassword } = req.body;

      // Validation
      if (!name || !slug) {
        return res.status(400).json({ 
          success: false, 
          message: 'Name and slug are required' 
        });
      }

      // Check if slug already exists
      const existingOrg = await Organization.findOne({ slug });
      if (existingOrg) {
        return res.status(400).json({ 
          success: false, 
          message: 'Organization slug already exists' 
        });
      }

      // Create organization
      const organization = new Organization({
        name,
        slug,
        paystack: {
          subaccountCode: paystack?.subaccountCode || '',
          bankName: paystack?.bankName || '',
          accountNumber: paystack?.accountNumber || '',
          percentageCharge: paystack?.percentageCharge || 0
        }
      });
      
      const savedOrg = await organization.save();

      let adminUser = null;
      
      // Create admin user if details provided
      if (adminEmail && adminName && adminPassword) {
        // Check if email already exists
        const existingUser = await User.findOne({ email: adminEmail });
        if (existingUser) {
          // If organization was created but admin email exists, we should delete the org
          await Organization.findByIdAndDelete(savedOrg._id);
          return res.status(400).json({ 
            success: false, 
            message: 'Admin email already registered' 
          });
        }
        
        // Create admin user
        adminUser = new User({
          name: adminName,
          email: adminEmail,
          password: adminPassword,
          role: 'admin',
          organizationId: savedOrg._id,
          hasPaidRegistration: true,
          hasCompletedRegistration: true,
          isActive: true
        });
        
        await adminUser.save();
      }

      res.status(201).json({
        success: true,
        data: {
          organization: savedOrg,
          admin: adminUser ? {
            id: adminUser._id,
            name: adminUser.name,
            email: adminUser.email
          } : null
        },
        message: 'Organization created successfully'
      });
    } catch (error) {
      console.error('Error in createOrganization:', error);
      res.status(500).json({ 
        success: false, 
        message: error.message || 'Failed to create organization' 
      });
    }
  }

  /**
   * Update organization
   * @route PUT /api/admin/organizations/:id
   */
  async updateOrganization(req, res, next) {
    try {
      const { id } = req.params;
      const { name, slug, paystack } = req.body;

      const updateData = {};
      if (name) updateData.name = name;
      if (slug) updateData.slug = slug;
      if (paystack) updateData.paystack = paystack;

      const organization = await Organization.findByIdAndUpdate(
        id,
        updateData,
        { new: true, runValidators: true }
      );
      
      if (!organization) {
        return res.status(404).json({ 
          success: false, 
          message: 'Organization not found' 
        });
      }
      
      res.status(200).json({ 
        success: true, 
        data: organization,
        message: 'Organization updated successfully'
      });
    } catch (error) {
      console.error('Error in updateOrganization:', error);
      res.status(500).json({ 
        success: false, 
        message: error.message || 'Failed to update organization' 
      });
    }
  }

  /**
   * Delete organization (NO TRANSACTIONS - for standalone MongoDB)
   * @route DELETE /api/admin/organizations/:id
   */
  async deleteOrganization(req, res, next) {
    try {
      const { id } = req.params;

      // Delete all users belonging to this organization
      await User.deleteMany({ organizationId: id });
      
      // Delete organization
      const organization = await Organization.findByIdAndDelete(id);
      
      if (!organization) {
        return res.status(404).json({ 
          success: false, 
          message: 'Organization not found' 
        });
      }
      
      res.status(200).json({ 
        success: true, 
        message: 'Organization deleted successfully' 
      });
    } catch (error) {
      console.error('Error in deleteOrganization:', error);
      res.status(500).json({ 
        success: false, 
        message: error.message || 'Failed to delete organization' 
      });
    }
  }

// Add to your OrganizationController class

/**
 * Update organization status (active/inactive/suspended)
 * @route PATCH /api/organizations/:id/status
 */
async updateOrganizationStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    
    const organization = await Organization.findById(id);
    
    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }
    
    organization.status = status;
    organization.updatedAt = new Date();
    
    if (reason) {
      organization.statusChangeReason = reason;
      organization.statusChangedBy = req.user.id;
    }
    
    await organization.save();
    
    // Update all users in this organization if suspending/activating
    if (status === 'suspended') {
      await User.updateMany(
        { organizationId: id },
        { isActive: false, suspendedAt: new Date(), suspendedBy: req.user.id }
      );
    } else if (status === 'active') {
      await User.updateMany(
        { organizationId: id },
        { isActive: true, $unset: { suspendedAt: "", suspendedBy: "" } }
      );
    }
    
    res.status(200).json({
      success: true,
      data: {
        id: organization._id,
        name: organization.name,
        status: organization.status,
        updatedAt: organization.updatedAt
      },
      message: `Organization ${status === 'active' ? 'activated' : status === 'inactive' ? 'deactivated' : 'suspended'} successfully`
    });
  } catch (error) {
    console.error('Error updating organization status:', error);
    next(error);
  }
}

/**
 * Get organization statistics summary (Super Admin)
 * @route GET /api/organizations/stats/summary
 */
async getOrganizationStats(req, res, next) {
  try {
    const [totalOrganizations, activeOrganizations, suspendedOrganizations, totalAdmins, totalMembers, totalRevenue] = await Promise.all([
      Organization.countDocuments(),
      Organization.countDocuments({ status: 'active' }),
      Organization.countDocuments({ status: 'suspended' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'member' }),
      require('../models/Payment').aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        totalOrganizations,
        activeOrganizations,
        inactiveOrganizations: totalOrganizations - activeOrganizations - suspendedOrganizations,
        suspendedOrganizations,
        totalAdmins,
        totalMembers,
        totalRevenue: totalRevenue[0]?.total || 0,
        lastUpdated: new Date()
      }
    });
  } catch (error) {
    console.error('Error fetching organization stats:', error);
    next(error);
  }
}

/**
 * Get organization by ID with enhanced data
 * @route GET /api/organizations/:id
 */
async getOrganizationById(req, res, next) {
  try {
    const { id } = req.params;
    
    const organization = await Organization.findById(id);
    
    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }
    
    const [admins, memberCount, recentPayments, recentTransactions] = await Promise.all([
      User.find({ organizationId: id, role: 'admin' }).select('name email createdAt'),
      User.countDocuments({ organizationId: id, role: 'member' }),
      require('../models/Payment').find({ organizationId: id }).sort({ createdAt: -1 }).limit(10),
      require('../models/Income').find({ organizationId: id }).sort({ createdAt: -1 }).limit(5)
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        ...organization.toObject(),
        adminCount: admins.length,
        admins: admins.slice(0, 20),
        memberCount,
        recentPayments,
        recentTransactions
      }
    });
  } catch (error) {
    console.error('Error fetching organization:', error);
    next(error);
  }
}


  /**
   * Get organization settings for the logged-in admin
   * @route GET /api/organizations/settings
   * @access Private/Admin
   */
  async getOrganizationSettings(req, res, next) {
    try {
      const organizationId = req.user.organizationId;
      
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this user'
        });
      }

      const organization = await Organization.findById(organizationId);
      
      if (!organization) {
        return res.status(404).json({
          success: false,
          message: 'Organization not found'
        });
      }

      // Get stats
      const adminCount = await User.countDocuments({
        organizationId: organizationId,
        role: 'admin'
      });
      
      const memberCount = await User.countDocuments({
        organizationId: organizationId,
        role: 'member'
      });

      res.status(200).json({
        success: true,
        data: {
          ...organization.toObject(),
          adminCount,
          memberCount
        }
      });
    } catch (error) {
      console.error('Error getting organization settings:', error);
      next(error);
    }
  }

 /**
   * Update organization settings (bank details, paystack, etc.)
   * @route PUT /api/organizations/settings
   * @access Private/Admin
   */
 async updateOrganizationSettings(req, res, next) {
  try {
    const organizationId = req.user.organizationId;
    const { paystack, settings } = req.body;
    
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: 'Organization ID not found for this user'
      });
    }

    const updateData = {};
    if (paystack) updateData.paystack = paystack;
    if (settings) updateData.settings = settings;
    updateData.updatedAt = new Date();

    const organization = await Organization.findByIdAndUpdate(
      organizationId,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    res.status(200).json({
      success: true,
      data: organization,
      message: 'Organization settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating organization settings:', error);
    next(error);
  }
}

 /**
   * Update bank details for organization
   * @route PUT /api/organizations/bank-details
   * @access Private/Admin
   */
 async updateBankDetails(req, res, next) {
  try {
    const organizationId = req.user.organizationId;
    const { bankName, accountNumber, accountName, subaccountCode } = req.body;
    
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        message: 'Organization ID not found for this user'
      });
    }

    // Validate bank details
    if (!bankName && !accountNumber && !subaccountCode) {
      return res.status(400).json({
        success: false,
        message: 'At least one field is required to update'
      });
    }

    const updateData = {
      paystack: {}
    };
    
    if (bankName) updateData.paystack.bankName = bankName;
    if (accountNumber) updateData.paystack.accountNumber = accountNumber;
    if (accountName) updateData.paystack.accountName = accountName;
    if (subaccountCode) updateData.paystack.subaccountCode = subaccountCode;
    
    updateData.updatedAt = new Date();

    const organization = await Organization.findByIdAndUpdate(
      organizationId,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    
    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        bankName: organization.paystack?.bankName,
        accountNumber: organization.paystack?.accountNumber,
        subaccountCode: organization.paystack?.subaccountCode
      },
      message: 'Bank details updated successfully'
    });
  } catch (error) {
    console.error('Error updating bank details:', error);
    next(error);
  }
}

  
  /**
   * Get single organization by ID
   * @route GET /api/admin/organizations/:id
   */
  async getOrganizationById(req, res, next) {
    try {
      const { id } = req.params;
      
      const organization = await Organization.findById(id);
      
      if (!organization) {
        return res.status(404).json({ 
          success: false, 
          message: 'Organization not found' 
        });
      }
      
      // Get admins for this organization
      const admins = await User.find({ 
        organizationId: id, 
        role: 'admin' 
      }).select('name email');
      
      const memberCount = await User.countDocuments({ 
        organizationId: id, 
        role: 'member' 
      });
      
      res.status(200).json({
        success: true,
        data: {
          ...organization.toObject(),
          admins,
          memberCount
        }
      });
    } catch (error) {
      console.error('Error fetching organization:', error);
      res.status(500).json({ 
        success: false, 
        message: error.message || 'Failed to fetch organization' 
      });
    }
  }
}

module.exports = new OrganizationController();