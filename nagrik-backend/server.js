'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression = require('compression');
const path       = require('path');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimit');
const { ping } = require('./config/db');

// Routes
const authRoutes        = require('./routes/auth');
const grievanceRoutes   = require('./routes/grievances');
const ratingRoutes      = require('./routes/ratings');
const repRoutes         = require('./routes/representatives');
const cityRoutes        = require('./routes/cities');
const adminRoutes       = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (required for rate limiting on Render/Railway) ─
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com', 'https://tile.openstreetmap.org'],
  styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://unpkg.com', 'https://tile.openstreetmap.org'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'https://api.resend.com', 'https://www.fast2sms.com', 'https://unpkg.com', 'https://*.tile.openstreetmap.org'],
      imgSrc:     ["'self'", 'data:', 'https://res.cloudinary.com', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000').split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} is not permitted`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.options('*', cors()); // Pre-flight for all routes

// ── Body parsers ──────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '15mb' })); // 15MB for base64 photos (~5MB photo = ~7MB base64)
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ── Request logger (development) ──────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// ── Static files (auth.html lives here) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { dbOk = await ping(); } catch (e) { /* ignore */ }
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    db:        dbOk ? 'connected' : 'error',
    version:   '1.0.0',
    env:       process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// ── API routes (rate limited globally) ───────────────────────
app.use('/api', apiLimiter);
app.use('/api/auth',        authRoutes);
app.use('/api/grievances',  grievanceRoutes);
app.use('/api/ratings',     ratingRoutes);
app.use('/api/reps',        repRoutes);
app.use('/api/cities',      cityRoutes);
app.use('/api/admin',       adminRoutes);

// ── Auth page: serve auth.html for /login route ───────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// ── 404 + error handlers (MUST be last) ──────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const border = '═'.repeat(42);
  console.log(`\n╔${border}╗`);
  console.log(`║   NAGRIK OS BACKEND   ·   v1.0.0          ║`);
  console.log(`║   Port: ${PORT.toString().padEnd(5)}  Env: ${(process.env.NODE_ENV || 'development').padEnd(15)}  ║`);
  console.log(`║   Auth page: http://localhost:${PORT}/login    ║`);
  console.log(`╚${border}╝\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => { console.error('[Server] Forced exit'); process.exit(1); }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => { console.error('[UNCAUGHT]', err); process.exit(1); });
process.on('unhandledRejection', err => { console.error('[UNHANDLED]', err); });

module.exports = app;
