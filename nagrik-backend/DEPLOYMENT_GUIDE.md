# NAGRIK OS BACKEND · DEPLOYMENT GUIDE + PRE-LAUNCH CHECKLIST
**© Krishant Dutta | v1.0.0 | Complete Guide**

---

## SECTION 1: WHAT'S IN THE BACKEND

```
nagrik-backend/
├── server.js              ← Entry point. Start here.
├── package.json           ← Dependencies
├── .env.example           ← Copy to .env and fill in
├── render.yaml            ← Render.com deploy config
├── railway.toml           ← Railway.app deploy config
├── Procfile               ← Heroku-style process file
│
├── config/
│   ├── db.js              ← PostgreSQL pool + query helper
│   └── constants.js       ← All app constants
│
├── middleware/
│   ├── auth.js            ← JWT verification (requireAuth, optionalAuth, requireRole)
│   ├── rateLimit.js       ← Rate limiters (OTP, API, grievance)
│   └── errorHandler.js    ← Global error + 404 handler + asyncWrap
│
├── services/
│   ├── otp.js             ← OTP generate, hash (bcrypt), verify
│   ├── email.js           ← Email send (Resend / SMTP / console)
│   ├── sms.js             ← SMS send (Fast2SMS / Twilio / console)
│   └── upload.js          ← Cloudinary photo upload
│
├── routes/
│   ├── auth.js            ← /api/auth/* (send/verify OTP, refresh, logout, profile)
│   ├── grievances.js      ← /api/grievances/* (submit, list, update, upvote)
│   ├── ratings.js         ← /api/ratings/* (rate ward, get aggregates)
│   ├── representatives.js ← /api/reps/* (Phase 2 data migration)
│   ├── cities.js          ← /api/cities/* (list cities, stats)
│   └── admin.js           ← /api/admin/* (dashboard, stats, heatmap)
│
├── db/
│   ├── schema.sql         ← Full PostgreSQL schema (run once)
│   └── init.js            ← Script to apply schema + verify
│
└── public/
    └── auth.html          ← Beautiful OTP login page
```

---

## SECTION 2: ZERO-COST HOSTING OPTIONS

### OPTION A: Railway.app + Neon.tech (RECOMMENDED for testing)
**Best because:** Railway doesn't sleep, Neon PostgreSQL is free forever.

**Cost:** ₹0 (Railway gives $5 free credit/month ≈ 500 hours)

