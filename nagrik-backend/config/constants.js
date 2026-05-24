'use strict';

module.exports = {
  // ── JWT ──────────────────────────────────────────────────
  JWT_ACCESS_EXPIRY:  process.env.JWT_ACCESS_EXPIRY  || '1h',
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || '30d',
  JWT_REFRESH_EXPIRY_MS: 30 * 24 * 60 * 60 * 1000,  // 30 days in ms

  // ── OTP ──────────────────────────────────────────────────
  OTP_EXPIRY_MINUTES: parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10),
  OTP_MAX_ATTEMPTS:   parseInt(process.env.OTP_MAX_ATTEMPTS   || '3', 10),
  OTP_LENGTH: 6,
  OTP_BCRYPT_ROUNDS: 10,

  // ── UPLOAD ───────────────────────────────────────────────
  MAX_PHOTO_SIZE_MB:  parseInt(process.env.MAX_PHOTO_SIZE_MB || '5', 10),
  ALLOWED_PHOTO_TYPES: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],

  // ── PAGINATION ───────────────────────────────────────────
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,

  // ── GRIEVANCES ───────────────────────────────────────────
  GRIEVANCE_CATEGORIES: [
    'Roads & Potholes',
    'Water Supply',
    'Sewage & Waterlogging',
    'Garbage & Sanitation',
    'Streetlights',
    'Encroachment',
    "Women's Safety",
    'Electricity / MSEDCL',
    'Traffic & Signals',
    'Construction without permit',
    'Corruption',
    'Stray Animals',
    'Other',
  ],

  GRIEVANCE_STATUSES: ['filed', 'received', 'acknowledged', 'in_progress', 'resolved', 'rejected', 'closed'],

  // ── USER ROLES ───────────────────────────────────────────
  ROLES: {
    CITIZEN:     'citizen',
    MODERATOR:   'moderator',
    ADMIN:       'admin',
    PMC_OFFICER: 'pmc_officer',
  },

  // ── RATE LIMITS ──────────────────────────────────────────
  OTP_WINDOW_MS:    parseInt(process.env.OTP_RATE_LIMIT_WINDOW || '900000', 10), // 15 min
  OTP_WINDOW_MAX:   parseInt(process.env.OTP_RATE_LIMIT_MAX    || '3', 10),
  API_WINDOW_MS:    60 * 1000,    // 1 minute
  API_WINDOW_MAX:   100,          // 100 requests per minute per IP
};
