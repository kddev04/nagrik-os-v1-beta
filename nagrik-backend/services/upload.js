'use strict';
 
const cloudinary = require('cloudinary').v2;
const { ALLOWED_PHOTO_TYPES, MAX_PHOTO_SIZE_MB } = require('../config/constants');
 
// Configure Cloudinary (auto-uses CLOUDINARY_* env vars)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});
 
const MAX_BYTES = MAX_PHOTO_SIZE_MB * 1024 * 1024;
const FOLDER = process.env.CLOUDINARY_FOLDER || 'nagrik-os-grievances';
 
/**
 * Upload a base64 photo to Cloudinary.
 * Accepts BOTH formats:
 *   - Full data URI: "data:image/jpeg;base64,/9j/..."
 *   - Stripped base64: "/9j/..."
 *
 * @param {string} base64Data
 * @param {string} grievanceId - Used as Cloudinary public_id
 */
const uploadGrievancePhoto = async (base64Data, grievanceId) => {
  if (!base64Data) {
    console.log('[Upload] ❌ No photo data provided');
    return null;
  }
 
  console.log('[Upload] 📸 Starting upload, input length:', base64Data.length);
  console.log('[Upload] ☁️  Cloud name configured:', process.env.CLOUDINARY_CLOUD_NAME || 'NOT SET');
  console.log('[Upload] 🔑 API key configured:', !!process.env.CLOUDINARY_API_KEY);
  console.log('[Upload] 🔐 API secret configured:', !!process.env.CLOUDINARY_API_SECRET);
 
  // ── Normalize: ensure we have a data URI ──
  let dataUri = base64Data;
  if (!base64Data.startsWith('data:')) {
    // It's stripped base64 — add JPEG prefix
    dataUri = `data:image/jpeg;base64,${base64Data}`;
    console.log('[Upload] 🔧 Added data:image/jpeg prefix to stripped base64');
  } else {
    console.log('[Upload] ✅ Data URI already has prefix');
  }
 
  // ── Validate file size ──
  const base64String = dataUri.split(',')[1] || base64Data;
  const sizeBytes = Math.ceil((base64String.length * 3) / 4);
  console.log('[Upload] 📏 Photo size:', (sizeBytes / 1024).toFixed(1), 'KB');
  
  if (sizeBytes > MAX_BYTES) {
    const err = new Error(`Photo too large. Max: ${MAX_PHOTO_SIZE_MB}MB, got: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB`);
    console.error('[Upload] ❌', err.message);
    throw err;
  }
 
  // ── Upload to Cloudinary ──
  try {
    console.log('[Upload] 🚀 Uploading to Cloudinary...');
    
    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: `${FOLDER}/${grievanceId}`,
      overwrite: true,
      resource_type: 'image',
      transformation: [
        { width: 1920, height: 1080, crop: 'limit' }, // Max resolution
        { quality: 'auto:good' },                     // Auto-compress
        { format: 'webp' },                           // Convert to WebP
      ],
      tags: ['nagrik-os', 'grievance'],
    });
 
    console.log('[Upload] ✅ SUCCESS! URL:', result.secure_url);
    console.log('[Upload] 📦 Public ID:', result.public_id);
 
    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
    };
  } catch (err) {
    console.error('[Upload] ❌ Cloudinary upload FAILED');
    console.error('[Upload] Error message:', err.message);
    console.error('[Upload] Error name:', err.name);
    if (err.http_code) console.error('[Upload] HTTP code:', err.http_code);
    if (err.error) console.error('[Upload] Inner error:', err.error);
    throw err;
  }
};
 
/**
 * Delete a photo from Cloudinary by publicId.
 */
const deletePhoto = async (publicId) => {
  if (!publicId) return null;
  try {
    return await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.warn(`[Upload] Failed to delete ${publicId}:`, err.message);
    return null;
  }
};
 
const isConfigured = () => !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
 
module.exports = { uploadGrievancePhoto, deletePhoto, isConfigured };
