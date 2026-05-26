// backend/src/services/smsService.js
const africastalking = require('africastalking');

// Initialize Africa's Talking
let sms = null;
let isConfigured = false;

const initAfricaSTalking = () => {
  try {
    // Check if credentials exist
    if (!process.env.AFRICASTALKING_API_KEY || !process.env.AFRICASTALKING_USERNAME) {
      console.log('⚠️ Africa\'s Talking credentials not configured. SMS service disabled.');
      return null;
    }

    const credentials = {
      apiKey: process.env.AFRICASTALKING_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME, // Use 'sandbox' for testing
    };

    // Initialize SDK
    const africasTalking = africastalking(credentials);
    sms = africasTalking.SMS;
    isConfigured = true;
    console.log('✅ Africa\'s Talking SMS service initialized');
    return sms;
  } catch (error) {
    console.error('❌ Failed to initialize Africa\'s Talking:', error.message);
    return null;
  }
};

/**
 * Format phone number to international format for Africa's Talking
 * @param {string} phoneNumber - Phone number (e.g., 08012345678 or +2348012345678)
 * @returns {string} - Formatted phone number (e.g., 2348012345678)
 */
const formatPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;
  
  // Remove any spaces or special characters
  let cleaned = phoneNumber.replace(/\s+/g, '');
  
  // If starts with 0, replace with 234
  if (cleaned.startsWith('0')) {
    return '234' + cleaned.slice(1);
  }
  
  // If starts with +234, remove the +
  if (cleaned.startsWith('+234')) {
    return cleaned.slice(1);
  }
  
  // If already in 234 format, return as is
  if (cleaned.startsWith('234')) {
    return cleaned;
  }
  
  return cleaned;
};

/**
 * Send SMS to a single recipient
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} message - SMS message content
 * @returns {Promise<boolean>} - Success status
 */
const sendSMS = async (phoneNumber, message) => {
  if (!isConfigured || !sms) {
    console.log('⚠️ SMS service not configured. Would have sent:', { phoneNumber, message });
    return false;
  }

  if (!phoneNumber) {
    console.log('⚠️ No phone number provided. Skipping SMS.');
    return false;
  }

  const formattedNumber = formatPhoneNumber(phoneNumber);
  
  if (!formattedNumber || formattedNumber.length < 12) {
    console.log(`⚠️ Invalid phone number format: ${phoneNumber}`);
    return false;
  }

  const options = {
    to: formattedNumber,
    message: message,
    from: process.env.AFRICASTALKING_SENDER_ID || 'FinLight',
    enqueue: true
  };

  try {
    const response = await sms.send(options);
    console.log(`✅ SMS sent to ${formattedNumber}`);
    return true;
  } catch (error) {
    console.error('❌ SMS sending failed:', error.message);
    return false;
  }
};

/**
 * Send bulk SMS with batch processing and delays to avoid rate limiting
 * @param {Array} recipients - Array of {phoneNumber, name} objects
 * @param {Function|string} messageGenerator - Message or function to generate personalized message
 * @param {Object} options - Batch options
 * @returns {Promise<Object>} - Results summary
 */
