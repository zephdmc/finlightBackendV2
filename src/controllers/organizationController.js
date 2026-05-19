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
   * Create a new organization
   * @route POST /api/admin/organizations
   */
  async createOrganization(req, res, next) {
    try {
      const { name, slug, paystack, adminEmail, adminName, adminPassword } = req.body;

      if (!name || !slug) {
        return res.status(400).json({ 
          success: false, 
          message: 'Name and slug are required' 
        });
      }

      const existingOrg = await Organization.findOne({ slug });
      if (existingOrg) {
        return res.status(400).json({ 
          success: false, 
          message: 'Organization slug already exists' 
        });
      }

      const organization = new Organization({
        name,
        slug,
        paystack: {
          subaccountCode: paystack?.subaccountCode || '',
          bankName: paystack?.bankName || '',
          accountNumber: paystack?.accountNumber || '',
          percentageCharge: paystack?.percentageCharge || 0,
          subaccountStatus: 'pending'
        }
      });
      
      const savedOrg = await organization.save();

      let adminUser = null;
      
      if (adminEmail && adminName && adminPassword) {
        const existingUser = await User.findOne({ email: adminEmail });
        if (existingUser) {
          await Organization.findByIdAndDelete(savedOrg._id);
          return res.status(400).json({ 
            success: false, 
            message: 'Admin email already registered' 
          });
        }
        
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
   * Delete organization
   * @route DELETE /api/admin/organizations/:id
   */
  async deleteOrganization(req, res, next) {
    try {
      const { id } = req.params;

      await User.deleteMany({ organizationId: id });
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

  /**
   * Update organization status
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
   * ✅ SIMPLIFIED FIXED VERSION - Update bank details
   * @route PUT /api/organizations/bank-details
   * @access Private/Admin
   */
  async updateBankDetails(req, res, next) {
    try {
      console.log('=== UPDATE BANK DETAILS CALLED ===');
      
      const organizationId = req.user?.organizationId;
      const { bankName, accountNumber, accountName } = req.body;
      
      console.log('Organization ID:', organizationId);
      console.log('Bank details:', { bankName, accountNumber, accountName });
      
      if (!organizationId) {
        return res.status(400).json({
          success: false,
          message: 'Organization ID not found for this user'
        });
      }

      if (!bankName || !accountNumber) {
        return res.status(400).json({
          success: false,
          message: 'Bank name and account number are required'
        });
      }

      // Get organization details
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return res.status(404).json({
          success: false,
          message: 'Organization not found'
        });
      }

      // Get admin user for contact email
      const admin = await User.findOne({ 
        organizationId: organizationId, 
        role: 'admin' 
      });

      if (!admin) {
        return res.status(404).json({
          success: false,
          message: 'Admin not found for this organization'
        });
      }

      // ========== INLINE BANK CODE LOOKUP ==========
      console.log('Fetching bank code for:', bankName);
      
      let bankCode = null;
      try {
        const bankResponse = await fetch('https://api.paystack.co/bank', {
          headers: {
            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
          }
        });
        const bankData = await bankResponse.json();
        
        if (bankData.status) {
          // Try exact match first
          let bank = bankData.data.find(b => 
            b.name.toLowerCase() === bankName.toLowerCase()
          );
          
          // Try partial match if exact not found
          if (!bank) {
            bank = bankData.data.find(b => 
              b.name.toLowerCase().includes(bankName.toLowerCase()) ||
              bankName.toLowerCase().includes(b.name.toLowerCase())
            );
          }
          
          bankCode = bank ? bank.code : null;
          console.log('Bank found:', bank ? bank.name : 'Not found', 'Code:', bankCode);
        }
      } catch (bankError) {
        console.error('Error fetching banks:', bankError);
      }
      
      if (!bankCode) {
        return res.status(400).json({
          success: false,
          message: `Could not find bank code for "${bankName}". Please check the bank name.`
        });
      }

      // ========== CREATE PAYSTACK SUBACCOUNT ==========
      console.log('Creating Paystack subaccount...');
      
      let subaccountResult = null;
      try {
        const subaccountResponse = await fetch('https://api.paystack.co/subaccount', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            business_name: organization.name,
            settlement_bank: bankCode,
            account_number: accountNumber,
            percentage_charge: 0,
            description: `Subaccount for ${organization.name}`,
            primary_contact_email: admin.email,
            metadata: JSON.stringify({
              platform: 'finlight',
              created_at: new Date().toISOString()
            })
          })
        });
        
        const subaccountData = await subaccountResponse.json();
        console.log('Subaccount response:', subaccountData.status ? 'Success' : 'Failed');
        
        if (subaccountData.status) {
          subaccountResult = {
            success: true,
            subaccountCode: subaccountData.data.subaccount_code,
            isVerified: subaccountData.data.is_verified || false
          };
        } else {
          subaccountResult = {
            success: false,
            error: subaccountData.message
          };
        }
      } catch (subError) {
        console.error('Error creating subaccount:', subError);
        subaccountResult = {
          success: false,
          error: subError.message
        };
      }

      if (!subaccountResult.success) {
        return res.status(400).json({
          success: false,
          message: `Failed to create Paystack subaccount: ${subaccountResult.error}`
        });
      }

      // Update organization with subaccount details
      organization.paystack = {
        subaccountCode: subaccountResult.subaccountCode,
        bankName: bankName,
        accountNumber: accountNumber,
        accountName: accountName || organization.name,
        percentageCharge: 0,
        subaccountStatus: 'active',
        subaccountCreatedAt: new Date(),
        subaccountVerified: subaccountResult.isVerified || false
      };
      organization.updatedAt = new Date();
      
      await organization.save();

      console.log(`✅ Subaccount created: ${subaccountResult.subaccountCode}`);

      res.status(200).json({
        success: true,
        data: {
          subaccountCode: subaccountResult.subaccountCode,
          bankName: bankName,
          accountNumber: accountNumber,
          accountName: accountName || organization.name,
          isVerified: subaccountResult.isVerified || false,
          subaccountStatus: 'active'
        },
        message: 'Bank details updated and Paystack subaccount created successfully!'
      });

    } catch (error) {
      console.error('Error updating bank details:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update bank details'
      });
    }
  }

  /**
   * Get subaccount status
   * @route GET /api/organizations/subaccount/status
   * @access Private/Admin
   */
  async getSubaccountStatus(req, res, next) {
    try {
      const organizationId = req.user.organizationId;
      
      const organization = await Organization.findById(organizationId);
      if (!organization) {
        return res.status(404).json({
          success: false,
          message: 'Organization not found'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          hasSubaccount: !!organization.paystack?.subaccountCode,
          subaccountCode: organization.paystack?.subaccountCode,
          subaccountStatus: organization.paystack?.subaccountStatus || 'pending',
          bankName: organization.paystack?.bankName,
          accountNumber: organization.paystack?.accountNumber ? '****' + organization.paystack.accountNumber.slice(-4) : null,
          isVerified: organization.paystack?.subaccountVerified || false,
          createdAt: organization.paystack?.subaccountCreatedAt
        }
      });
    } catch (error) {
      console.error('Error fetching subaccount status:', error);
      next(error);
    }
  }
}

module.exports = new OrganizationController();