**Steps:**
1. Sign up at [railway.app](https://railway.app) (GitHub login)
2. "New Project" → "Deploy from GitHub repo"
3. Push your backend to a GitHub repo first
4. In Railway: "Add a Variable" → Add all env vars from `.env.example`
5. Sign up at [neon.tech](https://neon.tech) → Create DB → Get connection string
6. Set `DATABASE_URL` to Neon connection string in Railway
7. Add `?sslmode=require` to the end of Neon URL
8. Deploy!

**Free limits:** 500 hours/month compute (unlimited on paid), 0.5GB DB on Neon

---

### OPTION B: Render.com (Easiest, but sleeps after 15 min)
**Cost:** ₹0 (free tier)
**Problem:** Server sleeps after 15 min inactivity — first request takes 30-60 sec to wake up

**Steps:**
1. Push code to GitHub
2. Sign up at [render.com](https://render.com)
3. "New" → "Web Service" → Connect GitHub repo
4. Build: `npm install`, Start: `npm start`
5. "New" → "PostgreSQL" → Get connection string
6. Run schema: `psql <DATABASE_URL> -f db/schema.sql`
7. Set env vars in Render dashboard
8. Deploy

**Free limits:** 750 hours/month web, 1GB DB (expires after 90 days on free tier)

---

### OPTION C: Fly.io (Best free tier overall)
**Cost:** ₹0 (3 shared VMs free)

**Steps:**
1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. `fly auth signup`
3. `cd nagrik-backend && fly launch`
4. `fly postgres create --name nagrik-db`
5. `fly postgres attach nagrik-db`
6. `fly secrets set JWT_SECRET=... JWT_REFRESH_SECRET=...` (all env vars)
7. `fly deploy`
8. Run schema: `fly ssh console -C "psql \$DATABASE_URL -f db/schema.sql"`

---

### OPTION D: Full free stack combination
```
Backend:     Railway.app      (free $5 credit/month)
Database:    Neon.tech        (free 0.5GB PostgreSQL, never expires)
Photos:      Cloudinary       (free 25GB storage, 25GB bandwidth)
Email OTP:   Resend.com       (free 3,000 emails/day)
Phone OTP:   Fast2SMS         (free 300 SMS on signup)
Frontend:    GitHub Pages     (free static hosting)
Domain:      Freenom/.tk      (free) OR .in domain (₹600/year)
```

---

## SECTION 3: STEP-BY-STEP DEPLOYMENT (Railway + Neon)

### Step 1: Prepare code (5 minutes)
```bash
cd nagrik-backend
npm install                # Install all dependencies
node db/init.js            # Test DB connection (after setting DATABASE_URL)
```

### Step 2: Create .env file
```bash
cp .env.example .env
# Edit .env — fill in DATABASE_URL, JWT secrets (generate below)
```

Generate JWT secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Run twice — once for JWT_SECRET, once for JWT_REFRESH_SECRET
```

### Step 3: Test locally (2 minutes)
```bash
node server.js
# Should see: NAGRIK OS BACKEND running on port 3000

# In another terminal:
curl http://localhost:3000/health
# Should return: {"status":"ok","db":"connected",...}

# Test auth page:
# Open http://localhost:3000/login in browser
```

### Step 4: Push to GitHub
```bash
git init
git add .
git commit -m "feat: Nagrik OS backend v1.0.0"
git remote add origin https://github.com/YOUR_USERNAME/nagrik-backend
git push -u origin main
```

### Step 5: Deploy to Railway
1. Go to railway.app → New Project → Deploy from GitHub
2. Select your repo
3. Go to "Variables" tab → Add all from `.env.example` (fill in real values)
4. Set `NODE_ENV=production`
5. Go to "Settings" → "Domain" → Generate domain
6. Wait for deploy (2-3 minutes)

### Step 6: Initialize the database
```bash
# Get Neon connection string from neon.tech dashboard
# Run schema against Neon:
psql "postgresql://user:pass@host/nagrik_db?sslmode=require" -f db/schema.sql

# OR use Railway's built-in terminal:
# In Railway: your service → "Shell" → run: node db/init.js
```

### Step 7: Test production endpoints
```bash
BASE="https://your-app.up.railway.app"

# Health check
curl $BASE/health

# Send email OTP (check console/logs for OTP in dev mode)
curl -X POST $BASE/api/auth/send-email-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# Auth page
open $BASE/login
```

### Step 8: Update nagrik.js to point to backend
In your nagrik.js, find the top of the ENGINE CODE section and add:
```js
// ── BACKEND API ──────────────────────────────────────────────
const BACKEND_URL = 'https://your-app.up.railway.app'; // Your deployed URL
const getJWT = () => localStorage.getItem('nagrik_jwt');
const authHeaders = () => ({ 'Content-Type':'application/json', 'Authorization': `Bearer ${getJWT()}` });
```

### Step 9: Connect auth page to nagrik.js
In nagrik.js `init()`, add auth check at the top:
```js
// Check if user is logged in
const jwt = localStorage.getItem('nagrik_jwt');
if (!jwt) {
  // Save current URL, redirect to login
  localStorage.setItem('nagrik_auth_redirect', window.location.href);
  window.location.href = BACKEND_URL + '/login';
  return;
}
```

Or for optional auth (app works without login):
```js
// No redirect — app works for everyone, extra features for logged-in users
const jwt = localStorage.getItem('nagrik_jwt');
const isLoggedIn = !!jwt;
// Show login prompt only when user tries to submit grievance/rating
```

---

## SECTION 4: WHAT STILL NEEDS TO BE DONE (Pre-Launch Checklist)

### A. BACKEND COMPLETION CHECKS

**Authentication:**
- [ ] Test email OTP flow end-to-end (send → receive → verify → JWT)
- [ ] Test phone OTP flow (requires Fast2SMS API key)
- [ ] Test refresh token rotation (POST /api/auth/refresh)
- [ ] Test logout + token revocation
- [ ] Test expired token (wait 1 hour, make request — should get 401)
- [ ] Test rate limiting (send OTP 4 times in 15 min — should get 429 on 4th)

**Grievances:**
- [ ] Submit grievance without photo (minimum fields)
- [ ] Submit grievance WITH photo (base64 upload to Cloudinary)
- [ ] Check ref_code is generated (NGK-PUNE-000001)
- [ ] Check public feed returns only `is_public=true` grievances
- [ ] Test upvote → toggle (upvote again removes it)
- [ ] Test status update (as admin) with history logged

**Ratings:**
- [ ] Submit rating → upsert works (submit same ward twice, second updates)
- [ ] Check ward aggregate (GET /api/ratings/ward/5 returns avg of all users)
- [ ] Check city ratings heatmap (GET /api/ratings/city/pune)

**Admin:**
- [ ] Create admin account (POST /api/admin/create-admin with ADMIN_SECRET)
- [ ] Check stats endpoint (GET /api/admin/stats/pune)
- [ ] Check grievance list with filters
- [ ] Check heatmap data

### B. FRONTEND INTEGRATION CHECKS

- [ ] nagrik.js loads JWT from localStorage on startup
- [ ] Auth page redirects back to app after login
- [ ] Rating submission calls API instead of localStorage
- [ ] Grievance submission calls API instead of localStorage
- [ ] Public feed loads from API instead of localStorage
- [ ] "My Grievances" loads from API
- [ ] Handle 401 (expired JWT → refresh token → retry OR redirect to login)

### C. EMAIL SETUP

- [ ] Create account at [resend.com](https://resend.com)
- [ ] Add and verify your domain (e.g., nagrikos.in) in Resend
- [ ] Copy API key → set `RESEND_API_KEY` env var
- [ ] Set `EMAIL_FROM` to a verified email (e.g., noreply@nagrikos.in)
- [ ] Set `EMAIL_PROVIDER=resend`
- [ ] Test: Send OTP → Check inbox (may be in spam first time)
- [ ] Add SPF/DKIM DNS records (Resend dashboard provides these)

### D. SMS SETUP (Fast2SMS — Indian)

1. Sign up at [fast2sms.com](https://www.fast2sms.com)
2. Complete KYC (required for DLT)
3. Register sender ID: "NAGRIK" (₹500 one-time)
4. Create DLT template: "Your Nagrik OS OTP is {#var#}. Valid for 5 minutes."
5. Copy API key → set `FAST2SMS_API_KEY` env var
6. Set `FAST2SMS_TEMPLATE_ID` to your approved template ID
7. Set `SMS_PROVIDER=fast2sms`
8. Test: Send phone OTP → Check SMS

**Note:** For testing only (no DLT), Fast2SMS "quick" route works without registration.

### E. CLOUDINARY SETUP

1. Sign up at [cloudinary.com](https://cloudinary.com)
2. Dashboard → API Keys → Copy cloud name, API key, API secret
3. Set all three `CLOUDINARY_*` env vars
4. Test: Submit grievance with photo → Check Cloudinary dashboard for uploaded file

### F. DOMAIN SETUP

1. Buy domain: namecheap.com (.in for ₹600/yr, .com for ₹1200/yr)
2. Connect to Railway/Render: Settings → Custom Domain → Enter domain
3. Update DNS: Add CNAME record pointing domain to Railway/Render URL
4. Update `ALLOWED_ORIGINS` to include your domain
5. SSL auto-provisioned by Railway/Render

### G. SECURITY CHECKS (Before going public)

- [ ] `JWT_SECRET` is random 64-char hex (not default or simple)
- [ ] `JWT_REFRESH_SECRET` is different from JWT_SECRET
- [ ] `ADMIN_SECRET` is set and strong
- [ ] `.env` is in `.gitignore` (NEVER committed to Git)
- [ ] `NODE_ENV=production` on server
- [ ] `ALLOWED_ORIGINS` contains ONLY your frontend URL (not *)
- [ ] Rate limiting is active (test with curl loop)
- [ ] All inputs are validated before DB insertion
- [ ] Photos are size-limited (5MB max enforced)
- [ ] `/api/admin/*` requires admin role (test with regular user token)

### H. DATABASE MAINTENANCE

Run these periodically (or set up pg_cron):
```sql
-- Clean expired OTPs (run every hour)
SELECT cleanup_expired_otps();

-- Clean revoked refresh tokens (run daily)
SELECT cleanup_expired_tokens();
```

---

## SECTION 5: COMPLETE API REFERENCE

### Auth Routes (`/api/auth`)
| Method | Path | Body | Auth | Description |
|--------|------|------|------|-------------|
| POST | /send-email-otp | `{email}` | None | Send email OTP |
| POST | /verify-email-otp | `{email, otp}` | None | Verify → get JWT |
| POST | /send-phone-otp | `{phone}` | None | Send SMS OTP |
| POST | /verify-phone-otp | `{phone, otp}` | None | Verify → get JWT |
| POST | /refresh | `{refreshToken}` | None | Get new access token |
| POST | /logout | `{refreshToken}` | None | Revoke refresh token |
| GET | /me | — | Bearer | Current user profile |
| PUT | /profile | `{name?, wardId?, wardName?}` | Bearer | Update profile |

### Grievance Routes (`/api/grievances`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | / | Bearer | Submit grievance |
| GET | /public | Optional | Public feed |
| GET | /mine | Bearer | My grievances |
| GET | /:id | Optional | Single grievance |
| PATCH | /:id | Bearer | Update (toggle public) |
| POST | /:id/upvote | Bearer | Toggle upvote |
| PUT | /:id/status | Admin/Officer | Update status |

### Rating Routes (`/api/ratings`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | / | Bearer | Rate a ward |
| GET | /city/:cityId | None | All ward ratings |
| GET | /ward/:wardId | Optional | Ward detail + your rating |
| GET | /mine | Bearer | All my ratings |

### Admin Routes (`/api/admin`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /stats/:cityId | Admin | Dashboard stats |
| GET | /grievances | Admin | All grievances + filters |
| GET | /heatmap/:cityId | Admin | GPS heatmap data |
| GET/PUT | /settings | Admin | App settings |
| GET | /users | Admin | User list |
| POST | /create-admin | Admin | Elevate user to admin |

---

## SECTION 6: ERROR CODES REFERENCE

| Code | Meaning | Fix |
|------|---------|-----|
| NO_TOKEN | No Bearer token | Include Authorization header |
| TOKEN_EXPIRED | Access token expired | Call POST /api/auth/refresh |
| TOKEN_REVOKED | Refresh token revoked | User must log in again |
| INVALID_TOKEN | Bad token format | Re-login |
| USER_INACTIVE | Account deactivated | Contact admin |
| NO_OTP | OTP not found | Request new OTP |
| EXPIRED | OTP expired | Request new OTP |
| WRONG_OTP | Wrong code entered | Try again (check attemptsRemaining) |
| MAX_ATTEMPTS | 3 wrong attempts | Request new OTP |
| RATE_LIMITED | Too many requests | Wait and retry |
| INVALID_CATEGORY | Bad grievance category | Use allowed categories list |
| DUPLICATE | Record already exists | (usually handled silently) |

---

## SECTION 7: COMMON BUGS TO CHECK

### Bug: CORS error in browser console
**Fix:** Check `ALLOWED_ORIGINS` includes the exact origin (no trailing slash):
```
ALLOWED_ORIGINS=http://localhost:8000,https://yourdomain.com
```

### Bug: DB connection fails on Railway/Render
**Fix 1:** Add `?sslmode=require` to DATABASE_URL  
**Fix 2:** In db.js, ensure `ssl: { rejectUnauthorized: false }` for production  
**Fix 3:** Check DATABASE_URL format: `postgresql://user:pass@host:5432/dbname`

### Bug: OTP not arriving in email
**Fix 1:** Check `EMAIL_PROVIDER` env var (set to `resend` not `console`)  
**Fix 2:** Check Resend API key is correct  
**Fix 3:** Verify your domain in Resend dashboard  
**Fix 4:** Check spam folder  
**Fix 5:** Check Resend dashboard → Emails → see if it shows "delivered" or "bounced"

### Bug: JWT expired on frontend, user gets logged out
**Fix:** Implement token refresh in nagrik.js:
```js
const refreshIfNeeded = async () => {
  const refresh = localStorage.getItem('nagrik_refresh');
  if (!refresh) return false;
  const res = await fetch(`${BACKEND_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (res.ok) {
    const data = await res.json();
    localStorage.setItem('nagrik_jwt', data.accessToken);
    localStorage.setItem('nagrik_refresh', data.refreshToken);
    return true;
  }
  return false;
};
```

### Bug: Photos not uploading
**Fix 1:** Check all 3 Cloudinary env vars are set  
**Fix 2:** Check photo is valid base64 data URI  
**Fix 3:** Check photo is under 5MB  
**Fix 4:** Check Cloudinary dashboard → Usage → not at limit

### Bug: Rate limit hits too quickly
**Fix:** Adjust in `.env`:
```
OTP_RATE_LIMIT_MAX=5     # Increase from 3 to 5
OTP_RATE_LIMIT_WINDOW=600000  # Decrease to 10 minutes
```

### Bug: Grievance ref_code conflict
**Fix:** The sequence `grievance_seq` is shared across cities. Ensure it's initialized:
```sql
SELECT setval('grievance_seq', 1, false);
```

---

## SECTION 8: PERFORMANCE NOTES

At **1,000 users** (Phase 1):
- Current setup (Railway free + Neon free) handles it fine
- Expect <100ms response times on simple queries
- Photo uploads take 1-3 seconds (Cloudinary)

At **10,000 concurrent users** (Phase 2):
- Need paid Railway plan ($20/month)
- Need Neon paid ($19/month) or AWS RDS
- Add Redis for rate limiting (shared across multiple server instances)
- Add CDN (Cloudflare free) in front of backend
- Consider read replicas for DB

---

## SECTION 9: FUTURE EXTENSIBILITY

The backend is designed for easy extension:

**Adding a new city:** Add row to `cities` table, set `active=true`. No code changes.

**Adding a new grievance category:** Add to `GRIEVANCE_CATEGORIES` in `config/constants.js`.

**Adding an admin email per category:** Update `ADMIN_EMAILS` in `routes/grievances.js`.

**Adding real-time notifications:** Install `socket.io`, emit on status updates from `routes/admin.js`.

**Adding push notifications:** Install `web-push`, store FCM tokens in `users` table.

**Adding analytics:** Install `posthog-node` or `@amplitude/analytics-node`. Track events in routes.

**Multi-language:** Store language preference in `users` table, return translated content from API.

**Rate limiting per user (not IP):** In `rateLimit.js`, use `req.user?.id` as key instead of `req.ip`.

---

**© Krishant Dutta | NAGRIK OS Backend v1.0.0 | सत्यमेव जयते**

*Ready to deploy. Ready to scale. Ready to hold power accountable.*
