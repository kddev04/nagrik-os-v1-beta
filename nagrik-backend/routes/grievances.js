'use strict';
const express = require('express');
const router  = express.Router();
const { query, getClient } = require('../config/db');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { grievanceLimiter } = require('../middleware/rateLimit');
const { uploadGrievancePhoto, deletePhoto } = require('../services/upload');
const { sendGrievanceConfirmation } = require('../services/email');
const { asyncWrap } = require('../middleware/errorHandler');
const { GRIEVANCE_CATEGORIES, GRIEVANCE_STATUSES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../config/constants');

// ── Helpers ──────────────────────────────────────────────────

const parsePagination = (query) => {
  const page  = Math.max(1, parseInt(query.page  || '1', 10));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit || String(DEFAULT_PAGE_SIZE), 10)));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ═══════════════════════════════════════════════════════════
// POST /api/grievances — Submit a new grievance (with photo)
// Accepts BOTH old frontend field names AND backend field names
// ═══════════════════════════════════════════════════════════
router.post('/', requireAuth, grievanceLimiter, asyncWrap(async (req, res) => {
  console.log('\n═══════════════ NEW GRIEVANCE ═══════════════');
  console.log('[Grievance POST] Body keys:', Object.keys(req.body));
  console.log('[Grievance POST] isPublic value:', req.body.isPublic);
  
  const body = req.body;
  
  const cityId = body.cityId || 'pune';
  const category = body.category;
  const description = body.description;
  const emailDraft = body.emailDraft;
  const isPublic = !!body.isPublic;
  const sendConfirmationEmail = body.sendConfirmationEmail !== false;
  
  // Photo: accept 'photo' OR 'photoData'
  const photoData = body.photoData || body.photo || null;
  
  // GPS: accept either separate fields OR nested gps object
  const gpsLat = body.gpsLat ?? body.gps?.lat ?? null;
  const gpsLng = body.gpsLng ?? body.gps?.lng ?? null;
  const gpsAccuracy = body.gpsAccuracy ?? body.gps?.accuracy ?? null;
  
  // Location: accept 'location' OR 'locationText'
  const locationText = body.locationText || body.location || null;
  
  // Ward: parse from location text if not provided
  let wardId = body.wardId || null;
  let wardName = body.wardName || null;
  if (!wardId && locationText) {
    const match = locationText.match(/Ward\s+(\d+)/i);
    if (match) wardId = parseInt(match[1], 10);
  }
  
  // Representative: accept either format
  let repType = body.repType || null;
  let repId = body.repId || null;
  let repName = body.repName || null;
  let repEmail = body.repEmail || null;
  
  if (!repType && body.representative) {
    const repStr = body.representative;
    if (repStr.startsWith('corp-')) { repType = 'corp'; repId = repStr.slice(5); }
    else if (repStr.startsWith('mla-')) { repType = 'mla'; repId = repStr.slice(4); }
    else if (repStr.startsWith('mp-')) { repType = 'mp'; repId = repStr.slice(3); }
  }
  
  console.log('[Grievance POST] Normalized:', {
    cityId, category, isPublic,
    hasPhoto: !!photoData, hasGPS: !!(gpsLat && gpsLng),
    wardId, repType, repId
  });

  // ── Validation ──
  if (!category || !GRIEVANCE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category', code: 'INVALID_CATEGORY', allowed: GRIEVANCE_CATEGORIES });
  }
  if (!description || typeof description !== 'string' || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description must be at least 20 characters', code: 'DESCRIPTION_TOO_SHORT' });
  }
  if (description.trim().length > 2000) {
    return res.status(400).json({ error: 'Description must be under 2000 characters', code: 'DESCRIPTION_TOO_LONG' });
  }
  if (repType && !['corp', 'mla', 'mp'].includes(repType)) {
    repType = null; repId = null;
  }

  // ── Generate reference code ──
  const { rows: refRows } = await query(`SELECT generate_grievance_ref($1) AS ref_code`, [cityId]);
  const refCode = refRows[0].ref_code;
  console.log('[Grievance POST] Ref code:', refCode);

  // ── Upload photo ──
  let photoUrl = null;
  let photoPublicId = null;
  if (photoData) {
    try {
      const { v4: uuidv4 } = require('uuid');
      const tempId = uuidv4();
      const uploaded = await uploadGrievancePhoto(photoData, tempId);
      if (uploaded) {
        photoUrl = uploaded.url;
        photoPublicId = uploaded.publicId;
        console.log('[Grievance POST] ✅ Photo uploaded:', photoUrl);
      }
    } catch (uploadErr) {
      console.error('[Grievance POST] ❌ Photo upload failed:', uploadErr.message);
    }
  }

  // ── Insert grievance ──
  const client = await getClient();
  let grievance;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO grievances (
        ref_code, user_id, city_id, ward_id, ward_name,
        category, description,
        gps_lat, gps_lng, gps_accuracy, location_text,
        photo_url, photo_public_id,
        rep_type, rep_id, rep_name, rep_email,
        email_draft, is_public
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        refCode, req.user.id, cityId,
        wardId || null, wardName || null,
        category, description.trim(),
        gpsLat || null, gpsLng || null, gpsAccuracy || null, locationText || null,
        photoUrl, photoPublicId,
        repType || null, repId || null, repName || null, repEmail || null,
        emailDraft || null, isPublic,
      ]
    );
    grievance = rows[0];

    await client.query('UPDATE users SET grievance_count = grievance_count + 1 WHERE id = $1', [req.user.id]);
    await client.query(
      `INSERT INTO grievance_updates (grievance_id, updated_by, from_status, to_status, note)
       VALUES ($1, $2, NULL, 'filed', 'Grievance submitted by citizen')`,
      [grievance.id, req.user.id]
    );

    await client.query('COMMIT');
    console.log('[Grievance POST] ✅ Saved. ID:', grievance.id, 'isPublic:', grievance.is_public);
    console.log('═══════════════════════════════════════════════\n');
  } catch (err) {
    await client.query('ROLLBACK');
    if (photoPublicId) await deletePhoto(photoPublicId);
    console.error('[Grievance POST] ❌ DB error:', err.message);
    throw err;
  } finally {
    client.release();
  }

  if (sendConfirmationEmail && req.user.email) {
    sendGrievanceConfirmation(req.user.email, {
      refCode: grievance.ref_code,
      category: grievance.category,
      wardName: grievance.ward_name,
    }).catch(err => console.warn('[Grievance] Confirmation email failed:', err.message));
  }

  res.status(201).json({
    success: true,
    refCode: grievance.ref_code,
    grievance: {
      id: grievance.id,
      refCode: grievance.ref_code,
      category: grievance.category,
      status: grievance.status,
      isPublic: grievance.is_public,
      photoUrl: grievance.photo_url,
      createdAt: grievance.created_at,
    },
  });
}));

