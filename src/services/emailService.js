// backend/src/services/emailService.js
const { sendPasswordResetEmail, sendOrganizationWelcomeEmail, sendMemberWelcomeEmail } = require('./emailServiceBrevo');

module.exports = {
  sendPasswordResetEmail,
  sendOrganizationWelcomeEmail,
  sendMemberWelcomeEmail
};