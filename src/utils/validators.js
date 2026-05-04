/**
 * Custom Validators and Sanitizers
 * Provides reusable validation functions for common use cases
 */

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} - Whether email is valid
 */
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    return emailRegex.test(email);
  };
  
  /**
   * Validate Nigerian phone number
   * @param {string} phone - Phone number to validate
   * @returns {boolean} - Whether phone is valid
   */
  const isValidNigerianPhone = (phone) => {
    const phoneRegex = /^(0|234)?[789][01]\d{8}$/;
    return phoneRegex.test(phone);
  };
  
  /**
   * Validate password strength
   * @param {string} password - Password to validate
   * @returns {Object} - Validation result
   */
  const validatePasswordStrength = (password) => {
    const errors = [];
    
    if (!password || password.length === 0) {
      errors.push('Password is required');
      return { isValid: false, errors };
    }
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }
    
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      strength: errors.length === 0 ? 'strong' : 
                errors.length <= 2 ? 'medium' : 'weak'
    };
  };
  
  /**
   * Validate amount
   * @param {number} amount - Amount to validate
   * @param {number} min - Minimum amount
   * @param {number} max - Maximum amount
   * @returns {Object} - Validation result
   */
  const validateAmount = (amount, min = 0.01, max = 10000000) => {
    const errors = [];
    
    if (typeof amount !== 'number' || isNaN(amount)) {
      errors.push('Amount must be a valid number');
    }
    
    if (amount < min) {
      errors.push(`Amount must be at least ${min}`);
    }
    
    if (amount > max) {
      errors.push(`Amount cannot exceed ${max}`);
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      value: amount
    };
  };
  
  /**
   * Validate date
   * @param {string|Date} date - Date to validate
   * @param {boolean} allowPast - Whether past dates are allowed
   * @returns {Object} - Validation result
   */
  const validateDate = (date, allowPast = true) => {
    const errors = [];
    const dateObj = new Date(date);
    
    if (isNaN(dateObj.getTime())) {
      errors.push('Invalid date format');
      return { isValid: false, errors };
    }
    
    if (!allowPast && dateObj < new Date()) {
      errors.push('Date cannot be in the past');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      value: dateObj
    };
  };
  
  /**
   * Validate MongoDB ObjectId
   * @param {string} id - ID to validate
   * @returns {boolean} - Whether ID is valid
   */
  const isValidObjectId = (id) => {
    const objectIdRegex = /^[0-9a-fA-F]{24}$/;
    return objectIdRegex.test(id);
  };
  
  /**
   * Validate URL
   * @param {string} url - URL to validate
   * @returns {boolean} - Whether URL is valid
   */
  const isValidUrl = (url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };
  
  /**
   * Sanitize string (remove harmful characters)
   * @param {string} str - String to sanitize
   * @returns {string} - Sanitized string
   */
  const sanitizeString = (str) => {
    if (!str || typeof str !== 'string') return '';
    
    return str
      .trim()
      .replace(/[<>]/g, '') // Remove < and >
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  
  /**
   * Validate pagination parameters
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Object} - Validated pagination params
   */
  const validatePagination = (page, limit) => {
    const validatedPage = Math.max(1, parseInt(page) || 1);
    const validatedLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));
    
    return {
      page: validatedPage,
      limit: validatedLimit,
      skip: (validatedPage - 1) * validatedLimit
    };
  };
  
  /**
   * Validate enum value
   * @param {string} value - Value to check
   * @param {Array} allowedValues - Allowed values
   * @returns {boolean} - Whether value is valid
   */
  const isValidEnum = (value, allowedValues) => {
    return allowedValues.includes(value);
  };
  
  /**
   * Validate and parse amount with currency
   * @param {string|number} amount - Amount to parse
   * @returns {Object} - Parsed amount
   */
  const parseAmount = (amount) => {
    if (typeof amount === 'number') {
      return { amount, isValid: true };
    }
    
    if (typeof amount === 'string') {
      // Remove currency symbols and commas
      const cleaned = amount.replace(/[₦$,]/g, '').trim();
      const parsed = parseFloat(cleaned);
      
      if (isNaN(parsed)) {
        return { isValid: false, error: 'Invalid amount format' };
      }
      
      return { amount: parsed, isValid: true };
    }
    
    return { isValid: false, error: 'Invalid amount type' };
  };
  
  /**
   * Validate payment type
   * @param {string} type - Payment type
   * @returns {Object} - Validation result
   */
  const validatePaymentType = (type) => {
    const validTypes = ['registration', 'dues', 'fine', 'contribution'];
    
    if (!validTypes.includes(type)) {
      return {
        isValid: false,
        error: `Payment type must be one of: ${validTypes.join(', ')}`
      };
    }
    
    return { isValid: true, type };
  };
  
  /**
   * Validate bank account number (Nigerian)
   * @param {string} accountNumber - Account number to validate
   * @returns {boolean} - Whether account number is valid
   */
  const isValidBankAccount = (accountNumber) => {
    const accountRegex = /^\d{10}$/;
    return accountRegex.test(accountNumber);
  };
  
  /**
   * Validate BVN (Bank Verification Number)
   * @param {string} bvn - BVN to validate
   * @returns {boolean} - Whether BVN is valid
   */
  const isValidBVN = (bvn) => {
    const bvnRegex = /^\d{11}$/;
    return bvnRegex.test(bvn);
  };
  
  /**
   * Check if string contains only letters and spaces
   * @param {string} str - String to check
   * @returns {boolean} - Whether valid
   */
  const isAlphaWithSpaces = (str) => {
    return /^[a-zA-Z\s]+$/.test(str);
  };
  
  /**
   * Validate and format Nigerian Naira amount
   * @param {number} amount - Amount to format
   * @returns {string} - Formatted amount
   */
  const formatNaira = (amount) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2
    }).format(amount);
  };
  
  /**
   * Validate object fields against schema
   * @param {Object} data - Data to validate
   * @param {Object} schema - Validation schema
   * @returns {Object} - Validation result
   */
  const validateSchema = (data, schema) => {
    const errors = {};
    let isValid = true;
    
    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];
      
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors[field] = `${field} is required`;
        isValid = false;
        continue;
      }
      
      if (value !== undefined && value !== null && value !== '') {
        if (rules.type && typeof value !== rules.type) {
          errors[field] = `${field} must be of type ${rules.type}`;
          isValid = false;
        }
        
        if (rules.min !== undefined && value < rules.min) {
          errors[field] = `${field} must be at least ${rules.min}`;
          isValid = false;
        }
        
        if (rules.max !== undefined && value > rules.max) {
          errors[field] = `${field} cannot exceed ${rules.max}`;
          isValid = false;
        }
        
        if (rules.pattern && !rules.pattern.test(value)) {
          errors[field] = rules.message || `${field} has invalid format`;
          isValid = false;
        }
        
        if (rules.enum && !rules.enum.includes(value)) {
          errors[field] = `${field} must be one of: ${rules.enum.join(', ')}`;
          isValid = false;
        }
      }
    }
    
    return { isValid, errors };
  };
  
  module.exports = {
    isValidEmail,
    isValidNigerianPhone,
    validatePasswordStrength,
    validateAmount,
    validateDate,
    isValidObjectId,
    isValidUrl,
    sanitizeString,
    validatePagination,
    isValidEnum,
    parseAmount,
    validatePaymentType,
    isValidBankAccount,
    isValidBVN,
    isAlphaWithSpaces,
    formatNaira,
    validateSchema
  };