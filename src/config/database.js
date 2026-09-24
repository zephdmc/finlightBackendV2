const mongoose = require('mongoose');

/**
 * Database connection configuration
 * Handles connection pooling, retry logic, and event listeners
 */
class Database {
  constructor() {
    this.isConnected = false;
    this.retryCount = 0;
    this.maxRetries = 5;
  }

  async connect() {
    try {
      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        autoIndex: true, // Build indexes
        maxPoolSize: 10, // Maintain up to 10 socket connections
        serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
        socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
        family: 4 // Use IPv4, skip trying IPv6
      };

      await mongoose.connect(process.env.MONGODB_URI, options);

      this.isConnected = true;

      // Handle connection events
      mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB connection error:', err);
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        console.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
        this.isConnected = false;
        this.handleDisconnect();
      });

      mongoose.connection.on('reconnected', () => {
                this.isConnected = true;
      });

    } catch (error) {
      console.error('❌ MongoDB connection error:', error.message);
      await this.handleConnectionError();
    }
  }

  async handleConnectionError() {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);

      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      console.error('❌ Failed to connect to MongoDB after maximum retries');
      process.exit(1);
    }
  }

  async handleDisconnect() {
    if (!this.isConnected) {
      setTimeout(() => {
        this.connect();
      }, 5000);
    }
  }

  async disconnect() {
    try {
      await mongoose.disconnect();
      this.isConnected = false;
          } catch (error) {
      console.error('❌ Error disconnecting MongoDB:', error);
    }
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      name: mongoose.connection.name
    };
  }
}

module.exports = new Database();
