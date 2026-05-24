'use strict';

/**
 * 404 handler — must be registered AFTER all routes
 */
const notFound = (req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
    code: 'NOT_FOUND',
  });
};

/**
 * Global error handler — must be registered LAST with 4 params
 * Catches any error thrown with next(err) or by async handlers
 */
const errorHandler = (err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}`);
  console.error(err);

  // PostgreSQL errors
  if (err.code === '23505') {  // Unique violation
    return res.status(409).json({
      error: 'A record with this value already exists',
      code: 'DUPLICATE',
      detail: process.env.NODE_ENV === 'development' ? err.detail : undefined,
    });
  }
  if (err.code === '23503') {  // Foreign key violation
    return res.status(400).json({ error: 'Referenced record does not exist', code: 'FK_VIOLATION' });
  }
  if (err.code === '23502') {  // Not null violation
    return res.status(400).json({ error: 'Required field is missing', code: 'NULL_VIOLATION' });
  }
  if (err.code === '22P02') {  // Invalid UUID format
    return res.status(400).json({ error: 'Invalid ID format', code: 'INVALID_UUID' });
  }

  // JWT errors (should be caught in middleware but just in case)
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large', code: 'FILE_TOO_LARGE' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field', code: 'UNEXPECTED_FILE' });
  }

  // Generic
  const status = err.status || err.statusCode || 500;
  const message = (status < 500 || process.env.NODE_ENV === 'development')
    ? err.message
    : 'Internal server error';

  res.status(status).json({
    error: message,
    code: err.code || 'SERVER_ERROR',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/**
 * Async wrapper — eliminates try/catch boilerplate in route handlers.
 * Usage: router.get('/path', asyncWrap(async (req, res) => { ... }))
 */
const asyncWrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { notFound, errorHandler, asyncWrap };
