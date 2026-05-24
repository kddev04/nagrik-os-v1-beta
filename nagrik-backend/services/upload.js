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
 * Upload a base64-encoded photo to Cloudinary.
 * Returns { url, publicId } on success.
 * Returns null if no photo provided.
 *
 * @param {string} base64Data - Full data URI: "data:image/jpeg;base64,..."
 * @param {string} grievanceId - UUID to use as Cloudinary public_id
 */
const uploadGrievancePhoto = async (base64Data, grievanceId) => {
  if (!base64Data) return null;

  // ── Validate data URI format ──
  if (!base64Data.startsWith('data:')) {
    throw Object.assign(new Error('Invalid photo format. Expected base64 data URI.'), { status: 400 });
  }

  // ── Validate MIME type ──
  const mimeMatch = base64Data.match(/^data:([^;]+);base64,/);
  if (!mimeMatch || !ALLOWED_PHOTO_TYPES.includes(mimeMatch[1])) {
    throw Object.assign(
      new Error(`Invalid photo type. Allowed: ${ALLOWED_PHOTO_TYPES.join(', ')}`),
      { status: 400 }
    );
  }

  // ── Validate file size ──
  const base64String = base64Data.split(',')[1];
  const sizeBytes = Math.ceil((base64String.length * 3) / 4);
  if (sizeBytes > MAX_BYTES) {
    throw Object.assign(
      new Error(`Photo too large. Maximum size: ${MAX_PHOTO_SIZE_MB}MB`),
      { status: 400 }
    );
  }

  // ── Upload to Cloudinary ──
  const result = await cloudinary.uploader.upload(base64Data, {
    public_id: `${FOLDER}/${grievanceId}`,
    overwrite: true,
    resource_type: 'image',
    transformation: [
      { width: 1920, height: 1080, crop: 'limit' }, // Max resolution
      { quality: 'auto:good' },                     // Auto-compress
      { format: 'webp' },                           // Convert to WebP for size
    ],
    tags: ['nagrik-os', 'grievance'],
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
  };
};

/**
 * Delete a photo from Cloudinary by publicId.
 * Used when a grievance is deleted.
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

/**
 * Check if Cloudinary is configured.
 */
const isConfigured = () => !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

module.exports = { uploadGrievancePhoto, deletePhoto, isConfigured };
