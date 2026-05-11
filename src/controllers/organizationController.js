const Organization = require('../models/Organization');
const User = require('../models/User');
const mongoose = require('mongoose');

/**
 * Organization Controller (Super Admin only)
 */
class OrganizationController {
  /**
   * Helper: ensure user is super_admin
   */
  requireSuperAdmin(req, res, next) {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Super admin access required' });
    }
    next();
  }

  /**
   * Get all organizations (with admin user info)
   * @route GET /api/admin/organizations
   */
  async getAllOrganizations(req, res, next) {
    try {
      const organizations = await Organization.aggregate([
        {
          $lookup: {
            from: 'users',
            let: { orgId: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$organizationId', '$$orgId'] }, role: 'admin' } },
              { $project: { name: 1, email: 1, _id: 0 } }
            ],
            as: 'admins'
          }
        },
        {
          $addFields: {
            adminCount: { $size: '$admins' },
            primaryAdmin: { $arrayElemAt: ['$admins', 0] }
          }
        },
        { $sort: { createdAt: -1 } }
      ]);
      res.status(200).json({ success: true, data: organizations });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a new organization (super admin)
   * @route POST /api/admin/organizations
   */
  async createOrganization(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { name, slug, paystack, adminEmail, adminName, adminPassword } = req.body;

      if (!name || !slug) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Name and slug are required' });
      }

      // Check if slug already used
      const existingOrg = await Organization.findOne({ slug }).session(session);
      if (existingOrg) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Slug already exists' });
      }

      // Create organization
      const [org] = await Organization.create([{
        name,
        slug,
        paystack: paystack || { subaccountCode: '', bankName: '', accountNumber: '', percentageCharge: 0 }
      }], { session });

      // If admin details provided, create admin user
      let adminUser = null;
      if (adminEmail && adminName && adminPassword) {
        const existingAdmin = await User.findOne({ email: adminEmail }).session(session);
        if (existingAdmin) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ success: false, message: 'Admin email already used' });
        }
        const [user] = await User.create([{
          name: adminName,
          email: adminEmail,
          password: adminPassword,
          role: 'admin',
          organizationId: org._id
        }], { session });
        adminUser = user;
      }

      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
        success: true,
        data: {
          organization: org,
          admin: adminUser ? { id: adminUser._id, name: adminUser.name, email: adminUser.email } : null
        }
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      next(error);
    }
  }

  /**
   * Update organization (Paystack settings, name, slug)
   * @route PUT /api/admin/organizations/:id
   */
  async updateOrganization(req, res, next) {
    try {
      const { id } = req.params;
      const { name, slug, paystack } = req.body;

      const update = {};
      if (name) update.name = name;
      if (slug) update.slug = slug;
      if (paystack) update.paystack = paystack;

      const org = await Organization.findByIdAndUpdate(id, update, { new: true, runValidators: true });
      if (!org) {
        return res.status(404).json({ success: false, message: 'Organization not found' });
      }
      res.status(200).json({ success: true, data: org });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete organization (and all associated users, payments, etc.)
   * @route DELETE /api/admin/organizations/:id
   */
  async deleteOrganization(req, res, next) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { id } = req.params;

      // Delete all users belonging to this organization
      await User.deleteMany({ organizationId: id }).session(session);
      // Delete all payments (and other collections if needed)
      await mongoose.model('Payment').deleteMany({ organizationId: id }).session(session);
      await mongoose.model('Income').deleteMany({ organizationId: id }).session(session);
      await mongoose.model('Expenditure').deleteMany({ organizationId: id }).session(session);
      await mongoose.model('PaymentType').deleteMany({ organizationId: id }).session(session);
      // Finally delete organization
      const org = await Organization.findByIdAndDelete(id).session(session);
      if (!org) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: 'Organization not found' });
      }
      await session.commitTransaction();
      session.endSession();
      res.status(200).json({ success: true, message: 'Organization and all associated data deleted' });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      next(error);
    }
  }
}

module.exports = new OrganizationController();