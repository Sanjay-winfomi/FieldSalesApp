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

-- Per-dealer login/logout geofence radius (Dealer Geofencing spec).
-- Defaults to 200m; a manager may override per dealer from the web admin UI.
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS radius_meters INTEGER NOT NULL DEFAULT 200;

-- ============================================================
-- 3. attendance
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id                      SERIAL PRIMARY KEY,
  employee_id             INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  business_date           DATE,
  login_time              TIMESTAMPTZ,
  login_lat               DOUBLE PRECISION,
  login_lng               DOUBLE PRECISION,
  logout_time             TIMESTAMPTZ,
  logout_lat              DOUBLE PRECISION,
  logout_lng              DOUBLE PRECISION,
  total_distance_km       DOUBLE PRECISION DEFAULT 0,
  total_duration_minutes  INTEGER,
  sync_status             VARCHAR(20)   NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending')),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Renames for pre-existing databases that still have the old check-in/
-- check-out column names (fresh databases already get the new names from
-- the CREATE TABLE above, so these are no-ops there).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_in_time')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'login_time') THEN
    ALTER TABLE attendance RENAME COLUMN check_in_time TO login_time;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_in_lat')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'login_lat') THEN
    ALTER TABLE attendance RENAME COLUMN check_in_lat TO login_lat;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_in_lng')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'login_lng') THEN
    ALTER TABLE attendance RENAME COLUMN check_in_lng TO login_lng;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_time')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'logout_time') THEN
    ALTER TABLE attendance RENAME COLUMN check_out_time TO logout_time;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_lat')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'logout_lat') THEN
    ALTER TABLE attendance RENAME COLUMN check_out_lat TO logout_lat;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'check_out_lng')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance' AND column_name = 'logout_lng') THEN
    ALTER TABLE attendance RENAME COLUMN check_out_lng TO logout_lng;
  END IF;
END $$;

-- business_date is populated by the app at login (see attendance.routes.js)
-- using the same DAY_BOUNDARY_HOUR-aware expression as businessDay.js. It backs
-- a unique constraint that makes "already logged in today" an atomic DB
-- guarantee (via INSERT ... ON CONFLICT) instead of a check-then-insert race
-- between the SELECT guard and the INSERT, which could otherwise let two
-- concurrent login requests (double-tap, retry-on-timeout) both succeed.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS business_date DATE;
UPDATE attendance SET business_date = DATE((login_time) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '5 hours')
  WHERE business_date IS NULL AND login_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance (employee_id);
ALTER INDEX IF EXISTS idx_attendance_check_in_time RENAME TO idx_attendance_login_time;
CREATE INDEX IF NOT EXISTS idx_attendance_login_time ON attendance (login_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_employee_business_date
  ON attendance (employee_id, business_date) WHERE business_date IS NOT NULL;

-- ============================================================
-- 4. client_visits
-- ============================================================
CREATE TABLE IF NOT EXISTS client_visits (
  id                          SERIAL PRIMARY KEY,
  attendance_id               INTEGER       NOT NULL REFERENCES attendance (id) ON DELETE CASCADE,
  dealer_id                   INTEGER       NOT NULL REFERENCES dealers (id),
  login_time                  TIMESTAMPTZ,
  login_lat                   DOUBLE PRECISION,
  login_lng                   DOUBLE PRECISION,
  logout_time                 TIMESTAMPTZ,
  logout_lat                  DOUBLE PRECISION,
  logout_lng                  DOUBLE PRECISION,
  visit_duration_minutes      INTEGER,
  distance_from_previous_km   DOUBLE PRECISION DEFAULT 0,
  out_of_radius               BOOLEAN       NOT NULL DEFAULT FALSE,
  login_justification_note    TEXT,
  sync_status                 VARCHAR(20)   NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending')),
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_time')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_time') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_time TO login_time;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_lat')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_lat') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_lat TO login_lat;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_lng')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_lng') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_lng TO login_lng;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_time')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_time') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_time TO logout_time;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_lat')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_lat') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_lat TO logout_lat;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_lng')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_lng') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_lng TO logout_lng;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'justification_note')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_justification_note') THEN
    ALTER TABLE client_visits RENAME COLUMN justification_note TO login_justification_note;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_visits_attendance_id ON client_visits (attendance_id);
