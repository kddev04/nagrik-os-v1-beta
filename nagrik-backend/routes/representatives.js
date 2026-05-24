'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { asyncWrap } = require('../middleware/errorHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════
// ROUTE: GET /api/reps/:cityId/:type
// Get all representatives of a type for a city.
// Phase 1: Returns empty (data is in nagrik.js frontend)
// Phase 2: Returns from DB (after migration from nagrik.js)
// ═══════════════════════════════════════════════════════════
router.get('/:cityId/:type', asyncWrap(async (req, res) => {
  const { cityId, type } = req.params;

  if (!['corp', 'mla', 'mp'].includes(type)) {
    return res.status(400).json({ error: 'Type must be corp, mla, or mp', code: 'INVALID_TYPE' });
  }

  const { rows } = await query(
    `SELECT * FROM representatives
     WHERE city_id = $1 AND rep_type = $2 AND active = true
     ORDER BY ward_id ASC NULLS LAST, name ASC`,
    [cityId, type]
  );

  // Phase 1: DB is empty, frontend uses embedded JS data
  res.json({
    data: rows,
    count: rows.length,
    phase: rows.length === 0 ? 1 : 2,
    note: rows.length === 0 ? 'Phase 1: Data served from nagrik.js frontend. Migrate to DB for Phase 2.' : undefined,
  });
}));

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/reps/bulk-import
// Admin: Bulk import representatives from JSON (for Phase 2 migration)
// Accepts array of rep objects. Upserts by id.
// ═══════════════════════════════════════════════════════════
router.post('/bulk-import', requireAuth, requireRole('admin'), asyncWrap(async (req, res) => {
  const { reps, cityId } = req.body;

  if (!Array.isArray(reps) || !reps.length) {
    return res.status(400).json({ error: 'reps must be a non-empty array', code: 'INVALID_INPUT' });
  }

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const rep of reps) {
    try {
      const { rows } = await query(
        `INSERT INTO representatives (
          id, city_id, rep_type, name, party, ward_id, ward_name,
          constituency, seat, reservation, lat, lng,
          phone, email, office_address, zone_office,
          promises, bio, votes, vote_pct, margin, alliance
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, party = EXCLUDED.party,
          promises = EXCLUDED.promises, updated_at = NOW()
        RETURNING id, (xmax = 0) AS is_insert`,
        [
          rep.id, cityId || rep.city_id || 'pune', rep.rep_type || (rep.ward_no ? 'corp' : 'mla'),
          rep.name, rep.party, rep.ward_no || rep.ward_id || null,
          rep.ward_name || null, rep.const || rep.constituency || null,
          rep.seat || null, rep.reservation || null,
          rep.lat || null, rep.lng || null,
          rep.phone || null, rep.email || null,
          rep.office || rep.zone_office || null, rep.zone_office || null,
          JSON.stringify(rep.promises || []),
          rep.bio || null, rep.votes || null, rep.pct || null, rep.margin || null,
          rep.alliance || null,
        ]
      );
      if (rows[0].is_insert) inserted++; else updated++;
    } catch (err) {
      errors.push({ id: rep.id, error: err.message });
    }
  }

  res.json({ success: true, inserted, updated, errors, total: reps.length });
}));

module.exports = router;
