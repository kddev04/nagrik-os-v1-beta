'use strict';

const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a base64-encoded grievance photo to Cloudinary.
 * @param {string} base64Data - Base64 string (without data: prefix)
 * @param {string} grievanceId - Grievance ID for folder organization
 * @returns {Promise<{url, publicId}>} - Cloudinary response with URL
 */
const uploadGrievancePhoto = async (base64Data, grievanceId) => {
  if (!base64Data) return null;
  
  try {
    const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${base64Data}`, {
      folder: 'nagrik-os-grievances',
      public_id: `grievance-${grievanceId}`,
      resource_type: 'auto',
      format: 'webp',
      quality: 'auto',
      transformation: [
        { width: 1200, height: 1200, crop: 'limit', quality: 'auto' }
      ]
    });
    
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (err) {
    console.error('[Upload] Cloudinary error:', err.message);
    throw err;
  }
};

/**
 * Delete a photo from Cloudinary.
 */
const deletePhoto = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.warn('[Upload] Delete failed:', err.message);
  }
};

module.exports = { uploadGrievancePhoto, deletePhoto };
