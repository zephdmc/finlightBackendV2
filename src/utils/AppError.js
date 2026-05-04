/**
 * Custom Application Error Class
 * Provides consistent error handling across the application
 * Extends native Error with additional properties
 */
class AppError extends Error {
    /**
     * Create a new AppError
     * @param {string} message - Error message
     * @param {number} statusCode - HTTP status code
     * @param {Object} options - Additional error options
     */
    constructor(message, statusCode, options = {}) {
      super(message);
      
      this.statusCode = statusCode || 500;
      this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
      this.isOperational = true;
      
      // Add additional properties
      if (options.code) this.code = options.code;
      if (options.data) this.data = options.data;
      if (options.errors) this.errors = options.errors;
      if (options.field) this.field = options.field;
      
      // Capture stack trace
      Error.captureStackTrace(this, this.constructor);
    }
  
    /**
     * Create a 400 Bad Request error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static badRequest(message = 'Bad request', options = {}) {
      return new AppError(message, 400, options);
    }
  
    /**
     * Create a 401 Unauthorized error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static unauthorized(message = 'Unauthorized access', options = {}) {
      return new AppError(message, 401, options);
    }
  
    /**
     * Create a 403 Forbidden error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static forbidden(message = 'Forbidden access', options = {}) {
      return new AppError(message, 403, options);
    }
  
    /**
     * Create a 404 Not Found error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static notFound(message = 'Resource not found', options = {}) {
      return new AppError(message, 404, options);
    }
  
    /**
     * Create a 409 Conflict error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static conflict(message = 'Resource conflict', options = {}) {
      return new AppError(message, 409, options);
    }
  
    /**
     * Create a 422 Validation error
     * @param {string} message - Error message
     * @param {Object} options - Additional options with validation errors
     * @returns {AppError}
     */
    static validation(message = 'Validation failed', options = {}) {
      return new AppError(message, 422, options);
    }
  
    /**
     * Create a 429 Too Many Requests error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static tooManyRequests(message = 'Too many requests', options = {}) {
      return new AppError(message, 429, options);
    }
  
    /**
     * Create a 500 Internal Server Error
     * @param {string} message - Error message
     * @param {Object} options - Additional options
     * @returns {AppError}
     */
    static internal(message = 'Internal server error', options = {}) {
      return new AppError(message, 500, options);
    }
  
    /**
     * Convert mongoose validation error to AppError
     * @param {Object} mongooseError - Mongoose validation error
     * @returns {AppError}
     */
    static fromMongooseError(mongooseError) {
      const errors = {};
      
      if (mongooseError.name === 'ValidationError') {
        for (const field in mongooseError.errors) {
          errors[field] = mongooseError.errors[field].message;
        }
        return this.validation('Validation failed', { errors });
      }
      
      if (mongooseError.code === 11000) {
        const field = Object.keys(mongooseError.keyPattern)[0];
        return this.conflict(`${field} already exists`, { field });
      }
      
      return this.internal(mongooseError.message);
    }
  
    /**
     * Convert to JSON representation
     * @returns {Object} - JSON error object
     */
    toJSON() {
      const error = {
        status: this.status,
        message: this.message
      };
      
      if (this.code) error.code = this.code;
      if (this.errors) error.errors = this.errors;
      if (this.field) error.field = this.field;
      if (this.data) error.data = this.data;
      
      return error;
    }
  
    /**
     * Format error for logging
     * @returns {Object} - Log-friendly error object
     */
    toLog() {
      return {
        name: this.name,
        message: this.message,
        statusCode: this.statusCode,
        status: this.status,
        stack: this.stack,
        ...(this.code && { code: this.code }),
        ...(this.errors && { errors: this.errors })
      };
    }
  }
  
  module.exports = AppError;