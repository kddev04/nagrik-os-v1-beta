-- ══════════════════════════════════════════════════════════════
-- NAGRIK OS · POSTGRESQL SCHEMA v1.0
-- Run: psql $DATABASE_URL -f db/schema.sql
-- ══════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For full-text search on names

-- ── HELPER: updated_at auto-trigger ──────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- TABLE: cities
-- Registry of all supported cities. Easily add new cities here.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cities (
  id              VARCHAR(50)  PRIMARY KEY,               -- e.g. 'pune', 'mumbai'
  name            VARCHAR(100) NOT NULL,
  name_hindi      VARCHAR(100),
  state           VARCHAR(100) NOT NULL,
  active          BOOLEAN      DEFAULT false,
  beta            BOOLEAN      DEFAULT true,              -- Beta flag for UI badge
  ward_count      INTEGER      DEFAULT 0,
  corp_count      INTEGER      DEFAULT 0,
  center_lat      DECIMAL(9,6) NOT NULL,
  center_lng      DECIMAL(9,6) NOT NULL,
  default_zoom    INTEGER      DEFAULT 12,
  pmc_domain      VARCHAR(200),
  pmc_portal_url  VARCHAR(500),
  rti_portal_url  VARCHAR(500),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- Seed Pune as first active city
INSERT INTO cities (id, name, name_hindi, state, active, beta, ward_count, corp_count, center_lat, center_lng, default_zoom, pmc_domain, pmc_portal_url, rti_portal_url)
VALUES ('pune', 'Pune', 'पुणे', 'Maharashtra', true, false, 41, 165, 18.5304, 73.8567, 12, 'punecorporation.org', 'https://pmc.gov.in', 'https://rtionline.maharashtra.gov.in')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- TABLE: users
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id         VARCHAR(50)  REFERENCES cities(id) DEFAULT 'pune',
  phone           VARCHAR(15)  UNIQUE,                   -- E.164 format: +919876543210
  email           VARCHAR(255) UNIQUE,
  name            VARCHAR(100),
  ward_id         INTEGER,                               -- Auto-detected from GPS or manual
  ward_name       VARCHAR(100),
  role            VARCHAR(20)  DEFAULT 'citizen'        -- citizen | moderator | admin | pmc_officer
    CHECK (role IN ('citizen', 'moderator', 'admin', 'pmc_officer')),
  is_verified     BOOLEAN      DEFAULT false,
  is_active       BOOLEAN      DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  grievance_count INTEGER      DEFAULT 0,              -- Denormalized for performance
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_city   ON users(city_id);
CREATE INDEX IF NOT EXISTS idx_users_ward   ON users(ward_id);

-- ─────────────────────────────────────────────────────────────
-- TABLE: otp_codes
-- Short-lived OTP storage. Cleaned up by cron or on use.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  identifier      VARCHAR(255) NOT NULL,               -- email or phone
  identifier_type VARCHAR(10)  NOT NULL                -- 'email' | 'phone'
    CHECK (identifier_type IN ('email', 'phone')),
  otp_hash        VARCHAR(255) NOT NULL,               -- bcrypt hash of 6-digit OTP
  purpose         VARCHAR(30)  DEFAULT 'login'         -- 'login' | 'verify'
    CHECK (purpose IN ('login', 'verify')),
  attempts        INTEGER      DEFAULT 0,              -- Wrong attempt counter
  used            BOOLEAN      DEFAULT false,
  expires_at      TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_identifier ON otp_codes(identifier, identifier_type);
CREATE INDEX IF NOT EXISTS idx_otp_expires    ON otp_codes(expires_at);

-- ─────────────────────────────────────────────────────────────
-- TABLE: refresh_tokens
-- JWT refresh token store. One active token per user session.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      VARCHAR(255) NOT NULL UNIQUE,        -- SHA-256 hash of token
  device_info     TEXT,                                -- Browser/device UA string
  ip_address      VARCHAR(45),
  expires_at      TIMESTAMPTZ  NOT NULL,
  revoked         BOOLEAN      DEFAULT false,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rt_user_id   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_token     ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rt_expires   ON refresh_tokens(expires_at);

-- ─────────────────────────────────────────────────────────────
-- TABLE: grievances
-- Core table. Every citizen complaint lives here.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grievances (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref_code        VARCHAR(20)  UNIQUE,                 -- Human-readable: NGK-PUNE-000001
  user_id         UUID         REFERENCES users(id) ON DELETE SET NULL,
  city_id         VARCHAR(50)  NOT NULL REFERENCES cities(id),
  ward_id         INTEGER,
  ward_name       VARCHAR(100),

  -- Issue details
  category        VARCHAR(60)  NOT NULL,
  description     TEXT         NOT NULL                CHECK (length(description) >= 20),
  priority        VARCHAR(10)  DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Location
  gps_lat         DECIMAL(9,6),
  gps_lng         DECIMAL(9,6),
  gps_accuracy    DECIMAL(8,2),                       -- Metres
  location_text   TEXT,                               -- Human-readable: "Near Shivajinagar PS"

  -- Media
  photo_url       TEXT,                               -- Cloudinary URL
  photo_public_id TEXT,                               -- Cloudinary public_id (for deletion)

  -- Representatives
  rep_type        VARCHAR(10)                         -- 'corp' | 'mla' | 'mp'
    CHECK (rep_type IN ('corp', 'mla', 'mp', NULL)),
  rep_id          VARCHAR(30),                        -- e.g. 'W5-A'
  rep_name        VARCHAR(100),
  rep_email       VARCHAR(255),

  -- Email
  email_draft     TEXT,                               -- The auto-generated email
  email_sent      BOOLEAN      DEFAULT false,
  email_sent_at   TIMESTAMPTZ,

  -- Visibility & Status
  is_public       BOOLEAN      DEFAULT false,
  status          VARCHAR(20)  DEFAULT 'filed'
    CHECK (status IN ('filed', 'received', 'acknowledged', 'in_progress', 'resolved', 'rejected', 'closed')),
  assigned_to     UUID         REFERENCES users(id),  -- PMC officer
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,

  -- Engagement
  upvotes         INTEGER      DEFAULT 0,
  view_count      INTEGER      DEFAULT 0,

  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TRIGGER trg_grievances_updated_at
  BEFORE UPDATE ON grievances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_griev_user     ON grievances(user_id);
CREATE INDEX IF NOT EXISTS idx_griev_city     ON grievances(city_id);
CREATE INDEX IF NOT EXISTS idx_griev_ward     ON grievances(ward_id);
CREATE INDEX IF NOT EXISTS idx_griev_status   ON grievances(status);
CREATE INDEX IF NOT EXISTS idx_griev_public   ON grievances(is_public, city_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_griev_category ON grievances(category, city_id);
CREATE INDEX IF NOT EXISTS idx_griev_gps      ON grievances(gps_lat, gps_lng) WHERE gps_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_griev_ref      ON grievances(ref_code);

-- Auto-generate ref_code: NGK-PUNE-000001
CREATE SEQUENCE IF NOT EXISTS grievance_seq START 1;

CREATE OR REPLACE FUNCTION generate_grievance_ref(city VARCHAR)
RETURNS VARCHAR AS $$
BEGIN
  RETURN 'NGK-' || upper(city) || '-' || lpad(nextval('grievance_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- TABLE: grievance_updates
-- Full audit trail of every status change
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grievance_updates (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  grievance_id    UUID         NOT NULL REFERENCES grievances(id) ON DELETE CASCADE,
  updated_by      UUID         REFERENCES users(id),
  from_status     VARCHAR(20),
  to_status       VARCHAR(20)  NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gu_grievance ON grievance_updates(grievance_id, created_at);

-- ─────────────────────────────────────────────────────────────
-- TABLE: grievance_upvotes
-- Unique votes per user per grievance
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grievance_upvotes (
  grievance_id    UUID         NOT NULL REFERENCES grievances(id) ON DELETE CASCADE,
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  PRIMARY KEY (grievance_id, user_id)
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: ratings
-- One rating per user per ward per city. Upsertable.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id         VARCHAR(50)  NOT NULL REFERENCES cities(id),
  ward_id         INTEGER      NOT NULL,
  satisfaction    SMALLINT     NOT NULL CHECK (satisfaction BETWEEN 1 AND 5),
  safety          SMALLINT     NOT NULL CHECK (safety BETWEEN 1 AND 5),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(user_id, city_id, ward_id)                  -- One rating per user per ward
);

CREATE TRIGGER trg_ratings_updated_at
  BEFORE UPDATE ON ratings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_ratings_city_ward ON ratings(city_id, ward_id);
CREATE INDEX IF NOT EXISTS idx_ratings_user       ON ratings(user_id);

-- View: Aggregated ratings per ward (used by frontend for heatmap)
CREATE OR REPLACE VIEW ward_ratings_agg AS
SELECT
  city_id,
  ward_id,
  ROUND(AVG(satisfaction)::NUMERIC, 2) AS avg_satisfaction,
  ROUND(AVG(safety)::NUMERIC, 2)       AS avg_safety,
  COUNT(*)                              AS rating_count
FROM ratings
GROUP BY city_id, ward_id;

-- ─────────────────────────────────────────────────────────────
-- TABLE: representatives (Phase 2 — optional in Phase 1)
-- When ready to move data out of nagrik.js, populate this.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS representatives (
  id              VARCHAR(30)  PRIMARY KEY,            -- 'W1-A', 'MLA-kasba-peth'
  city_id         VARCHAR(50)  NOT NULL REFERENCES cities(id),
  rep_type        VARCHAR(10)  NOT NULL
    CHECK (rep_type IN ('corp', 'mla', 'mp')),
  name            VARCHAR(100) NOT NULL,
  party           VARCHAR(30),
  ward_id         INTEGER,
  ward_name       VARCHAR(100),
  constituency    VARCHAR(100),
  seat            VARCHAR(10),
  reservation     VARCHAR(50),
  lat             DECIMAL(9,6),
  lng             DECIMAL(9,6),
  phone           VARCHAR(20),
  email           VARCHAR(255),
  office_address  TEXT,
  zone_office     TEXT,
  promises        JSONB        DEFAULT '[]',
  bio             TEXT,
  votes           INTEGER,
  vote_pct        DECIMAL(5,2),
  margin          INTEGER,
  turnout         VARCHAR(10),
  alliance        VARCHAR(50),
  active          BOOLEAN      DEFAULT true,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TRIGGER trg_reps_updated_at
  BEFORE UPDATE ON representatives
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_reps_city     ON representatives(city_id, rep_type);
CREATE INDEX IF NOT EXISTS idx_reps_ward     ON representatives(ward_id, city_id);
CREATE INDEX IF NOT EXISTS idx_reps_name_trgm ON representatives USING gin(name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────
-- TABLE: app_settings
-- Key-value store for runtime configuration
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key             VARCHAR(100) PRIMARY KEY,
  value           TEXT,
  description     TEXT,
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

INSERT INTO app_settings (key, value, description) VALUES
  ('maintenance_mode', 'false', 'Set to true to show maintenance page'),
  ('grievance_public_default', 'false', 'Default visibility for new grievances'),
  ('otp_enabled_email', 'true', 'Enable email OTP login'),
  ('otp_enabled_phone', 'true', 'Enable phone OTP login'),
  ('max_photo_size_mb', '5', 'Maximum photo upload size in MB')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- CLEANUP JOB: Expired OTPs (run via cron or pg_cron)
-- Execute manually: SELECT cleanup_expired_otps();
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_expired_otps()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM otp_codes WHERE expires_at < NOW() OR used = true;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = true;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
