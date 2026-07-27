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
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
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
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dealers_created_at ON dealers (created_at);

-- Per-dealer check-in/check-out geofence radius (Dealer Geofencing spec).
-- Defaults to 200m; a manager may override per dealer from the web admin UI.
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS radius_meters INTEGER NOT NULL DEFAULT 200;

-- ============================================================
-- 3. attendance
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id                      SERIAL PRIMARY KEY,
  employee_id             INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  business_date           DATE,
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

-- business_date is populated by the app at check-in (see attendance.routes.js)
-- using the same DAY_BOUNDARY_HOUR-aware expression as businessDay.js. It backs
-- a unique constraint that makes "already checked in today" an atomic DB
-- guarantee (via INSERT ... ON CONFLICT) instead of a check-then-insert race
-- between the SELECT guard and the INSERT, which could otherwise let two
-- concurrent check-in requests (double-tap, retry-on-timeout) both succeed.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS business_date DATE;
UPDATE attendance SET business_date = DATE((check_in_time) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '5 hours')
  WHERE business_date IS NULL AND check_in_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance (employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_check_in_time ON attendance (check_in_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_employee_business_date
  ON attendance (employee_id, business_date) WHERE business_date IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_visits_check_in_time ON client_visits (check_in_time);

-- Dealer Geofencing & GPS Validation spec — per-event accuracy/distance capture,
-- check-in radius flag (check-out already had out_of_radius), the check-in vs
-- check-out tolerance-match flag, and a separate check-out justification (the
-- existing justification_note column now holds the check-in reason).
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_in_accuracy_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_out_accuracy_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_in_distance_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_out_distance_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_in_inside_radius BOOLEAN;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS matched_check_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS check_out_justification_note TEXT;

-- Periodic in-visit location verification (Random Location Verification spec):
-- while a visit is open, the app re-samples GPS every few minutes. If the rep
-- is found outside the dealer's radius for longer than a grace period, the
-- visit is flagged interrupted — a distinct signal from out_of_radius (which
-- only describes the check-in/check-out moments) that a manager can review.
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted_distance_m DOUBLE PRECISION;

-- ============================================================
-- 5. exception_log
-- ============================================================
-- Every check-in/check-out performed outside the dealer's approved radius,
-- with the mandatory justification the rep entered, for manager review.
-- 'interrupted' events (added for Random Location Verification) have no
-- rep-entered reason — they're system-detected, not self-reported.
CREATE TABLE IF NOT EXISTS exception_log (
  id                SERIAL PRIMARY KEY,
  employee_id       INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  dealer_id         INTEGER       NOT NULL REFERENCES dealers (id),
  visit_id          INTEGER       REFERENCES client_visits (id) ON DELETE CASCADE,
  event_type        VARCHAR(12)   NOT NULL CHECK (event_type IN ('check-in', 'check-out', 'interrupted')),
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  distance_meters   DOUBLE PRECISION,
  gps_accuracy_m    DOUBLE PRECISION,
  reason            TEXT,
  matched_check_in  BOOLEAN       NOT NULL DEFAULT FALSE,
  manager_reviewed  BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- event_type predates 'interrupted' (11 chars, exceeds the original
-- VARCHAR(10)) on databases created before this migration — widen the column
-- and its CHECK constraint so re-running migrate.js on an existing DB doesn't
-- leave either one rejecting the new event type.
ALTER TABLE exception_log ALTER COLUMN event_type TYPE VARCHAR(12);
ALTER TABLE exception_log DROP CONSTRAINT IF EXISTS exception_log_event_type_check;
ALTER TABLE exception_log ADD CONSTRAINT exception_log_event_type_check
  CHECK (event_type IN ('check-in', 'check-out', 'interrupted'));

CREATE INDEX IF NOT EXISTS idx_exception_log_employee    ON exception_log (employee_id);
CREATE INDEX IF NOT EXISTS idx_exception_log_created_at  ON exception_log (created_at);
