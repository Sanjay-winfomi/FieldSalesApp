-- 002_call_recording_visit_link.sql
--
-- Links a recording to the dealer visit it was made during, so the web
-- dashboard's Recordings tab can group recordings by dealer (and, via the
-- existing owner_id, by representative). Populated by
-- meeting_recorder.py's /start-processing, which resolves the rep's
-- currently-open client_visits row (if any) at the moment the recording is
-- saved — see _resolve_open_visit() there. Both columns stay NULL for a
-- recording made with no open visit (e.g. not currently checked in at a
-- dealer); such recordings show under the rep but not under any dealer.

ALTER TABLE call_recording ADD COLUMN IF NOT EXISTS dealer_id INTEGER REFERENCES dealers(id) ON DELETE SET NULL;
ALTER TABLE call_recording ADD COLUMN IF NOT EXISTS visit_id INTEGER REFERENCES client_visits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_recording_dealer_id_idx ON call_recording (dealer_id);
CREATE INDEX IF NOT EXISTS call_recording_owner_id_idx ON call_recording (owner_id);
