'use strict';

/**
 * Normalize Indian phone number to E.164 format: +91XXXXXXXXXX
 * Accepts: 9876543210, 09876543210, +919876543210
 */
const normalizeIndianPhone = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return `+${digits}`;
};

/**
 * Validate Indian mobile number (10 digits, starts with 6-9)
 */
const isValidIndianPhone = (phone) => {
  const normalized = normalizeIndianPhone(phone);
  return /^\+91[6-9]\d{9}$/.test(normalized);
};

// ═══════════════════════════════════════════════════════════
// Fast2SMS — India provider with DLT support + quick fallback
// ═══════════════════════════════════════════════════════════
const sendViaFast2SMS = async (phone, otp) => {
  const normalized = normalizeIndianPhone(phone);
  const mobile = normalized.replace('+91', '');
  const senderId = process.env.FAST2SMS_SENDER_ID || 'NAGRIK';
  const templateId = process.env.FAST2SMS_TEMPLATE_ID;
  const apiKey = process.env.FAST2SMS_API_KEY;
  
  if (!apiKey) {
    throw new Error('FAST2SMS_API_KEY not configured');
  }

  console.log(`[SMS] Sending OTP to ${normalized} via Fast2SMS...`);

  // ── ATTEMPT 1: DLT route (production - requires approved template) ──
  if (templateId) {
    try {
      console.log(`[SMS] Trying DLT route with template ${templateId}, sender ${senderId}`);
      
      const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          'authorization': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'dlt',
          sender_id: senderId,
          message: templateId,
          variables_values: otp,
          numbers: mobile,
        }),
      });

      const data = await response.json();
      
      if (data.return) {
        console.log(`[SMS] ✅ DLT OTP sent successfully:`, data.request_id || 'OK');
        return data;
      }
      
      console.warn(`[SMS] ⚠️ DLT route failed:`, data.message || JSON.stringify(data));
      console.warn(`[SMS] Falling back to quick route...`);
    } catch (dltErr) {
      console.warn(`[SMS] DLT route error:`, dltErr.message);
      console.warn(`[SMS] Falling back to quick route...`);
    }
  } else {
    console.log(`[SMS] No FAST2SMS_TEMPLATE_ID set, using quick route directly`);
  }

  // ── ATTEMPT 2: Quick route (no DLT needed - works for testing) ──
  try {
    const fallback = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        route: 'q',
        message: `Your Nagrik OS OTP is ${otp}. Valid for 5 minutes. Do not share.`,
        numbers: mobile,
      }),
    });
    
    const fallbackData = await fallback.json();
    
    if (fallbackData.return) {
      console.log(`[SMS] ✅ Quick OTP sent successfully:`, fallbackData.request_id || 'OK');
      return fallbackData;
    }
    
    console.error(`[SMS] ❌ Quick route also failed:`, JSON.stringify(fallbackData));
    throw new Error(`Fast2SMS: ${fallbackData.message || JSON.stringify(fallbackData)}`);
  } catch (quickErr) {
    console.error(`[SMS] ❌ Fast2SMS completely failed:`, quickErr.message);
    throw quickErr;
  }
};

// ═══════════════════════════════════════════════════════════
// Twilio — International fallback
// ═══════════════════════════════════════════════════════════
const sendViaTwilio = async (phone, otp) => {
  const normalized = normalizeIndianPhone(phone);
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_PHONE_NUMBER,
        To: normalized,
        Body: `Your Nagrik OS OTP is ${otp}. Valid for 5 minutes. Do not share this code. -NAGRIK`,
      }),
    }
  );
  const data = await response.json();
  if (data.error_code) throw new Error(`Twilio: ${data.message}`);
  return data;
};

// ═══════════════════════════════════════════════════════════
// Console fallback (dev/testing)
// ═══════════════════════════════════════════════════════════
const sendViaConsole = (phone, otp) => {
  console.log('\n╔══════════════ SMS (dev mode) ════════════════╗');
  console.log(`║ To:  ${phone}`);
  console.log(`║ OTP: ${otp}`);
  console.log('╚══════════════════════════════════════════════╝\n');
  return { success: true, id: 'dev-sms-' + Date.now() };
};

/**
 * Main entry point: send OTP via SMS
 */
const sendOTPSMS = async (phone, otp) => {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();

  if (provider === 'disabled') {
    console.warn('[SMS] SMS provider is disabled. OTP not sent.');
    return { success: false, reason: 'SMS disabled' };
  }

  if (provider === 'fast2sms') return sendViaFast2SMS(phone, otp);
  if (provider === 'twilio')   return sendViaTwilio(phone, otp);
  return sendViaConsole(phone, otp);
};

module.exports = { sendOTPSMS, normalizeIndianPhone, isValidIndianPhone };