CREATE INDEX IF NOT EXISTS idx_visits_dealer_id     ON client_visits (dealer_id);
CREATE INDEX IF NOT EXISTS idx_visits_created_at    ON client_visits (created_at);
ALTER INDEX IF EXISTS idx_visits_check_in_time RENAME TO idx_visits_login_time;
CREATE INDEX IF NOT EXISTS idx_visits_login_time ON client_visits (login_time);

-- Dealer Geofencing & GPS Validation spec — per-event accuracy/distance capture,
-- login radius flag (logout already had out_of_radius), the login vs
-- logout tolerance-match flag, and a separate logout justification (the
-- login_justification_note column holds the login reason).
-- These renames MUST run before the ADD COLUMN IF NOT EXISTS block below —
-- otherwise ADD COLUMN creates the new column empty first, the rename's
-- NOT EXISTS guard then finds it already there and skips, and any real data
-- in the old column is silently orphaned instead of carried over.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_accuracy_m')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_accuracy_m') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_accuracy_m TO login_accuracy_m;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_accuracy_m')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_accuracy_m') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_accuracy_m TO logout_accuracy_m;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_distance_m')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_distance_m') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_distance_m TO login_distance_m;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_distance_m')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_distance_m') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_distance_m TO logout_distance_m;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_in_inside_radius')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'login_inside_radius') THEN
    ALTER TABLE client_visits RENAME COLUMN check_in_inside_radius TO login_inside_radius;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'matched_check_in')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'matched_login') THEN
    ALTER TABLE client_visits RENAME COLUMN matched_check_in TO matched_login;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'check_out_justification_note')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_visits' AND column_name = 'logout_justification_note') THEN
    ALTER TABLE client_visits RENAME COLUMN check_out_justification_note TO logout_justification_note;
  END IF;
END $$;

ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS login_accuracy_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS logout_accuracy_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS login_distance_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS logout_distance_m DOUBLE PRECISION;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS login_inside_radius BOOLEAN;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS matched_login BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS logout_justification_note TEXT;

-- Periodic in-visit location verification (Random Location Verification spec):
-- while a visit is open, the app re-samples GPS every few minutes. If the rep
-- is found outside the dealer's radius for longer than a grace period, the
-- visit is flagged interrupted — a distinct signal from out_of_radius (which
-- only describes the login/logout moments) that a manager can review.
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS interrupted_distance_m DOUBLE PRECISION;

-- Live radius status (dashboard "Inside Radius"/"Outside Radius" indicator) +
-- a cumulative (non-resetting) count of periodic checks found outside the
-- radius during this visit — distinct from the consecutive-only check that
-- drives `interrupted` above. Reaching 2 total breaches (even with the rep
-- back inside in between) trips `log_out_alert_sent`, which both the rep's
-- device and the manager's dashboard alert off of, once per visit.
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS last_location_status VARCHAR(10);
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS last_location_check_at TIMESTAMPTZ;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS outside_radius_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS log_out_alert_sent BOOLEAN NOT NULL DEFAULT FALSE;

-- Distance (meters) from the dealer at the most recent periodic location
-- check — distinct from login_distance_m, which only reflects the
-- one-time login moment. Lets the dashboard show a live "distance from
-- dealer" figure for an open visit instead of a stale login-time value.
ALTER TABLE client_visits ADD COLUMN IF NOT EXISTS last_location_distance_m DOUBLE PRECISION;

