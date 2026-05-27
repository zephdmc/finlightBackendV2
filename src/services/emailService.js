// backend/src/services/emailService.js
const { sendPasswordResetEmail, sendOrganizationWelcomeEmail, sendMemberWelcomeEmail, sendPaymentTypeNotificationEmail
} = require('./emailServiceBrevo');

module.exports = {
  sendPasswordResetEmail,
  sendOrganizationWelcomeEmail,
  sendMemberWelcomeEmail,
  sendPaymentTypeNotificationEmail
};