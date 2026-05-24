'use strict';
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { query } = require('../config/db');
const { issueOTP, verifyOTP } = require('../services/otp');
const { sendOTPEmail } = require('../services/email');
const { sendOTPSMS, normalizeIndianPhone, isValidIndianPhone } = require('../services/sms');
const { requireAuth } = require('../middleware/auth');
const { otpLimiter, authLimiter } = require('../middleware/rateLimit');
const { asyncWrap } = require('../middleware/errorHandler');
const { JWT_ACCESS_EXPIRY, JWT_REFRESH_EXPIRY, JWT_REFRESH_EXPIRY_MS } = require('../config/constants');

// ── Helpers ──────────────────────────────────────────────────

/**
 * Generate JWT access token (short-lived: 1 hour)
 */
const signAccessToken = (userId, role) => jwt.sign(
  { userId, role },
  process.env.JWT_SECRET,
  { expiresIn: JWT_ACCESS_EXPIRY }
);

/**
 * Generate JWT refresh token (long-lived: 30 days)
 * The token itself is a signed JWT; we store its SHA-256 hash in DB for revocation.
 */
const signRefreshToken = (userId) => jwt.sign(
  { userId, type: 'refresh' },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: JWT_REFRESH_EXPIRY }
);

/**
 * Hash a token for storage (never store raw tokens)
 */
const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

/**
 * Persist a refresh token in DB.
 */
const storeRefreshToken = async (userId, refreshToken, req) => {
  const hash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + JWT_REFRESH_EXPIRY_MS);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      hash,
      req.headers['user-agent']?.substring(0, 500) || null,
      req.ip,
      expiresAt,
    ]
  );
};

/**
 * Find or create a user by email or phone.
 * Nagrik OS uses "magic link" style auth — no password needed.
 */
const findOrCreateUser = async (field, value, cityId = 'pune') => {
  const col = field === 'email' ? 'email' : 'phone';

  // Try to find existing user
  const { rows } = await query(
    `SELECT id, email, phone, name, role, city_id, ward_id, ward_name, is_active 
     FROM users WHERE ${col} = $1`,
    [value.toLowerCase()]
  );

  if (rows.length) {
    const user = rows[0];
    if (!user.is_active) {
      throw Object.assign(new Error('Your account has been deactivated. Please contact support.'), { status: 403 });
    }
    // Update last_login_at
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    return { user, isNew: false };
  }

  // Create new user
  const insertData = col === 'email'
    ? { email: value.toLowerCase(), phone: null }
    : { email: null, phone: normalizeIndianPhone(value) };

  const { rows: newRows } = await query(
    `INSERT INTO users (email, phone, city_id, is_verified, last_login_at)
     VALUES ($1, $2, $3, true, NOW())
     RETURNING id, email, phone, name, role, city_id, ward_id, ward_name, is_active`,
    [insertData.email, insertData.phone, cityId]
  );

  return { user: newRows[0], isNew: true };
};

/**
 * Build the auth response payload (user info + tokens).
 */
