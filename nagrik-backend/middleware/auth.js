'use strict';
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

/**
 * requireAuth — Verifies JWT access token.
 * Attaches decoded user payload to req.user.
 * Responds 401 if token is missing/invalid/expired.
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'NO_TOKEN',
      });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          error: 'Token expired. Please refresh.',
          code: 'TOKEN_EXPIRED',
        });
      }
      return res.status(401).json({ 
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
    }

    // Verify user still exists and is active
    const { rows } = await query(
      'SELECT id, email, phone, name, role, city_id, ward_id, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ 
        error: 'Account not found or deactivated',
        code: 'USER_INACTIVE',
      });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    console.error('[Auth Middleware]', err);
    return res.status(500).json({ error: 'Auth check failed' });
  }
};

/**
 * optionalAuth — Tries to verify JWT but continues even without one.
 * Useful for endpoints that are public but show extra data to logged-in users.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query(
        'SELECT id, email, phone, name, role, city_id, ward_id FROM users WHERE id = $1 AND is_active = true',
        [decoded.userId]
      );
      req.user = rows[0] || null;
    } catch {
      req.user = null;
    }
    next();
  } catch (err) {
    req.user = null;
    next();
  }
};

/**
 * requireRole — Checks user has at least the specified role.
 * Must be used AFTER requireAuth.
 *
 * Usage: router.delete('/grievance/:id', requireAuth, requireRole('admin'), handler)
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ 
      error: 'Insufficient permissions',
      required: roles,
      current: req.user.role,
    });
  }
  next();
};

module.exports = { requireAuth, optionalAuth, requireRole };
