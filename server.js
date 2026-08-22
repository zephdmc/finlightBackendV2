const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = require('./src/app');
const database = require('./src/config/database');

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Start server and connect to database
const startServer = async () => {
  try {
    // Connect to database using your database config
    await database.connect();

    if (process.env.NODE_ENV !== 'test') {
      // Load existing jobs
      require('./src/jobs/verifyPendingPayments');

      // ============================================================
      // NEW: Initialize recurring billing scheduler
      // ============================================================
      // Load the billing scheduler - this will start the cron job
      // that automatically generates monthly/weekly dues for members
      try {
        const billingScheduler = require('./src/cron/billingScheduler');
        // Start the scheduler with a 1-minute delay to ensure everything is loaded
        setTimeout(() => {
          billingScheduler.startBillingScheduler();
          console.log('📆 Recurring billing scheduler initialized');
        }, 1000);
      } catch (err) {
        console.warn('⚠️  Recurring billing scheduler not loaded yet:', err.message);
        console.warn('   (This is expected if the billing service files are not yet created)');
        // Don't exit - the server can still run without billing scheduler
      }
      // ============================================================
    }

    const requiredEnv = ['FLW_SECRET_KEY', 'FLW_PUBLIC_KEY', 'FLW_ENCRYPTION_KEY', 'FLW_WEBHOOK_SECRET', 'PLATFORM_SUBACCOUNT_ID'];
    const missing = requiredEnv.filter(key => !process.env[key]);
    if (missing.length) {
      console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('✅ All Flutterwave environment variables are set');

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`🛡️  Security Headers: Enabled`);
      console.log(`⏱️  Rate Limiting: Enabled`);
      console.log(`🔒 CORS: Restricted to ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);

      // Log database connection status
      const dbStatus = database.getConnectionStatus();
      console.log(`📊 Database: ${dbStatus.name}`);
      console.log(`🔐 Database Connected: ${dbStatus.isConnected}`);
    });

    // Handle shutdown signals gracefully
    const gracefulShutdown = async () => {
      console.log('\n🛑 Received shutdown signal');

      try {
        // ============================================================
        // NEW: Stop the billing scheduler on shutdown
        // ============================================================
        try {
          const billingScheduler = require('./src/cron/billingScheduler');
          billingScheduler.stopBillingScheduler();
          console.log('📆 Recurring billing scheduler stopped');
        } catch (err) {
          // Ignore if scheduler not loaded
        }
        // ============================================================

        await database.disconnect();
        console.log('✅ Database connection closed');

        server.close(() => {
          console.log('✅ HTTP server closed');
          process.exit(0);
        });
      } catch (err) {
        console.error('❌ Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();