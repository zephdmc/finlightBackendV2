const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Income = require('../models/Income');

// Paystack secret key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

console.log('Payment Gateway loaded - Paystack Key exists:', !!PAYSTACK_SECRET_KEY);

// @desc    Initialize Paystack payment
// @route   POST /api/payment-gateway/initialize
// @access  Private
router.post('/initialize', protect, async (req, res) => {
  try {
    const { paymentId } = req.body;
    console.log('Initialize payment request for:', paymentId);
    
    const payment = await Payment.findById(paymentId).populate('user', 'name email');
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    if (payment.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already completed'
      });
    }
    
    const requestBody = {
      email: payment.user.email,
      amount: payment.amount * 100,
      reference: `PAY-${payment._id}-${Date.now()}`,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || 'http://localhost:5173/payment/callback',
      metadata: {
        paymentId: payment._id.toString(),
        userId: payment.user._id.toString(),
        type: payment.type
      }
    };
    
    console.log('Sending to Paystack:', { email: requestBody.email, amount: requestBody.amount, reference: requestBody.reference });
    
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();
    console.log('Paystack response:', data);
    
    if (!data.status) {
      throw new Error(data.message || 'Failed to initialize payment');
    }
    
    // Save transaction reference
    payment.transactionReference = data.data.reference;
    await payment.save();
    
    res.status(200).json({
      success: true,
      data: {
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference
      }
    });
    
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initialize payment'
    });
  }
});



// @desc    Verify payment status (for callback) - Make it public for callback
// @route   GET /api/payment-gateway/verify/:reference
// @access  Public (for callback from Paystack)
router.get('/verify/:reference', async (req, res) => {
    try {
      const { reference } = req.params;
      console.log('=== VERIFY PAYMENT CALLED (Public) ===');
      console.log('Reference:', reference);
      
      // Find payment by transactionReference
      let payment = await Payment.findOne({ transactionReference: reference });
      
      // If not found, try to extract payment ID from reference
      if (!payment) {
        const match = reference.match(/PAY-([a-f0-9]+)-/);
        if (match && match[1]) {
          console.log('Extracted payment ID:', match[1]);
          payment = await Payment.findById(match[1]).populate('user', 'name email');
        }
      }
      
      if (!payment) {
        console.log('Payment not found for reference:', reference);
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      console.log('Found payment:', { id: payment._id, currentStatus: payment.status, amount: payment.amount });
      
      // If already paid, return success
      if (payment.status === 'paid') {
        console.log('Payment already marked as paid');
        return res.status(200).json({
          success: true,
          data: payment,
          message: 'Payment already verified'
        });
      }
      
      // Verify with Paystack
      const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
      const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      const data = await response.json();
      console.log('Paystack verification result:', data.status ? 'Success' : 'Failed', data.message);
      
      if (data.status && data.data && data.data.status === 'success') {
        // Update payment status
        payment.status = 'paid';
        payment.paidAt = new Date();
        await payment.save();
        console.log('✅ Payment updated to PAID:', payment._id);
        
        // Record as income
        try {
          await Income.create({
            amount: payment.amount,
            source: `${payment.type} payment - ${payment.description || payment.type}`,
            date: new Date(),
            description: `Paystack payment - ${payment.description || payment.type}`,
            paymentId: payment._id,
            paymentType: payment.type,
            transactionReference: reference
          });
          console.log('Income recorded successfully');
        } catch (incomeError) {
          console.error('Failed to record income:', incomeError);
        }
        
        res.status(200).json({
          success: true,
          data: payment,
          message: 'Payment verified successfully'
        });
      } else {
        console.log('Paystack verification failed');
        res.status(400).json({
          success: false,
          message: 'Payment verification failed'
        });
      }
    } catch (error) {
      console.error('Verification error:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  });

// @desc    Verify Paystack payment (Webhook)
// @route   POST /api/payment-gateway/webhook
// @access  Public
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }
    
    const event = req.body;
    console.log('Webhook event:', event.event);
    
    if (event.event === 'charge.success') {
      const { reference } = event.data;
      console.log('Webhook - Payment successful for reference:', reference);
      
      const payment = await Payment.findOne({ transactionReference: reference });
      
      if (payment && payment.status !== 'paid') {
        payment.status = 'paid';
        payment.paidAt = new Date();
        await payment.save();
        console.log('Webhook - Payment updated to paid:', payment._id);
        
        if (payment.type === 'registration') {
          await User.findByIdAndUpdate(payment.user, { hasPaidRegistration: true });
        }
        
        try {
          await Income.create({
            amount: payment.amount,
            source: `${payment.type} payment`,
            date: new Date(),
            description: `Paystack payment - ${payment.description || payment.type}`,
            paymentId: payment._id,
            paymentType: payment.type,
            transactionReference: reference
          });
        } catch (incomeError) {
          console.error('Failed to record income:', incomeError);
        }
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;