const buildAuthResponse = (user, accessToken, refreshToken, isNew) => ({
  accessToken,
  refreshToken,
  isNew,
  user: {
    id:        user.id,
    email:     user.email,
    phone:     user.phone,
    name:      user.name,
    role:      user.role,
    cityId:    user.city_id,
    wardId:    user.ward_id,
    wardName:  user.ward_name,
  },
});

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/send-email-otp
// Send OTP to email address
// ═══════════════════════════════════════════════════════════
router.post('/send-email-otp', otpLimiter, asyncWrap(async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required', code: 'MISSING_EMAIL' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email address', code: 'INVALID_EMAIL' });
  }

  // Check app setting
  const { rows: settings } = await query(
    `SELECT value FROM app_settings WHERE key = 'otp_enabled_email'`
  );
  if (settings[0]?.value === 'false') {
    return res.status(503).json({ error: 'Email login is temporarily disabled', code: 'FEATURE_DISABLED' });
  }

  const otp = await issueOTP(email.trim().toLowerCase(), 'email');

  try {
    await sendOTPEmail(email.trim().toLowerCase(), otp);
  } catch (emailErr) {
    console.error('[Auth] Email send failed:', emailErr.message);
    return res.status(503).json({ error: 'Failed to send email. Please try again.', code: 'EMAIL_FAILED' });
  }

  const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);
  res.json({
    success: true,
    message: `OTP sent to ${email.trim().toLowerCase().replace(/(?<=.{3}).(?=.*@)/g, '*')}`,
    expiresIn: expiryMinutes * 60, // Seconds
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/verify-email-otp
// Verify OTP and return JWT tokens
// ═══════════════════════════════════════════════════════════
router.post('/verify-email-otp', authLimiter, asyncWrap(async (req, res) => {
  const { email, otp, cityId = 'pune' } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required', code: 'MISSING_FIELDS' });
  }
  if (!/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'OTP must be a 6-digit number', code: 'INVALID_OTP_FORMAT' });
  }

  const verification = await verifyOTP(email.trim().toLowerCase(), 'email', otp.trim());
  if (!verification.valid) {
    return res.status(401).json({
      error: verification.message,
      code: verification.reason,
      attemptsRemaining: verification.attemptsRemaining,
    });
  }

  const { user, isNew } = await findOrCreateUser('email', email.trim(), cityId);
  const accessToken  = signAccessToken(user.id, user.role);
  const refreshToken = signRefreshToken(user.id);
  await storeRefreshToken(user.id, refreshToken, req);

  res.json(buildAuthResponse(user, accessToken, refreshToken, isNew));
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/send-phone-otp
// ═══════════════════════════════════════════════════════════
router.post('/send-phone-otp', otpLimiter, asyncWrap(async (req, res) => {
  const { phone } = req.body;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'Phone number is required', code: 'MISSING_PHONE' });
  }
  if (!isValidIndianPhone(phone.trim())) {
    return res.status(400).json({ error: 'Invalid Indian mobile number (10 digits, starts with 6-9)', code: 'INVALID_PHONE' });
  }

  const { rows: settings } = await query(`SELECT value FROM app_settings WHERE key = 'otp_enabled_phone'`);
  if (settings[0]?.value === 'false') {
    return res.status(503).json({ error: 'Phone login is temporarily disabled', code: 'FEATURE_DISABLED' });
  }

  const normalized = normalizeIndianPhone(phone.trim());
  const otp = await issueOTP(normalized, 'phone');

  try {
    await sendOTPSMS(normalized, otp);
  } catch (smsErr) {
    console.error('[Auth] SMS send failed:', smsErr.message);
    return res.status(503).json({ error: 'Failed to send SMS. Please try again.', code: 'SMS_FAILED' });
  }

  const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);
  const maskedPhone = normalized.replace(/(\+91)(\d{2})\d{6}(\d{2})/, '$1$2XXXXXX$3');
  res.json({ success: true, message: `OTP sent to ${maskedPhone}`, expiresIn: expiryMinutes * 60 });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/verify-phone-otp
// ═══════════════════════════════════════════════════════════
router.post('/verify-phone-otp', authLimiter, asyncWrap(async (req, res) => {
  const { phone, otp, cityId = 'pune' } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required', code: 'MISSING_FIELDS' });
  }
  if (!isValidIndianPhone(phone.trim())) {
    return res.status(400).json({ error: 'Invalid phone number', code: 'INVALID_PHONE' });
  }
  if (!/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'OTP must be a 6-digit number', code: 'INVALID_OTP_FORMAT' });
  }

  const normalized = normalizeIndianPhone(phone.trim());
  const verification = await verifyOTP(normalized, 'phone', otp.trim());
  if (!verification.valid) {
    return res.status(401).json({
      error: verification.message,
      code: verification.reason,
      attemptsRemaining: verification.attemptsRemaining,
    });
  }

  const { user, isNew } = await findOrCreateUser('phone', normalized, cityId);
  const accessToken  = signAccessToken(user.id, user.role);
  const refreshToken = signRefreshToken(user.id);
  await storeRefreshToken(user.id, refreshToken, req);

  res.json(buildAuthResponse(user, accessToken, refreshToken, isNew));
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/refresh
// Exchange a valid refresh token for a new access token
// ═══════════════════════════════════════════════════════════
router.post('/refresh', asyncWrap(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required', code: 'MISSING_TOKEN' });
  }

  // Verify JWT signature first (fast, no DB hit)
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'INVALID_REFRESH_TOKEN' });
  }

  if (decoded.type !== 'refresh') {
    return res.status(401).json({ error: 'Invalid token type', code: 'INVALID_TOKEN_TYPE' });
  }

  // Verify token exists in DB and is not revoked
  const hash = hashToken(refreshToken);
  const { rows } = await query(
    `SELECT rt.id, u.id AS user_id, u.role, u.is_active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
    [hash]
  );

  if (!rows.length) {
    return res.status(401).json({ error: 'Refresh token revoked or expired. Please log in again.', code: 'TOKEN_REVOKED' });
  }

  const { user_id, role, is_active } = rows[0];
  if (!is_active) {
    return res.status(403).json({ error: 'Account deactivated', code: 'USER_INACTIVE' });
  }

  // Rotate refresh token (revoke old, issue new)
  await query('UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1', [hash]);
  const newRefreshToken = signRefreshToken(user_id);
  const newAccessToken  = signAccessToken(user_id, role);
  await storeRefreshToken(user_id, newRefreshToken, req);

  res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/auth/logout
// Revoke a refresh token
// ═══════════════════════════════════════════════════════════
router.post('/logout', asyncWrap(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const hash = hashToken(refreshToken);
    await query(
      'UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1',
      [hash]
    );
  }
  res.json({ success: true, message: 'Logged out successfully' });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/auth/me
// Get current user profile
// ═══════════════════════════════════════════════════════════
router.get('/me', requireAuth, asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.phone, u.name, u.role, u.city_id, u.ward_id, u.ward_name,
            u.grievance_count, u.created_at,
            c.name AS city_name
     FROM users u
     LEFT JOIN cities c ON c.id = u.city_id
     WHERE u.id = $1`,
    [req.user.id]
  );
  res.json(rows[0]);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: PUT /api/auth/profile
// Update user profile (name, ward)
// ═══════════════════════════════════════════════════════════
router.put('/profile', requireAuth, asyncWrap(async (req, res) => {
  const { name, wardId, wardName, cityId } = req.body;

  const updates = [];
  const params  = [];
  let i = 1;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be 2–100 characters', code: 'INVALID_NAME' });
    }
    updates.push(`name = $${i++}`); params.push(name.trim());
  }
  if (wardId !== undefined)   { updates.push(`ward_id = $${i++}`);   params.push(wardId); }
  if (wardName !== undefined) { updates.push(`ward_name = $${i++}`); params.push(wardName); }
  if (cityId !== undefined)   { updates.push(`city_id = $${i++}`);   params.push(cityId); }

  if (!updates.length) {
    return res.status(400).json({ error: 'No fields to update', code: 'NO_UPDATES' });
  }

  updates.push(`updated_at = NOW()`);
  params.push(req.user.id);

  const { rows } = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, email, phone, name, role, city_id, ward_id, ward_name`,
    params
  );

  res.json(rows[0]);
}));

module.exports = router;
