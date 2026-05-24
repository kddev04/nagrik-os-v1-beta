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

// ── Fast2SMS (India — cheapest for bulk, DLT registered) ─────
const sendViaFast2SMS = async (phone, otp) => {
  const normalized = normalizeIndianPhone(phone);
  const mobile = normalized.replace('+91', '');

  const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      'authorization': process.env.FAST2SMS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'dlt',                      // DLT route (required for transactional SMS in India)
      sender_id: 'NAGRIK',               // Register this sender ID with Fast2SMS
      message: process.env.FAST2SMS_TEMPLATE_ID,  // Your DLT approved template ID
      variables_values: otp,             // OTP value
      numbers: mobile,
    }),
  });

  const data = await response.json();
  if (!data.return) {
    // Fallback: use quick SMS route (dev/testing only, no DLT needed)
    const fallback = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { 'authorization': process.env.FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: 'q', message: `Your Nagrik OS OTP is ${otp}. Valid for 5 minutes. Do not share.`, numbers: mobile }),
    });
    const fallbackData = await fallback.json();
    if (!fallbackData.return) throw new Error(`Fast2SMS: ${JSON.stringify(fallbackData)}`);
    return fallbackData;
  }
  return data;
};

// ── Twilio ────────────────────────────────────────────────────
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

// ── Console fallback (dev/testing) ───────────────────────────
const sendViaConsole = (phone, otp) => {
  console.log('\n╔══════════════ SMS (dev mode) ════════════════╗');
  console.log(`║ To:  ${phone}`);
  console.log(`║ OTP: ${otp}`);
  console.log('╚══════════════════════════════════════════════╝\n');
  return { success: true, id: 'dev-sms-' + Date.now() };
};

/**
 * Send OTP via SMS.
 * Provider is selected from SMS_PROVIDER env var.
 *
 * @param {string} phone - Indian mobile number in any format
 * @param {string} otp - 6-digit OTP
 */
const sendOTPSMS = async (phone, otp) => {
  const provider = process.env.SMS_PROVIDER || 'console';

  if (provider === 'disabled') {
    console.warn('[SMS] SMS provider is disabled. OTP not sent.');
    return { success: false, reason: 'SMS disabled' };
  }

  if (provider === 'fast2sms') return sendViaFast2SMS(phone, otp);
  if (provider === 'twilio')   return sendViaTwilio(phone, otp);
  return sendViaConsole(phone, otp);
};

module.exports = { sendOTPSMS, normalizeIndianPhone, isValidIndianPhone };