-- ============================================================
-- 5. exception_log
-- ============================================================
-- Every login/logout performed outside the dealer's approved radius,
-- with the mandatory justification the rep entered, for manager review.
-- 'interrupted' events (added for Random Location Verification) have no
-- rep-entered reason — they're system-detected, not self-reported.
CREATE TABLE IF NOT EXISTS exception_log (
  id                SERIAL PRIMARY KEY,
  employee_id       INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  dealer_id         INTEGER       NOT NULL REFERENCES dealers (id),
  visit_id          INTEGER       REFERENCES client_visits (id) ON DELETE CASCADE,
  event_type        VARCHAR(12)   NOT NULL CHECK (event_type IN ('login', 'logout', 'interrupted')),
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  distance_meters   DOUBLE PRECISION,
  gps_accuracy_m    DOUBLE PRECISION,
  reason            TEXT,
  matched_login     BOOLEAN       NOT NULL DEFAULT FALSE,
  manager_reviewed  BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- event_type predates 'interrupted' (11 chars, exceeds the original
-- VARCHAR(10)) on databases created before this migration — widen the column
-- and its CHECK constraint so re-running migrate.js on an existing DB doesn't
-- leave either one rejecting the new event type. Also relabels the stored
-- 'check-in'/'check-out' values (and the matched_check_in column) to
-- 'login'/'logout' for pre-existing rows.
ALTER TABLE exception_log ALTER COLUMN event_type TYPE VARCHAR(12);
ALTER TABLE exception_log DROP CONSTRAINT IF EXISTS exception_log_event_type_check;
UPDATE exception_log SET event_type = 'login' WHERE event_type = 'check-in';
UPDATE exception_log SET event_type = 'logout' WHERE event_type = 'check-out';
ALTER TABLE exception_log ADD CONSTRAINT exception_log_event_type_check
  CHECK (event_type IN ('login', 'logout', 'interrupted'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exception_log' AND column_name = 'matched_check_in')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exception_log' AND column_name = 'matched_login') THEN
    ALTER TABLE exception_log RENAME COLUMN matched_check_in TO matched_login;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_exception_log_employee    ON exception_log (employee_id);
CREATE INDEX IF NOT EXISTS idx_exception_log_created_at  ON exception_log (created_at);

-- ============================================================
-- 6. notes
-- ============================================================
-- Free-form notepad entries a rep (or manager) keeps for themselves —
-- e.g. reminders about a dealer, follow-ups. A 100-character minimum is
-- enforced at the DB level (not just in the app) so the requirement holds
-- regardless of which client writes to this table.
CREATE TABLE IF NOT EXISTS notes (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  content       TEXT          NOT NULL CHECK (char_length(TRIM(content)) >= 100),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_employee_id ON notes (employee_id);
CREATE INDEX IF NOT EXISTS idx_notes_created_at  ON notes (created_at);

-- ============================================================
-- 7. reminders
-- ============================================================
-- A rep's reminder to follow up with a dealer on a given date. The mobile
-- app schedules two local device notifications (day-before and day-of) at
-- creation time; notif_id_day_before/notif_id_day_of store the identifiers
-- so the app can cancel them if the reminder is deleted.
CREATE TABLE IF NOT EXISTS reminders (
  id                    SERIAL PRIMARY KEY,
  employee_id           INTEGER     NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  dealer_id             INTEGER     NOT NULL REFERENCES dealers (id),
  reminder_date         DATE        NOT NULL,
  note                  TEXT        NOT NULL CHECK (char_length(TRIM(note)) >= 20),
  notif_id_day_before   TEXT,
  notif_id_day_of       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_employee_id   ON reminders (employee_id);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_date ON reminders (reminder_date);

-- ============================================================
-- 8. idempotency_keys
-- ============================================================
-- Lets a retried mutating request (see mobile api.js's cold-start retry)
-- replay the original response instead of repeating the write. The key is
-- client-generated and stable across retries of one logical request; see
-- backend/src/utils/idempotency.js.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key              VARCHAR(100)  PRIMARY KEY,
  employee_id      INTEGER       REFERENCES employees (id) ON DELETE CASCADE,
  endpoint         VARCHAR(100)  NOT NULL,
  response_status  INTEGER       NOT NULL,
  response_body    JSONB         NOT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 9. visit_radius_events
-- ============================================================
-- One row per continuous excursion outside a dealer's radius during an open
-- visit — distinct from (and additive alongside) client_visits' existing
-- outside_radius_count/log_out_alert_sent/interrupted* columns, which stay
-- untouched for backward compatibility. This table drives the new staged
-- 10/20/30-minute manager+rep alert sequence and is the literal "history"
-- (time left, time returned, alert count, max distance) for that sequence.
CREATE TABLE IF NOT EXISTS visit_radius_events (
  id            SERIAL PRIMARY KEY,
  visit_id      INTEGER       NOT NULL REFERENCES client_visits (id) ON DELETE CASCADE,
  employee_id   INTEGER       NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  dealer_id     INTEGER       NOT NULL REFERENCES dealers (id),
  left_at       TIMESTAMPTZ   NOT NULL,
  returned_at   TIMESTAMPTZ,
  alert_count   INTEGER       NOT NULL DEFAULT 0,
  max_distance_m DOUBLE PRECISION,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visit_radius_events_visit_id ON visit_radius_events (visit_id);
-- UNIQUE (not just an index): a visit has at most one open excursion at a
-- time. visitMonitor.js's foreground poll and geofenceTask.js's background
-- geofence event both call location-check independently and can land within
-- moments of each other — without this, two concurrent requests could each
-- see "no open excursion" and both INSERT one, double-tracking the same
-- excursion. The route below catches the resulting unique-violation and
-- treats it as having lost the race, rather than erroring.
CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_radius_events_open ON visit_radius_events (visit_id) WHERE returned_at IS NULL;

-- ============================================================
-- 10. manager_notifications
-- ============================================================
-- In-app alert feed for the manager dashboard's notification bell — not OS
-- push (no push infrastructure exists in this app). Read-state is shared
-- across all managers rather than per-manager-account (documented
-- simplification, not a bug — revisit if per-manager tracking is needed).
CREATE TABLE IF NOT EXISTS manager_notifications (
  id            SERIAL PRIMARY KEY,
  type          VARCHAR(40)   NOT NULL,
  title         VARCHAR(150)  NOT NULL,
  body          TEXT          NOT NULL,
  severity      VARCHAR(20)   NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'danger')),
  employee_id   INTEGER       REFERENCES employees (id) ON DELETE CASCADE,
  dealer_id     INTEGER       REFERENCES dealers (id),
  visit_id      INTEGER       REFERENCES client_visits (id) ON DELETE CASCADE,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manager_notifications_created_at ON manager_notifications (created_at);
CREATE INDEX IF NOT EXISTS idx_manager_notifications_unread ON manager_notifications (read_at) WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);

-- ============================================================
-- Dealer deletion — cascade instead of block
-- ============================================================
-- Deleting a dealer now permanently removes its visit history, exception
-- records, radius-event history, notifications, and reminders too (an
-- explicit, requested change — deleting a dealer used to be blocked
-- outright whenever it had recorded visits; see dealers.routes.js). Re-adds
-- each dealer_id foreign key with ON DELETE CASCADE, replacing whichever
-- (unnamed, default-RESTRICT) constraint Postgres auto-created originally.
-- Idempotent: a table already carrying a cascading FK to dealers is skipped.
DO $$
DECLARE
  tbl TEXT;
  existing_con TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['client_visits', 'exception_log', 'visit_radius_events', 'manager_notifications', 'reminders']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = tbl::regclass AND confrelid = 'dealers'::regclass AND contype = 'f' AND confdeltype = 'c'
    ) THEN
      SELECT conname INTO existing_con FROM pg_constraint
      WHERE conrelid = tbl::regclass AND confrelid = 'dealers'::regclass AND contype = 'f' LIMIT 1;
      IF existing_con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, existing_con);
      END IF;
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (dealer_id) REFERENCES dealers(id) ON DELETE CASCADE', tbl, tbl || '_dealer_id_fkey');
    END IF;
  END LOOP;
END $$;
