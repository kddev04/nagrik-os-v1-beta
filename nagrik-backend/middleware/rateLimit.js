'use strict';
const rateLimit = require('express-rate-limit');
const { OTP_WINDOW_MS, OTP_WINDOW_MAX, API_WINDOW_MS, API_WINDOW_MAX } = require('../config/constants');

const jsonReply = (res, code, msg) =>
  res.status(code).json({ error: msg, code: 'RATE_LIMITED' });

/**
 * OTP Rate Limiter
 * Max 3 OTP send requests per IP per 15 minutes.
 * Prevents OTP bombing / brute force.
 */
const otpLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: OTP_WINDOW_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key by IP + identifier (email/phone) to prevent multi-IP abuse
    const identifier = req.body?.email || req.body?.phone || 'unknown';
    return `${req.ip}:${identifier}`;
  },
  handler: (req, res) =>
    jsonReply(res, 429, `Too many OTP requests. Please wait 15 minutes before trying again.`),
});

/**
 * Auth Rate Limiter
 * Max 10 auth attempts per IP per 15 minutes.
 */
const authLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    jsonReply(res, 429, 'Too many login attempts. Please try again in 15 minutes.'),
});

/**
 * General API Rate Limiter
 * 100 requests per minute per IP for general routes.
 */
const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_WINDOW_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    jsonReply(res, 429, 'Too many requests. Please slow down.'),
});

/**
 * Grievance Submit Limiter
 * Max 5 grievance submissions per IP per hour (prevents spam).
 */
const grievanceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) =>
    jsonReply(res, 429, 'You can submit a maximum of 5 grievances per hour. Please try later.'),
});

module.exports = { otpLimiter, authLimiter, apiLimiter, grievanceLimiter };
