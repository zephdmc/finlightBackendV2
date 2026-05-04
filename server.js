const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = require('./src/app');
const database = require('./src/config/database');

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Start server
const startServer = async () => {
  try {
    // Connect to database using your database config
    await database.connect();
    
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔗 URL: http://localhost:${PORT}`);
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