const sendBulkSMSWithDelay = async (recipients, messageGenerator, options = {}) => {
  const {
    batchSize = 20,              // Number of SMS per batch
    delayBetweenBatches = 3000,  // Delay in milliseconds between batches (3 seconds)
    delayBetweenSMS = 200,       // Delay between individual SMS within a batch (200ms)
    onProgress = null            // Optional progress callback
  } = options;

  if (!recipients || recipients.length === 0) {
    return { total: 0, sent: 0, failed: 0, errors: [] };
  }

  if (!isConfigured || !sms) {
    console.log(`⚠️ SMS service not configured. Would have sent to ${recipients.length} recipients.`);
    return { total: recipients.length, sent: 0, failed: recipients.length, errors: ['SMS service not configured'] };
  }

  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    errors: [],
    details: []
  };

  // Filter valid recipients
  const validRecipients = [];
  for (const recipient of recipients) {
    const formatted = formatPhoneNumber(recipient.phoneNumber);
    if (!formatted) {
      results.failed++;
      results.errors.push(`Invalid phone number: ${recipient.phoneNumber}`);
      results.details.push({ phoneNumber: recipient.phoneNumber, status: 'invalid', name: recipient.name });
    } else {
      validRecipients.push({
        ...recipient,
        formattedNumber: formatted
      });
    }
  }

  // Update total after filtering
  results.total = validRecipients.length;

  // Process in batches
  const batches = [];
  for (let i = 0; i < validRecipients.length; i += batchSize) {
    batches.push(validRecipients.slice(i, i + batchSize));
  }

  console.log(`📱 Sending SMS to ${validRecipients.length} recipients in ${batches.length} batches (${batchSize} per batch)`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} messages)...`);

    // Process each SMS in the batch with individual delays
    for (let i = 0; i < batch.length; i++) {
      const recipient = batch[i];
      
      // Generate personalized message if needed
      const message = typeof messageGenerator === 'function'
        ? messageGenerator(recipient)
        : messageGenerator;

      try {
        const options = {
          to: recipient.formattedNumber,
          message: message,
          from: process.env.AFRICASTALKING_SENDER_ID || 'FinLight',
          enqueue: true
        };

        const response = await sms.send(options);
        results.sent++;
        results.details.push({
          phoneNumber: recipient.phoneNumber,
          name: recipient.name,
          status: 'sent',
          timestamp: new Date().toISOString()
        });
        
        console.log(`✅ [${batchIndex + 1}/${batches.length}] SMS sent to ${recipient.name || recipient.formattedNumber} (${results.sent}/${validRecipients.length})`);
        
        // Delay between individual SMS (within same batch)
        if (i < batch.length - 1 && delayBetweenSMS > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenSMS));
        }
        
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed for ${recipient.phoneNumber}: ${error.message}`);
        results.details.push({
          phoneNumber: recipient.phoneNumber,
          name: recipient.name,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        });
        console.error(`❌ Failed to send SMS to ${recipient.name || recipient.formattedNumber}:`, error.message);
      }

      // Progress callback
      if (onProgress) {
        onProgress({
          current: results.sent + results.failed,
          total: validRecipients.length,
          sent: results.sent,
          failed: results.failed,
          batch: batchIndex + 1,
          totalBatches: batches.length
        });
      }
    }

    // Delay between batches (except after the last batch)
    if (batchIndex < batches.length - 1 && delayBetweenBatches > 0) {
      console.log(`⏳ Waiting ${delayBetweenBatches / 1000} seconds before next batch...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }
  }

  console.log(`📱 Bulk SMS completed: ${results.sent}/${results.total} sent, ${results.failed} failed`);
  return results;
};

/**
 * Send bulk payment notification to all members with batch delays
 * @param {Array} members - Array of member objects with name, phoneNumber
 * @param {Object} paymentType - Payment type object
 * @param {string} organizationName - Name of the organization
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<Object>} - Results summary
 */
const sendBulkPaymentNotification = async (members, paymentType, organizationName, onProgress = null) => {
  if (!members || members.length === 0) {
    return { total: 0, sent: 0, failed: 0, errors: [] };
  }

  const amountFormatted = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0
  }).format(paymentType.amount);

  const isMandatory = paymentType.is_mandatory ? 'MANDATORY' : 'optional';
  const frequencyText = paymentType.frequency === 'one-time' ? 'one-time' : paymentType.frequency;
  const frontendUrl = process.env.FRONTEND_URL || 'https://finlightv2.web.app';

  // Prepare recipients array
  const recipients = members
    .filter(m => m.phoneNumber && m.phoneNumber.trim() !== '')
    .map(member => ({
      phoneNumber: member.phoneNumber,
      name: member.name,
      email: member.email,
      metadata: {
        paymentTypeId: paymentType._id,
        paymentTypeName: paymentType.name,
        amount: paymentType.amount,
        organizationName
      }
    }));

  if (recipients.length === 0) {
    console.log('📱 No members with valid phone numbers found');
    return { total: 0, sent: 0, failed: 0, errors: ['No valid phone numbers'] };
  }

  // Message generator function for personalization
  const messageGenerator = (recipient) => {
    return `🔔 NEW PAYMENT: ${organizationName}\n\n` +
      `Dear ${recipient.name},\n` +
      `A new ${isMandatory} payment has been created for your organization.\n\n` +
      `📌 ${paymentType.name}\n` +
      `💰 Amount: ${amountFormatted}\n` +
      `📅 Frequency: ${frequencyText}\n` +
      `${paymentType.description ? `📝 ${paymentType.description}\n` : ''}\n` +
      `Please log in to make your payment:\n` +
      `${frontendUrl}/login\n\n` +
      `Thank you,\n` +
      `- FinLight Team`;
  };

  // Send with batch processing
  const results = await sendBulkSMSWithDelay(recipients, messageGenerator, {
    batchSize: 20,           // Send 20 SMS at a time
    delayBetweenBatches: 3000, // Wait 3 seconds between batches
    delayBetweenSMS: 200,     // Wait 200ms between individual SMS
    onProgress
  });

  return results;
};

/**
 * Send member login credentials via SMS
 * @param {Object} member - Member object with name, phoneNumber, email, password
 * @returns {Promise<boolean>} - Success status
 */
const sendMemberCredentials = async (member) => {
  const { name, phoneNumber, email, password, organizationName } = member;
  
  if (!phoneNumber) {
    console.log(`⚠️ No phone number for member: ${email}. Skipping SMS.`);
    return false;
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://finlightv2.web.app';
  
  const message = `Welcome to FinLight, ${name}! 🎉\n\n` +
    `Your account has been created for ${organizationName || 'your organization'}.\n\n` +
    `📧 Email: ${email}\n` +
    `🔑 Password: ${password}\n\n` +
    `Login here: ${frontendUrl}/login\n\n` +
    `Please change your password after first login for security.\n\n` +
    `- FinLight Team`;

  // Truncate message if too long (SMS limit is 1600 characters)
  const truncatedMessage = message.length > 1600 ? message.substring(0, 1597) + '...' : message;
  
  return await sendSMS(phoneNumber, truncatedMessage);
};

/**
 * Send payment confirmation SMS
 * @param {Object} paymentDetails - Payment details
 * @returns {Promise<boolean>} - Success status
 */
const sendPaymentConfirmation = async (paymentDetails) => {
  const { memberName, phoneNumber, amount, paymentType, reference } = paymentDetails;
  
  if (!phoneNumber) return false;

  const message = `Payment Confirmation ✓\n\n` +
    `Dear ${memberName},\n` +
    `Your ${paymentType} payment of ₦${amount.toLocaleString()} has been received successfully.\n` +
    `Reference: ${reference}\n\n` +
    `Thank you for your contribution!\n` +
    `- FinLight Team`;

  return await sendSMS(phoneNumber, message);
};

/**
 * Send payment reminder SMS
 * @param {Object} reminderDetails - Reminder details
 * @returns {Promise<boolean>} - Success status
 */
const sendPaymentReminder = async (reminderDetails) => {
  const { memberName, phoneNumber, amount, paymentType, dueDate } = reminderDetails;
  
  if (!phoneNumber) return false;

  const dueDateFormatted = dueDate ? new Date(dueDate).toLocaleDateString('en-NG') : 'soon';
  
  const message = `Payment Reminder ⏰\n\n` +
    `Dear ${memberName},\n` +
    `Your ${paymentType} payment of ₦${amount.toLocaleString()} is due on ${dueDateFormatted}.\n\n` +
    `Please log in to make your payment:\n` +
    `${process.env.FRONTEND_URL || 'https://finlightv2.web.app'}/login\n\n` +
    `- FinLight Team`;

  return await sendSMS(phoneNumber, message);
};

/**
 * Send bulk SMS to multiple recipients (simplified version)
 * @param {Array} recipients - Array of {phoneNumber, name} objects
 * @param {string} message - Message to send
 * @returns {Promise<Object>} - Results summary
 */
const sendBulkSMS = async (recipients, message) => {
  if (!recipients || recipients.length === 0) {
    return { total: 0, sent: 0, failed: 0 };
  }

  const messageGenerator = () => message;
  
  return await sendBulkSMSWithDelay(recipients, messageGenerator, {
    batchSize: 20,
    delayBetweenBatches: 3000,
    delayBetweenSMS: 200
  });
};

// Initialize on module load
initAfricaSTalking();

module.exports = {
  initAfricaSTalking,
  sendSMS,
  sendMemberCredentials,
  sendPaymentConfirmation,
  sendPaymentReminder,
  sendBulkSMS,
  sendBulkSMSWithDelay,
  sendBulkPaymentNotification,
  formatPhoneNumber,
  isConfigured: () => isConfigured
};