// backend/src/services/organizationService.js
const Organization = require('../models/Organization');

/**
 * Get organization by ID
 * @param {string} organizationId - MongoDB ObjectId of the organization
 * @returns {Promise<Object>} Organization document
 * @throws {Error} If organization not found
 */
async function getOrganizationById(organizationId) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new Error('Organization not found');
  }
  return organization;
}

/**
 * Get organization by slug (e.g., "agfma")
 * @param {string} slug - URL-friendly organization identifier
 * @returns {Promise<Object>} Organization document
 * @throws {Error} If organization not found
 */
async function getOrganizationBySlug(slug) {
  const organization = await Organization.findOne({ slug });
  if (!organization) {
    throw new Error(`Organization with slug "${slug}" not found`);
  }
  return organization;
}

/**
 * Get Paystack subaccount code for an organization
 * @param {string} organizationId - MongoDB ObjectId of the organization
 * @returns {Promise<string>} Paystack subaccount code (e.g., "ACCT_xxxxx")
 * @throws {Error} If organization not found or subaccount not configured
 */
async function getPaystackSubaccount(organizationId) {
  const organization = await Organization.findById(organizationId).select('paystack.subaccountCode');
  if (!organization) {
    throw new Error('Organization not found');
  }
  if (!organization.paystack || !organization.paystack.subaccountCode) {
    throw new Error(`Paystack subaccount not configured for organization ${organizationId}`);
  }
  return organization.paystack.subaccountCode;
}

/**
 * Get full Paystack configuration for an organization
 * @param {string} organizationId - MongoDB ObjectId
 * @returns {Promise<Object>} { subaccountCode, bankName, accountNumber, percentageCharge }
 */
async function getPaystackConfig(organizationId) {
  const organization = await Organization.findById(organizationId).select('paystack');
  if (!organization) {
    throw new Error('Organization not found');
  }
  if (!organization.paystack || !organization.paystack.subaccountCode) {
    throw new Error(`Paystack configuration missing for organization ${organizationId}`);
  }
  return {
    subaccountCode: organization.paystack.subaccountCode,
    bankName: organization.paystack.bankName || null,
    accountNumber: organization.paystack.accountNumber || null,
    percentageCharge: organization.paystack.percentageCharge || 0
  };
}

/**
 * Create a new organization (used by super admin)
 * @param {Object} data - { name, slug, paystack config }
 * @returns {Promise<Object>} Created organization
 */
async function createOrganization(data) {
  const { name, slug, paystack } = data;
  if (!name || !slug) {
    throw new Error('Name and slug are required');
  }
  // Check for existing organization with same slug
  const existing = await Organization.findOne({ slug });
  if (existing) {
    throw new Error(`Organization with slug "${slug}" already exists`);
  }
  const organization = new Organization({
    name,
    slug,
    paystack: paystack || {}
  });
  await organization.save();
  return organization;
}

/**
 * Update organization's Paystack subaccount
 * @param {string} organizationId - MongoDB ObjectId
 * @param {Object} paystackData - { subaccountCode, bankName, accountNumber, percentageCharge }
 * @returns {Promise<Object>} Updated organization
 */
async function updatePaystackConfig(organizationId, paystackData) {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new Error('Organization not found');
  }
  // Update only provided fields
  organization.paystack = {
    ...organization.paystack,
    ...paystackData
  };
  await organization.save();
  return organization;
}

/**
 * List all organizations (admin only)
 * @returns {Promise<Array>} List of organizations
 */
async function listOrganizations() {
  return await Organization.find().sort({ createdAt: -1 });
}

module.exports = {
  getOrganizationById,
  getOrganizationBySlug,
  getPaystackSubaccount,
  getPaystackConfig,
  createOrganization,
  updatePaystackConfig,
  listOrganizations
};