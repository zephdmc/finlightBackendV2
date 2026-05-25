const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const organizationRoutes = require('./routes/organizationroute');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const paymentRoutes = require('./routes/payments');
const paymentTypeRoutes = require('./routes/paymentTypes');
const transactionRoutes = require('./routes/transactions');
// const paymentGatewayRoutes = require('./routes/paymentGateway');
const reportRoutes = require('./routes/reports');
const errorHandler = require('./middleware/errorHandler');
const adminRoutes = require('./routes/adminRoutes');
const app = express();

// ==================== SECURITY MIDDLEWARE ====================

// 1. Helmet - Sets secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'fonts.googleapis.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:'],
      fontSrc: ["'self'", 'https:', 'data:', 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// 2. CORS with enhanced security
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400, // 24 hours
}));

// 3. Rate Limiting - Prevent brute force attacks
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 400, // Limit each IP to 400 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    message: 'Too many login attempts, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use('/api', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

// 4. Body parsing with size limits (prevent DOS attacks)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// 5. Compression - Compress responses for better performance
app.use(compression());

// 6. Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// 7. Data sanitization against XSS attacks
app.use(xss());

// 8. Prevent HTTP Parameter Pollution
app.use(hpp({
  whitelist: ['page', 'limit', 'sort', 'startDate', 'endDate', 'search', 'type', 'status']
}));

// 9. Session configuration - FIXED VERSION (works in both development and production)
// Check if MongoDB URI is available for session store
const mongoUri = process.env.MONGODB_URI;
const useSessionStore = mongoUri && (process.env.NODE_ENV === 'production');

// Create session store only if MongoDB is available
let sessionStore = null;
if (useSessionStore) {
  try {
    sessionStore = MongoStore.create({
      mongoUrl: mongoUri,
      ttl: 24 * 60 * 60, // 1 day
      autoRemove: 'native',
      touchAfter: 24 * 3600 // lazy session update
    });
    console.log('✅ Session store initialized with MongoDB');
  } catch (error) {
    console.error('❌ Failed to initialize session store:', error.message);
    console.log('⚠️ Continuing without session store');
  }
}

// Session middleware configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'your-session-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    sameSite: 'lax',
  },
  name: 'sessionId',
};

// Add store only if successfully created
if (sessionStore) {
  sessionConfig.store = sessionStore;
}

app.use(session(sessionConfig));

// 10. Custom security headers
app.use((req, res, next) => {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');
  
  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Strict Transport Security (HSTS) - only in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  
  next();
});

// Static files (if needed for uploads) - with security
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1d', // Cache for 1 day
  etag: true,
  lastModified: true,
}));

// ==================== LOGGING (Development only) ====================
if (process.env.NODE_ENV === 'development') {
  const morgan = require('morgan');
  app.use(morgan('dev'));
}

// ==================== API ROUTES ====================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    services: {
      payments: true,
      paymentTypes: true,
      auth: true,
      users: true
    }
  });
});

// API Info route (with security - only show in development)
app.get('/api', (req, res) => {
  const info = {
    name: 'Payment Management API',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  };
  
  // Only show endpoints in development
  if (process.env.NODE_ENV === 'development') {
    info.endpoints = {
      auth: '/api/auth',
      users: '/api/users',
      payments: '/api/payments',
      paymentTypes: '/api/payment-types',
      transactions: '/api/transactions',
      reports: '/api/reports',
      paymentGateway: '/api/payment-gateway'
    };
  }
  
  res.json(info);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/payment-types', paymentTypeRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/organizations', organizationRoutes);

// Add this BEFORE the payment gateway routes
app.use(express.json({ 
  limit: '10kb',
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString();
  }
}));

// Then your payment gateway routes
const paymentGatewayRoutes = require('./routes/paymentGateway');
app.use('/api/payment-gateway', paymentGatewayRoutes);

// ==================== PAYMENT GATEWAY ROUTES ====================

// ==================== ERROR HANDLING ====================

// 404 handler for undefined routes (must be before error handler)
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
});

// Global error handling middleware (should be last)
app.use(errorHandler);

module.exports = app;