'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncWrap } = require('../middleware/errorHandler');

// All admin routes require auth + admin/pmc_officer role
router.use(requireAuth);
router.use(requireRole('admin', 'pmc_officer'));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/admin/stats/:cityId
// Dashboard stats for a city
// ═══════════════════════════════════════════════════════════
router.get('/stats/:cityId', asyncWrap(async (req, res) => {
  const { cityId } = req.params;

  const { rows } = await query(
    `SELECT
      COUNT(*) FILTER (WHERE status = 'filed') AS new_count,
      COUNT(*) FILTER (WHERE status IN ('received','acknowledged','in_progress')) AS active_count,
      COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_count,
      COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count,
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today_count,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS week_count,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'resolved') / NULLIF(COUNT(*), 0),
        1
      ) AS resolution_rate_pct
     FROM grievances WHERE city_id = $1`,
    [cityId]
  );

  // Category breakdown
  const { rows: byCategory } = await query(
    `SELECT category, COUNT(*) AS count,
            COUNT(*) FILTER (WHERE status = 'resolved') AS resolved
     FROM grievances WHERE city_id = $1
     GROUP BY category ORDER BY count DESC`,
    [cityId]
  );

  // Ward breakdown (top 10 by complaints)
  const { rows: byWard } = await query(
    `SELECT ward_id, ward_name, COUNT(*) AS count,
            COUNT(*) FILTER (WHERE status = 'resolved') AS resolved
     FROM grievances WHERE city_id = $1 AND ward_id IS NOT NULL
     GROUP BY ward_id, ward_name ORDER BY count DESC LIMIT 10`,
    [cityId]
  );

  // User count
  const { rows: userStats } = await query(
    `SELECT COUNT(*) AS total_users,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_week
     FROM users WHERE city_id = $1`,
    [cityId]
  );

  res.json({
    grievances: rows[0],
    byCategory,
    byWard,
    users: userStats[0],
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/admin/grievances
// All grievances with filters (paginated)
// ═══════════════════════════════════════════════════════════
router.get('/grievances', asyncWrap(async (req, res) => {
  const { cityId = 'pune', status, category, wardId, page = '1', limit = '20' } = req.query;

  const conditions = ['g.city_id = $1'];
  const params = [cityId];
  let p = 2;

  if (status)   { conditions.push(`g.status = $${p++}`);    params.push(status); }
  if (category) { conditions.push(`g.category = $${p++}`);  params.push(category); }
  if (wardId)   { conditions.push(`g.ward_id = $${p++}`);   params.push(wardId); }

  const where = conditions.join(' AND ');
  const lim   = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * lim;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT g.id, g.ref_code, g.category, g.description, g.status, g.priority,
              g.ward_id, g.ward_name, g.gps_lat, g.gps_lng,
              g.photo_url, g.is_public, g.upvotes, g.view_count,
              g.rep_type, g.rep_name, g.email_sent,
              g.created_at, g.updated_at, g.resolved_at,
              u.email AS user_email, u.phone AS user_phone, LEFT(u.name, 50) AS user_name,
              au.name AS assigned_to_name
       FROM grievances g
       LEFT JOIN users u ON u.id = g.user_id
       LEFT JOIN users au ON au.id = g.assigned_to
       WHERE ${where}
       ORDER BY g.created_at DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, lim, offset]
    ),
    query(`SELECT COUNT(*) FROM grievances g WHERE ${where}`, params),
  ]);

  res.json({
    data: rows,
    pagination: {
      page: parseInt(page, 10), limit: lim,
      total: parseInt(countRows[0].count, 10),
      pages: Math.ceil(parseInt(countRows[0].count, 10) / lim),
    },
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/admin/heatmap/:cityId
// Grievance heatmap data (lat/lng + category per grievance)
// ═══════════════════════════════════════════════════════════
router.get('/heatmap/:cityId', asyncWrap(async (req, res) => {
  const { category, status, days = '30' } = req.query;

  const conditions = [
    `city_id = $1`,
    `gps_lat IS NOT NULL`,
    `created_at > NOW() - INTERVAL '${parseInt(days, 10)} days'`,
  ];
  const params = [req.params.cityId];
  let p = 2;

  if (category) { conditions.push(`category = $${p++}`); params.push(category); }
  if (status)   { conditions.push(`status = $${p++}`);   params.push(status); }

  const { rows } = await query(
    `SELECT gps_lat AS lat, gps_lng AS lng, category, status, ward_id
     FROM grievances WHERE ${conditions.join(' AND ')} LIMIT 5000`,
    params
  );

  res.json(rows);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET/PUT /api/admin/settings
// App settings (admin only)
// ═══════════════════════════════════════════════════════════
router.get('/settings', requireRole('admin'), asyncWrap(async (req, res) => {
  const { rows } = await query('SELECT key, value, description FROM app_settings ORDER BY key');
  res.json(rows);
}));

router.put('/settings/:key', requireRole('admin'), asyncWrap(async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  const { rows } = await query(
    `UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = $2 RETURNING *`,
    [String(value), req.params.key]
  );
  if (!rows.length) return res.status(404).json({ error: 'Setting not found' });
  res.json(rows[0]);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/admin/users (admin only)
// ═══════════════════════════════════════════════════════════
router.get('/users', requireRole('admin'), asyncWrap(async (req, res) => {
  const { page = '1', limit = '50', cityId = 'pune' } = req.query;
  const lim    = Math.min(100, parseInt(limit, 10));
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * lim;

  const { rows } = await query(
    `SELECT id, email, phone, name, role, city_id, ward_id, is_active,
            grievance_count, last_login_at, created_at
     FROM users WHERE city_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [cityId, lim, offset]
  );

  res.json(rows);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/admin/create-admin
// Create first admin account (requires ADMIN_SECRET header)
// ═══════════════════════════════════════════════════════════
router.post('/create-admin', asyncWrap(async (req, res) => {
  // Override role check — this route uses ADMIN_SECRET instead
  const { adminSecret, userId } = req.body;

  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Invalid admin secret', code: 'INVALID_SECRET' });
  }

  const targetId = userId || req.user.id;
  const { rows } = await query(
    `UPDATE users SET role = 'admin' WHERE id = $1 RETURNING id, email, phone, role`,
    [targetId]
  );

  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, user: rows[0] });
}));

module.exports = router;
