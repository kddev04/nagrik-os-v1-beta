'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncWrap } = require('../middleware/errorHandler');

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/ratings
// Submit or update a ward rating (1 per user per ward)
// ═══════════════════════════════════════════════════════════
router.post('/', requireAuth, asyncWrap(async (req, res) => {
  const { cityId = 'pune', wardId, satisfaction, safety } = req.body;

  if (!wardId || typeof wardId !== 'number' && isNaN(parseInt(wardId, 10))) {
    return res.status(400).json({ error: 'Ward ID is required', code: 'MISSING_WARD' });
  }
  if (!satisfaction || satisfaction < 1 || satisfaction > 5) {
    return res.status(400).json({ error: 'Satisfaction must be 1–5', code: 'INVALID_SATISFACTION' });
  }
  if (!safety || safety < 1 || safety > 5) {
    return res.status(400).json({ error: 'Safety must be 1–5', code: 'INVALID_SAFETY' });
  }

  const wId = parseInt(wardId, 10);

  // Upsert: insert or update if user already rated this ward
  const { rows } = await query(
    `INSERT INTO ratings (user_id, city_id, ward_id, satisfaction, safety)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, city_id, ward_id)
     DO UPDATE SET satisfaction = EXCLUDED.satisfaction,
                   safety       = EXCLUDED.safety,
                   updated_at   = NOW()
     RETURNING id, ward_id, satisfaction, safety, created_at, updated_at`,
    [req.user.id, cityId, wId, parseInt(satisfaction, 10), parseInt(safety, 10)]
  );

  // Return updated aggregate for this ward
  const { rows: agg } = await query(
    `SELECT ROUND(AVG(satisfaction)::NUMERIC, 2) AS avg_satisfaction,
            ROUND(AVG(safety)::NUMERIC, 2) AS avg_safety,
            COUNT(*) AS rating_count
     FROM ratings
     WHERE city_id = $1 AND ward_id = $2`,
    [cityId, wId]
  );

  res.json({
    success: true,
    yourRating: rows[0],
    wardAggregate: agg[0],
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/ratings/city/:cityId
// All ward aggregated ratings for a city (for heatmap)
// ═══════════════════════════════════════════════════════════
router.get('/city/:cityId', asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ward_id, avg_satisfaction, avg_safety, rating_count
     FROM ward_ratings_agg
     WHERE city_id = $1
     ORDER BY ward_id`,
    [req.params.cityId]
  );
  res.json(rows);
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/ratings/ward/:wardId
// Single ward aggregated rating + current user's rating (if auth)
// ═══════════════════════════════════════════════════════════
router.get('/ward/:wardId', optionalAuth, asyncWrap(async (req, res) => {
  const { cityId = 'pune' } = req.query;
  const wardId = parseInt(req.params.wardId, 10);

  const [{ rows: agg }, userRows] = await Promise.all([
    query(
      `SELECT ward_id, avg_satisfaction, avg_safety, rating_count
       FROM ward_ratings_agg WHERE city_id = $1 AND ward_id = $2`,
      [cityId, wardId]
    ),
    req.user
      ? query(
          `SELECT satisfaction, safety, updated_at FROM ratings
           WHERE user_id = $1 AND city_id = $2 AND ward_id = $3`,
          [req.user.id, cityId, wardId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  res.json({
    aggregate: agg[0] || { ward_id: wardId, avg_satisfaction: null, avg_safety: null, rating_count: 0 },
    yourRating: userRows.rows[0] || null,
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/ratings/mine
// All ratings submitted by the current user
// ═══════════════════════════════════════════════════════════
router.get('/mine', requireAuth, asyncWrap(async (req, res) => {
  const { cityId = 'pune' } = req.query;
  const { rows } = await query(
    `SELECT ward_id, satisfaction, safety, updated_at
     FROM ratings WHERE user_id = $1 AND city_id = $2 ORDER BY ward_id`,
    [req.user.id, cityId]
  );
  // Return as a map: { wardId: { satisfaction, safety } }
  const ratingsMap = {};
  rows.forEach(r => { ratingsMap[r.ward_id] = { satisfaction: r.satisfaction, safety: r.safety, updatedAt: r.updated_at }; });
  res.json(ratingsMap);
}));
// ─────────────────────────────────────────────────────────────
// ROUTE: POST /api/ratings/rep
// Rate an MLA / MP / Corp (separate table from ward ratings)
// ─────────────────────────────────────────────────────────────
router.post('/rep', requireAuth, asyncWrap(async (req, res) => {
  const { cityId = 'pune', repType, repId, satisfaction, safety } = req.body;

  if (!['mla', 'mp', 'corp'].includes(repType)) {
    return res.status(400).json({ error: 'repType must be mla, mp, or corp', code: 'INVALID_TYPE' });
  }
  if (!repId || typeof repId !== 'string') {
    return res.status(400).json({ error: 'repId is required', code: 'MISSING_REP_ID' });
  }
  if (!satisfaction || satisfaction < 1 || satisfaction > 5) {
    return res.status(400).json({ error: 'Satisfaction must be 1–5', code: 'INVALID_SATISFACTION' });
  }
  if (safety !== undefined && safety !== null && (safety < 1 || safety > 5)) {
    return res.status(400).json({ error: 'Safety must be 1–5 or null', code: 'INVALID_SAFETY' });
  }

  const { rows } = await query(
    `INSERT INTO rep_ratings (user_id, city_id, rep_type, rep_id, satisfaction, safety)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, city_id, rep_type, rep_id)
     DO UPDATE SET satisfaction = EXCLUDED.satisfaction,
                   safety = EXCLUDED.safety,
                   updated_at = NOW()
     RETURNING id, rep_type, rep_id, satisfaction, safety, updated_at`,
    [req.user.id, cityId, repType, repId, parseInt(satisfaction, 10), safety ? parseInt(safety, 10) : null]
  );

  const { rows: agg } = await query(
    `SELECT avg_satisfaction, avg_safety, rating_count
     FROM rep_ratings_agg
     WHERE city_id = $1 AND rep_type = $2 AND rep_id = $3`,
    [cityId, repType, repId]
  );

  res.json({
    success: true,
    yourRating: rows[0],
    aggregate: agg[0] || { avg_satisfaction: null, avg_safety: null, rating_count: 0 },
  });
}));

// ─────────────────────────────────────────────────────────────
// ROUTE: GET /api/ratings/rep/:type/:repId
// Get aggregate + current user's rating for one MLA/MP/Corp
// ─────────────────────────────────────────────────────────────
router.get('/rep/:type/:repId', optionalAuth, asyncWrap(async (req, res) => {
  const { cityId = 'pune' } = req.query;
  const { type, repId } = req.params;

  const [{ rows: agg }, userRows] = await Promise.all([
    query(
      `SELECT avg_satisfaction, avg_safety, rating_count
       FROM rep_ratings_agg
       WHERE city_id = $1 AND rep_type = $2 AND rep_id = $3`,
      [cityId, type, repId]
    ),
    req.user
      ? query(
          `SELECT satisfaction, safety, updated_at FROM rep_ratings
           WHERE user_id = $1 AND city_id = $2 AND rep_type = $3 AND rep_id = $4`,
          [req.user.id, cityId, type, repId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  res.json({
    aggregate: agg[0] || { avg_satisfaction: null, avg_safety: null, rating_count: 0 },
    yourRating: userRows.rows[0] || null,
  });
}));

// ─────────────────────────────────────────────────────────────
// ROUTE: GET /api/ratings/reps/:type
// Batch: get aggregates for ALL reps of a type (for live display on cards)
// ─────────────────────────────────────────────────────────────
router.get('/reps/:type', asyncWrap(async (req, res) => {
  const { cityId = 'pune' } = req.query;
  const { type } = req.params;

  if (!['mla', 'mp', 'corp'].includes(type)) {
    return res.status(400).json({ error: 'type must be mla, mp, or corp' });
  }

  const { rows } = await query(
    `SELECT rep_id, avg_satisfaction, avg_safety, rating_count
     FROM rep_ratings_agg
     WHERE city_id = $1 AND rep_type = $2`,
    [cityId, type]
  );

  // Return as map: { repId: { avg_satisfaction, avg_safety, rating_count } }
  const map = {};
  rows.forEach(r => {
    map[r.rep_id] = {
      avg_satisfaction: r.avg_satisfaction,
      avg_safety:       r.avg_safety,
      rating_count:     r.rating_count,
    };
  });
  res.json(map);
}));

module.exports = router;