// ═══════════════════════════════════════════════════════════
// GET /api/grievances/public — Public feed
// ═══════════════════════════════════════════════════════════
router.get('/public', optionalAuth, asyncWrap(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { cityId = 'pune', wardId, category, status } = req.query;

  const conditions = ['g.is_public = true', 'g.city_id = $1', 'g.gps_lat IS NOT NULL'];
  const params = [cityId];
  let p = 2;

  if (wardId)   { conditions.push(`g.ward_id = $${p++}`); params.push(wardId); }
  if (category) { conditions.push(`g.category = $${p++}`); params.push(category); }
  if (status)   { conditions.push(`g.status = $${p++}`); params.push(status); }

  const where = conditions.join(' AND ');

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT g.id, g.ref_code, g.city_id, g.ward_id, g.ward_name,
              g.category, g.description, g.status, g.priority,
              g.gps_lat, g.gps_lng, g.location_text,
              g.photo_url, g.upvotes,
              g.rep_type, g.rep_id, g.rep_name,
              g.created_at,
              LEFT(u.name, 50) AS submitter_name
       FROM grievances g
       LEFT JOIN users u ON u.id = g.user_id
       WHERE ${where}
       ORDER BY g.created_at DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM grievances g WHERE ${where}`, params),
  ]);

  console.log('[Public Feed]', rows.length, 'grievances returned for city:', cityId);

  res.json({
    data: rows,
    pagination: {
      page, limit,
      total: parseInt(countRows[0].count, 10),
      pages: Math.ceil(parseInt(countRows[0].count, 10) / limit),
    },
  });
}));

// ═══════════════════════════════════════════════════════════
// GET /api/grievances/mine — Current user's grievances
// ═══════════════════════════════════════════════════════════
router.get('/mine', requireAuth, asyncWrap(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { status } = req.query;

  const params = [req.user.id];
  let where = 'g.user_id = $1';
  if (status) { where += ` AND g.status = $2`; params.push(status); }

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT g.id, g.ref_code, g.city_id, g.ward_id, g.ward_name,
              g.category, g.description, g.status, g.priority,
              g.gps_lat, g.gps_lng, g.location_text,
              g.photo_url, g.is_public, g.upvotes,
              g.email_draft, g.email_sent,
              g.rep_type, g.rep_id, g.rep_name, g.rep_email,
              g.created_at, g.updated_at,
              g.resolution_note
       FROM grievances g
       WHERE ${where}
       ORDER BY g.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM grievances g WHERE ${where}`, params),
  ]);

  res.json({
    data: rows,
    pagination: {
      page, limit,
      total: parseInt(countRows[0].count, 10),
      pages: Math.ceil(parseInt(countRows[0].count, 10) / limit),
    },
  });
}));

