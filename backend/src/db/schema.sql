-- FieldTrack Database Migration
-- Stage 3: Full schema for employees, dealers, attendance, client_visits
-- Run via: node src/db/migrate.js
-- We use plain SQL migrations (no ORM) for simplicity and transparency.
-- The schema is designed to be re-runnable (IF NOT EXISTS guards).

-- ============================================================
-- 1. employees
-- ============================================================
CREATE TABLE IF NOT EXISTS employees (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(150)  NOT NULL,
  phone           VARCHAR(20),
  username        VARCHAR(80)   NOT NULL UNIQUE,
  password_hash   VARCHAR(255)  NOT NULL,
  role            VARCHAR(20)   NOT NULL CHECK (role IN ('rep', 'manager')),
  region          VARCHAR(100),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_username ON employees (username);

-- ============================================================
-- 2. dealers
-- ============================================================
CREATE TABLE IF NOT EXISTS dealers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(200)  NOT NULL,
  address         TEXT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  contact_person  VARCHAR(150),
  contact_phone   VARCHAR(20),
  -- Per Stage 7: radius_meters is configurable per dealer.
  -- Falls back to the CHECKIN_RADIUS_METERS env var when NULL.
  radius_meters   INTEGER       DEFAULT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dealers_created_at ON dealers (created_at);

-- ============================================================
-- 3. attendance
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id                      SERIAL PRIMARY KEY,
  employee_id             INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  check_in_time           TIMESTAMPTZ,
  check_in_lat            DOUBLE PRECISION,
  check_in_lng            DOUBLE PRECISION,
  check_out_time          TIMESTAMPTZ,
  check_out_lat           DOUBLE PRECISION,
  check_out_lng           DOUBLE PRECISION,
  total_distance_km       DOUBLE PRECISION DEFAULT 0,
  total_duration_minutes  INTEGER,
  sync_status             VARCHAR(20)   NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending')),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance (employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_created_at  ON attendance (created_at);

-- ============================================================
-- 4. client_visits
-- ============================================================
CREATE TABLE IF NOT EXISTS client_visits (
  id                          SERIAL PRIMARY KEY,
  attendance_id               INTEGER       NOT NULL REFERENCES attendance (id) ON DELETE CASCADE,
  dealer_id                   INTEGER       NOT NULL REFERENCES dealers (id),
  check_in_time               TIMESTAMPTZ,
  check_in_lat                DOUBLE PRECISION,
  check_in_lng                DOUBLE PRECISION,
  check_out_time              TIMESTAMPTZ,
  check_out_lat               DOUBLE PRECISION,
  check_out_lng               DOUBLE PRECISION,
  visit_duration_minutes      INTEGER,
  distance_from_previous_km   DOUBLE PRECISION DEFAULT 0,
  out_of_radius               BOOLEAN       NOT NULL DEFAULT FALSE,
  justification_note          TEXT,
  sync_status                 VARCHAR(20)   NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending')),
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visits_attendance_id ON client_visits (attendance_id);
CREATE INDEX IF NOT EXISTS idx_visits_dealer_id     ON client_visits (dealer_id);
CREATE INDEX IF NOT EXISTS idx_visits_created_at    ON client_visits (created_at);
