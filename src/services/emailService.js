// backend/src/services/emailService.js
const { sendPasswordResetEmail, sendOrganizationWelcomeEmail } = require('./emailServiceBrevo');

module.exports = {
  sendPasswordResetEmail,
  sendOrganizationWelcomeEmail,
};