// ═══════════════════════════════════════════════════════════
// GET /api/grievances/:id — Single grievance
// ═══════════════════════════════════════════════════════════
router.get('/:id', optionalAuth, asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, u.name AS submitter_name
     FROM grievances g
     LEFT JOIN users u ON u.id = g.user_id
     WHERE g.id = $1 AND (g.is_public = true OR g.user_id = $2)`,
    [req.params.id, req.user?.id || null]
  );

  if (!rows.length) return res.status(404).json({ error: 'Grievance not found', code: 'NOT_FOUND' });

  query('UPDATE grievances SET view_count = view_count + 1 WHERE id = $1', [req.params.id]).catch(() => {});

  const { rows: updates } = await query(
    `SELECT gu.from_status, gu.to_status, gu.note, gu.created_at,
            LEFT(u.name, 50) AS updated_by_name
     FROM grievance_updates gu
     LEFT JOIN users u ON u.id = gu.updated_by
     WHERE gu.grievance_id = $1
     ORDER BY gu.created_at ASC`,
    [req.params.id]
  );

  res.json({ ...rows[0], statusHistory: updates });
}));

// ═══════════════════════════════════════════════════════════
// PATCH /api/grievances/:id — Update own grievance (toggle public)
// ═══════════════════════════════════════════════════════════
router.patch('/:id', requireAuth, asyncWrap(async (req, res) => {
  const { rows } = await query(
    `SELECT id, user_id, status FROM grievances WHERE id = $1`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Grievance not found', code: 'NOT_FOUND' });
  const grievance = rows[0];

  if (grievance.user_id !== req.user.id && !['admin', 'moderator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not your grievance', code: 'FORBIDDEN' });
  }

  const { isPublic, description } = req.body;
  const updates = [];
  const params  = [];
  let i = 1;

  if (isPublic !== undefined) { updates.push(`is_public = $${i++}`); params.push(!!isPublic); }
  if (description !== undefined && grievance.status === 'filed') {
    if (description.trim().length < 20) return res.status(400).json({ error: 'Description too short', code: 'DESCRIPTION_TOO_SHORT' });
    updates.push(`description = $${i++}`); params.push(description.trim());
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push(`updated_at = NOW()`);
  params.push(req.params.id);

  const { rows: updated } = await query(
    `UPDATE grievances SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, is_public, status, updated_at`,
    params
  );

  res.json(updated[0]);
}));

// ═══════════════════════════════════════════════════════════
// DELETE /api/grievances/:id — Delete own grievance (NEW!)
// ═══════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, asyncWrap(async (req, res) => {
  console.log('[Grievance DELETE] User', req.user.id, 'attempting delete of', req.params.id);
  
  const { rows } = await query(
    `SELECT id, user_id, photo_public_id FROM grievances WHERE id = $1`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Grievance not found', code: 'NOT_FOUND' });
  const grievance = rows[0];

  // Only owner or admin can delete
  if (grievance.user_id !== req.user.id && !['admin', 'moderator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not your grievance', code: 'FORBIDDEN' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Delete child records first (foreign keys)
    await client.query(`DELETE FROM grievance_upvotes WHERE grievance_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM grievance_updates WHERE grievance_id = $1`, [req.params.id]);
    
    // Delete the grievance
    await client.query(`DELETE FROM grievances WHERE id = $1`, [req.params.id]);
    
    // Decrement user's grievance counter
    await client.query(
      'UPDATE users SET grievance_count = GREATEST(0, grievance_count - 1) WHERE id = $1',
      [grievance.user_id]
    );

    await client.query('COMMIT');
    console.log('[Grievance DELETE] ✅ Deleted from DB:', req.params.id);
    
    // Delete photo from Cloudinary (non-blocking)
    if (grievance.photo_public_id) {
      deletePhoto(grievance.photo_public_id).catch(err => 
        console.warn('[Grievance DELETE] Photo cleanup failed:', err.message)
      );
    }
    
    res.json({ success: true, deleted: req.params.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Grievance DELETE] ❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}));

// ═══════════════════════════════════════════════════════════
// POST /api/grievances/:id/upvote — Toggle upvote
// ═══════════════════════════════════════════════════════════
router.post('/:id/upvote', requireAuth, asyncWrap(async (req, res) => {
  try {
    await query(
      `INSERT INTO grievance_upvotes (grievance_id, user_id) VALUES ($1, $2)`,
      [req.params.id, req.user.id]
    );
    await query(`UPDATE grievances SET upvotes = upvotes + 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true, action: 'upvoted' });
  } catch (err) {
    if (err.code === '23505') {
      await query(`DELETE FROM grievance_upvotes WHERE grievance_id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
      await query(`UPDATE grievances SET upvotes = GREATEST(0, upvotes - 1) WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, action: 'removed' });
    }
    throw err;
  }
}));

// ═══════════════════════════════════════════════════════════
// PUT /api/grievances/:id/status — Admin status update
// ═══════════════════════════════════════════════════════════
router.put('/:id/status', requireAuth, requireRole('admin', 'moderator', 'pmc_officer'), asyncWrap(async (req, res) => {
  const { status, note } = req.body;

  if (!status || !GRIEVANCE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status', code: 'INVALID_STATUS', allowed: GRIEVANCE_STATUSES });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT status FROM grievances WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Grievance not found', code: 'NOT_FOUND' });

    const oldStatus = rows[0].status;

    await client.query(
      `UPDATE grievances SET status = $1, updated_at = NOW() ${status === 'resolved' ? ', resolved_at = NOW(), resolution_note = $2' : ''} WHERE id = $${status === 'resolved' ? '3' : '2'}`,
      status === 'resolved' ? [status, note || null, req.params.id] : [status, req.params.id]
    );

    await client.query(
      `INSERT INTO grievance_updates (grievance_id, updated_by, from_status, to_status, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.user.id, oldStatus, status, note || null]
    );

    await client.query('COMMIT');
    res.json({ success: true, from: oldStatus, to: status });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
