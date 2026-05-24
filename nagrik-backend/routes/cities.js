'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { asyncWrap } = require('../middleware/errorHandler');

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/cities
// List all active cities
// ═══════════════════════════════════════════════════════════
router.get('/', asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, name_hindi, state, active, beta,
            ward_count, corp_count, center_lat, center_lng, default_zoom
     FROM cities ORDER BY active DESC, name ASC`
  );
  res.json(rows);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/cities/:id
// Single city info with grievance/rating summary
// ═══════════════════════════════════════════════════════════
router.get('/:id', asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, 
            (SELECT COUNT(*) FROM grievances g WHERE g.city_id = c.id) AS grievance_count,
            (SELECT COUNT(*) FROM grievances g WHERE g.city_id = c.id AND g.status = 'resolved') AS resolved_count,
            (SELECT COUNT(*) FROM ratings r WHERE r.city_id = c.id) AS ratings_count
     FROM cities c WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'City not found' });
  res.json(rows[0]);
}));

module.exports = router;
