'use strict';

// ═══════════════════════════════════════════════════════════════
// services/email.js — Email via Resend.com (primary) or console
// Nodemailer intentionally NOT used (known CVEs).
// For SMTP: use Resend's SMTP relay or a verified alternative.
// ═══════════════════════════════════════════════════════════════

const OTP_EXPIRY_MIN = parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);

// ── Resend.com (recommended — free 3K emails/day) ─────────────
const sendViaResend = async ({ to, subject, html, text }) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${process.env.EMAIL_FROM_NAME || 'Nagrik OS'} <${process.env.EMAIL_FROM}>`,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  return res.json();
};

// ── Console (dev / no-config) ─────────────────────────────────
const sendViaConsole = ({ to, subject, text }) => {
  console.log('\n╔═══════════════ EMAIL (console mode) ═══════════════╗');
  console.log(`║  To:      ${to}`);
  console.log(`║  Subject: ${subject}`);
  console.log(`║  Content: ${text}`);
  console.log('╚═════════════════════════════════════════════════════╝\n');
  return { id: `console-${Date.now()}` };
};

// ── Dispatch ──────────────────────────────────────────────────
const send = (payload) => {
  const provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
  if (provider === 'resend') return sendViaResend(payload);
  return sendViaConsole(payload);
};

// ── OTP email template ────────────────────────────────────────
const otpHTML = (otp) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body{margin:0;padding:20px;background:#050507;font-family:'Helvetica Neue',Arial,sans-serif}
  .wrap{max-width:460px;margin:0 auto}
  .card{background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:36px 32px}
  .logo{font-size:20px;font-weight:900;letter-spacing:4px;color:#f7f0e2;margin-bottom:4px}
  .tag{font-size:9px;letter-spacing:2px;color:#8899aa;font-family:monospace;margin-bottom:28px}
  h2{font-size:17px;color:#f7f0e2;margin-bottom:8px;font-weight:600}
  p{font-size:14px;color:#8899aa;line-height:1.6;margin:0 0 24px}
  .otp-box{background:#050507;border:2px solid #ff7a1a;border-radius:12px;text-align:center;padding:22px 16px}
  .otp{font-size:44px;font-weight:700;letter-spacing:14px;color:#ff7a1a;font-family:monospace}
  .expiry{font-size:12px;color:#8899aa;margin-top:6px}
  .warn{font-size:12px;color:#f87171;margin-top:20px;line-height:1.5}
  .footer{font-size:11px;color:#374151;text-align:center;margin-top:24px}
</style>
</head><body><div class="wrap"><div class="card">
  <div class="logo">NAGRIK OS</div>
  <div class="tag">CIVIC INTELLIGENCE · PUNE</div>
  <h2>Your One-Time Password</h2>
  <p>Use this code to sign in. Never share it with anyone — Nagrik OS will never ask for it over call or chat.</p>
  <div class="otp-box">
    <div class="otp">${otp}</div>
    <div class="expiry">Valid for ${OTP_EXPIRY_MIN} minutes only</div>
  </div>
  <div class="warn">⚠️ If you didn't request this, please ignore this email. Your account is safe.</div>
  <div class="footer">© Nagrik OS · सत्यमेव जयते</div>
</div></div></body></html>`;

/**
 * Send OTP to an email address.
 * @param {string} to - recipient email
 * @param {string} otp - 6-digit plain-text OTP
 */
const sendOTPEmail = (to, otp) => send({
  to,
  subject: `${otp} is your Nagrik OS sign-in code`,
  html: otpHTML(otp),
  text: `Your Nagrik OS OTP is: ${otp}\nValid for ${OTP_EXPIRY_MIN} minutes. Do not share.`,
});

/**
 * Send grievance confirmation email.
 */
const sendGrievanceConfirmation = (to, { refCode, category, wardName }) => send({
  to,
  subject: `Grievance ${refCode} filed — Nagrik OS`,
  html: `<div style="font-family:Arial,sans-serif;background:#050507;padding:20px">
    <div style="max-width:460px;margin:0 auto;background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:32px">
      <div style="font-size:20px;font-weight:900;letter-spacing:4px;color:#f7f0e2;margin-bottom:20px">NAGRIK OS</div>
      <h2 style="font-size:17px;color:#f7f0e2;margin-bottom:16px">✅ Grievance Filed Successfully</h2>
      <div style="background:#050507;border:1px solid rgba(255,122,26,.3);border-radius:10px;padding:16px;margin-bottom:16px">
        <div style="font-size:11px;color:#8899aa;letter-spacing:1px;margin-bottom:4px">REFERENCE CODE</div>
        <div style="font-size:22px;font-weight:700;color:#ff7a1a;font-family:monospace">${refCode}</div>
      </div>
      <div style="font-size:14px;color:#8899aa;line-height:1.7">
        <b style="color:#f7f0e2">Category:</b> ${category}<br>
        <b style="color:#f7f0e2">Ward:</b> ${wardName || 'Not specified'}
      </div>
      <div style="font-size:11px;color:#374151;margin-top:24px">© Nagrik OS · सत्यमेव जयते</div>
    </div></div>`,
  text: `Grievance ${refCode} filed. Category: ${category}. Ward: ${wardName || 'N/A'}.`,
});
const sendComplaintEmailViaResend = async ({ to, subject, html, text, attachments = [] }) => {
  const payload = {
    from: `${process.env.EMAIL_FROM_NAME || 'Nagrik OS'} <${process.env.EMAIL_FROM}>`,
    to: [to],
    subject,
    html,
    text,
  };

  // Resend supports attachments as array of {filename, content (base64)}
  if (attachments.length > 0) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.content, // base64 string
    }));
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Resend error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  return res.json();
};

module.exports = { sendOTPEmail, sendGrievanceConfirmation, sendComplaintEmailViaResend };
