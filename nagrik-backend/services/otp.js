'use strict';
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS, OTP_LENGTH, OTP_BCRYPT_ROUNDS } = require('../config/constants');

/**
 * Generate a cryptographically random 6-digit OTP string.
 * Uses Math.random seeded with Date for simplicity.
 * For higher security, swap with: require('crypto').randomInt(100000, 999999).toString()
 */
const generateOTP = () => {
  const { randomInt } = require('crypto');
  const otp = randomInt(100000, 999999).toString();
  return otp;
};

/**
 * Issue a new OTP for an identifier (email or phone).
 * Invalidates any previous unused OTPs for the same identifier.
 * Returns the plain-text OTP (to be sent to user via email/SMS).
 *
 * @param {string} identifier - Email or phone number
 * @param {string} type - 'email' | 'phone'
 * @returns {Promise<string>} Plain-text OTP
 */
const issueOTP = async (identifier, type) => {
  const otp = generateOTP();
  const hash = await bcrypt.hash(otp, OTP_BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Invalidate all previous OTPs for this identifier (best practice)
  await query(
    `UPDATE otp_codes SET used = true
     WHERE identifier = $1 AND identifier_type = $2 AND used = false`,
    [identifier.toLowerCase(), type]
  );

  // Insert new OTP
  await query(
    `INSERT INTO otp_codes (identifier, identifier_type, otp_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [identifier.toLowerCase(), type, hash, expiresAt]
  );

  return otp;
};

/**
 * Verify an OTP submitted by the user.
 *
 * @param {string} identifier - Email or phone
 * @param {string} type - 'email' | 'phone'
 * @param {string} submittedOTP - 6-digit string from user
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
const verifyOTP = async (identifier, type, submittedOTP) => {
  // Get the latest valid OTP record for this identifier
  const { rows } = await query(
    `SELECT id, otp_hash, attempts, expires_at, used
     FROM otp_codes
     WHERE identifier = $1
       AND identifier_type = $2
       AND used = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [identifier.toLowerCase(), type]
  );

  if (!rows.length) {
    return { valid: false, reason: 'NO_OTP', message: 'No OTP found. Please request a new one.' };
  }

  const record = rows[0];

  // Check expiry
  if (new Date() > new Date(record.expires_at)) {
    await query('UPDATE otp_codes SET used = true WHERE id = $1', [record.id]);
    return { valid: false, reason: 'EXPIRED', message: 'OTP has expired. Please request a new one.' };
  }

  // Check attempt limit
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await query('UPDATE otp_codes SET used = true WHERE id = $1', [record.id]);
    return { valid: false, reason: 'MAX_ATTEMPTS', message: 'Too many wrong attempts. Please request a new OTP.' };
  }

  // Verify OTP
  const isMatch = await bcrypt.compare(submittedOTP.trim(), record.otp_hash);

  if (!isMatch) {
    // Increment attempt counter
    await query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1',
      [record.id]
    );
    const remaining = OTP_MAX_ATTEMPTS - (record.attempts + 1);
    return {
      valid: false,
      reason: 'WRONG_OTP',
      message: `Incorrect OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      attemptsRemaining: remaining,
    };
  }

  // Mark as used
  await query('UPDATE otp_codes SET used = true WHERE id = $1', [record.id]);

  return { valid: true };
};

module.exports = { issueOTP, verifyOTP };
