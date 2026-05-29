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
// ─── POST /api/grievances/:id/send-email ───────────────────────
// Sends formal complaint email via Resend WITH photo attached
// Frontend calls this instead of opening mailto:
// ──────────────────────────────────────────────────────────────

router.post('/:id/send-email', requireAuth, asyncWrap(async (req, res) => {
  const { target = 'admin' } = req.body; // 'admin' | 'mla' | 'mp'

  // Fetch the grievance
  const { rows } = await query(
    `SELECT g.*, u.email AS user_email, u.name AS user_name
     FROM grievances g
     LEFT JOIN users u ON u.id = g.user_id
     WHERE g.id = $1`,
    [req.params.id]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Grievance not found', code: 'NOT_FOUND' });
  }

  const g = rows[0];

  // Only owner can send (or admin)
  if (g.user_id !== req.user.id && !['admin', 'moderator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not your grievance', code: 'FORBIDDEN' });
  }

  // ── Determine recipient ──
  const ADMIN_EMAILS = {
    'Roads & Potholes':          'roads@pmc.gov.in',
    'Water Supply':              'water@pmc.gov.in',
    'Sewage & Waterlogging':     'sewage@pmc.gov.in',
    'Garbage & Sanitation':      'solid.waste@pmc.gov.in',
    'Streetlights':              'electrical@pmc.gov.in',
    'Encroachment':              'encroachment@pmc.gov.in',
    "Women's Safety":            'women.cell@pune.gov.in',
    'Electricity / MSEDCL':      'pune.city@mahadiscom.in',
    'Traffic & Signals':         'ptp@punecity.in',
    'Construction without permit': 'buildingpermission@pmc.gov.in',
    'Corruption':                'vigilance@pmc.gov.in',
    'Stray Animals':             'health@pmc.gov.in',
    'Other':                     'citizen.helpdesk@pmc.gov.in',
  };

  let toEmail = ADMIN_EMAILS[g.category] || ADMIN_EMAILS['Other'];
  let toName = 'Pune Municipal Corporation';

  if (target === 'mla' && g.rep_email && g.rep_type === 'mla') {
    toEmail = g.rep_email;
    toName = `MLA ${g.rep_name || 'Office'}`;
  } else if (target === 'mp' && g.rep_email && g.rep_type === 'mp') {
    toEmail = g.rep_email;
    toName = `MP ${g.rep_name || 'Office'}`;
  }

  // ── Build formal email body ──
  const date = new Date(g.created_at).toLocaleDateString('en-IN', {
    dateStyle: 'full'
  });
  const gpsLink = (g.gps_lat && g.gps_lng)
    ? `https://maps.google.com/?q=${parseFloat(g.gps_lat).toFixed(5)},${parseFloat(g.gps_lng).toFixed(5)}`
    : null;

  const subject = `Civic Grievance [${g.ref_code}]: ${g.category} — Immediate Action Required`;

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:20px}
  .header{background:#1a2035;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0}
  .logo{font-size:18px;font-weight:900;letter-spacing:3px;color:#ff7a1a}
  .body{background:#f9f9f9;padding:24px;border:1px solid #ddd;border-top:none}
  .ref{background:#fff;border:2px solid #ff7a1a;border-radius:8px;padding:12px 16px;margin:16px 0;display:inline-block}
  .ref-label{font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase}
  .ref-code{font-size:24px;font-weight:700;color:#ff7a1a;font-family:monospace}
  .field-row{margin:12px 0;padding:12px;background:#fff;border-radius:6px;border:1px solid #e5e5e5}
  .field-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  .field-value{font-size:14px;color:#1a1a1a;font-weight:500}
  .desc{background:#fff;border-left:3px solid #ff7a1a;padding:12px 16px;font-size:14px;line-height:1.6;border-radius:0 6px 6px 0}
  .gps-btn{display:inline-block;background:#2349c0;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin-top:8px}
  .photo-note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 14px;font-size:13px;color:#856404;margin:12px 0}
  .rti-box{background:#e8f5e9;border:1px solid #4caf50;border-radius:6px;padding:12px;margin:16px 0;font-size:13px}
  .footer{background:#f0f0f0;padding:14px 24px;font-size:11px;color:#888;border-radius:0 0 10px 10px;border:1px solid #ddd;border-top:none}
</style></head>
<body>
<div class="header">
  <div class="logo">NAGRIK OS</div>
  <div style="font-size:11px;color:#aaa;margin-top:4px;letter-spacing:2px">CITIZEN ACCOUNTABILITY · PUNE</div>
</div>
<div class="body">
  <p>Dear ${toName},</p>
  <p>I am writing to formally bring to your attention the following civic grievance requiring immediate action:</p>
  
  <div class="ref">
    <div class="ref-label">Grievance Reference</div>
    <div class="ref-code">${g.ref_code}</div>
  </div>

  <div class="field-row">
    <div class="field-label">Category</div>
    <div class="field-value">${g.category}</div>
  </div>
  
  <div class="field-row">
    <div class="field-label">Date Filed</div>
    <div class="field-value">${date}</div>
  </div>

  ${g.ward_name ? `<div class="field-row">
    <div class="field-label">Location (Ward)</div>
    <div class="field-value">${g.ward_name}${g.ward_id ? ` · Ward ${g.ward_id}` : ''}</div>
  </div>` : ''}

  ${g.location_text ? `<div class="field-row">
    <div class="field-label">Location Details</div>
    <div class="field-value">${g.location_text}</div>
  </div>` : ''}

  <div style="margin:16px 0">
    <div class="field-label" style="margin-bottom:8px">Description of Issue</div>
    <div class="desc">${g.description.replace(/\n/g, '<br>')}</div>
  </div>

  ${gpsLink ? `<div class="field-row">
    <div class="field-label">GPS Coordinates (Verified)</div>
    <div class="field-value">${parseFloat(g.gps_lat).toFixed(5)}°N, ${parseFloat(g.gps_lng).toFixed(5)}°E</div>
    <a class="gps-btn" href="${gpsLink}" target="_blank">📍 View on Google Maps</a>
  </div>` : ''}

  ${g.photo_url ? `<div class="photo-note">
    📸 <strong>Photo evidence is attached to this email.</strong><br>
    You can also view it online: <a href="${g.photo_url}">${g.photo_url}</a>
  </div>` : ''}

  <div class="rti-box">
    <strong>Right to Information / Citizen Rights:</strong><br>
    Under the Maharashtra Municipal Corporations Act and RTI Act 2005, citizens are entitled to:<br>
    1. Acknowledgment within <strong>7 days</strong><br>
    2. Resolution within <strong>30 days</strong><br>
    3. Written response on action taken<br><br>
    This grievance is being tracked publicly via Nagrik OS. A non-response will be escalated to higher authorities.
  </div>

  <p>Please acknowledge receipt of this complaint and initiate action at the earliest.</p>
  <p style="margin-top:20px">Regards,<br><strong>A Concerned Citizen</strong><br>Filed via Nagrik OS · Pune Civic Intelligence Platform<br><em>सत्यमेव जयते</em></p>
</div>
<div class="footer">
  This email was sent automatically via Nagrik OS (nagrikos.in). Reference: ${g.ref_code}.
  This grievance is publicly tracked. Please do not ignore this complaint.
</div>
</body></html>`;

  const textBody = `Civic Grievance [${g.ref_code}]: ${g.category}
Date: ${date}
${g.ward_name ? `Ward: ${g.ward_name}` : ''}
${g.location_text ? `Location: ${g.location_text}` : ''}
${g.gps_lat ? `GPS: ${parseFloat(g.gps_lat).toFixed(5)}, ${parseFloat(g.gps_lng).toFixed(5)}` : ''}
${gpsLink ? `Map: ${gpsLink}` : ''}

Description:
${g.description}

${g.photo_url ? `Photo Evidence: ${g.photo_url}` : ''}

Under RTI Act 2005, please:
1. Acknowledge within 7 days
2. Resolve within 30 days
3. Provide written response

Filed via Nagrik OS (nagrikos.in) · सत्यमेव जयते`;

  // ── Build Resend attachment (fetch photo if available) ──
  const attachments = [];
  if (g.photo_url) {
    try {
      const photoRes = await fetch(g.photo_url);
      if (photoRes.ok) {
        const buffer = await photoRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const ext = g.photo_url.includes('.webp') ? 'webp'
                  : g.photo_url.includes('.jpg') || g.photo_url.includes('.jpeg') ? 'jpeg'
                  : 'png';
        attachments.push({
          filename: `grievance-${g.ref_code}-evidence.${ext}`,
          content: base64,
        });
        console.log('[Email] ✅ Photo attached, size:', Math.round(buffer.byteLength / 1024), 'KB');
      }
    } catch (photoErr) {
      console.warn('[Email] ⚠️ Could not attach photo:', photoErr.message);
      // Continue without attachment — email still goes out
    }
  }

  // ── Send via Resend ──
  const { sendComplaintEmailViaResend } = require('../services/email');
  try {
    await sendComplaintEmailViaResend({
      to: toEmail,
      subject,
      html: htmlBody,
      text: textBody,
      attachments,
    });

    // Log it in grievance updates
    await query(
      `UPDATE grievances SET email_sent = true, email_sent_at = NOW() WHERE id = $1`,
      [g.id]
    );
    await query(
      `INSERT INTO grievance_updates (grievance_id, updated_by, from_status, to_status, note)
       VALUES ($1, $2, $3, $3, $4)`,
      [g.id, req.user.id, g.status, `Complaint email sent to ${toEmail}${attachments.length ? ' with photo attachment' : ''}`]
    );

    console.log('[Email] ✅ Complaint sent:', g.ref_code, '→', toEmail, 'with', attachments.length, 'attachments');

    res.json({
      success: true,
      refCode: g.ref_code,
      recipient: toEmail,
      hasPhoto: attachments.length > 0,
    });
  } catch (emailErr) {
    console.error('[Email] ❌ Complaint send failed:', emailErr.message);
    return res.status(503).json({
      error: 'Failed to send complaint email. Please try again.',
      code: 'EMAIL_FAILED',
    });
  }
}));

module.exports = router;

