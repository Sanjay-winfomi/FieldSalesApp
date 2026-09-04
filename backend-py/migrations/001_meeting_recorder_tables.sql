-- 001_meeting_recorder_tables.sql
--
-- Creates the tables app/routers/meeting_recorder.py needs, in THIS app's
-- own database (the same one DB_HOST/DB_NAME/etc. in app/core/config.py
-- already point at) — replacing the separate AWS RDS "transcript" database
-- the standalone meeting-recorder-app-backend service used to use.
--
-- Schema copied EXACTLY (columns, types, indexes, the search trigger) from
-- that live "transcript" database via information_schema/pg_catalog
-- introspection, not reconstructed from reading the application code — so
-- it's a faithful copy, including a few columns
-- (attendees, ai_insights_*, project_requirements_*, status) that this
-- app's own ported code never reads or writes. Those appear to belong to a
-- separate AI-agent integration (see AGENT_SERVER_URL / the /agent proxy
-- routes in meeting_recorder.py) that may write to this same table
-- independently — kept for safety since dropping them here would silently
-- break that integration if it depends on them.
--
-- Run this once against the target database before switching
-- DATABASE_URL/DB_HOST away from the old "transcript" AWS RDS instance —
-- existing rows there are NOT copied by this script (structure only).

CREATE TABLE IF NOT EXISTS call_recording (
    id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_name                   text,
    transcript_file_id               text,
    folder_id                        text,
    owner_id                         text,
    attendees                        text,
    created_at                       timestamp DEFAULT now(),
    audio_file_id                    text,
    ai_insights_status               varchar,
    ai_insights_error                text,
    ai_insights_result               jsonb,
    ai_insights_updated_at           timestamptz,
    duration                         text,
    session_id                       text,
    project_requirements_status      varchar,
    project_requirements_error       text,
    project_requirements_result      jsonb,
    project_requirements_updated_at  timestamptz,
    processing_status                text,
    location                         text,
    status                           text,
    ui_folder_id                     varchar,
    transcript_segments              jsonb,
    transcript_text                  text,
    translation_cost                 numeric,
    summary                          text,
    summary_status                   varchar,
    search_vector                    tsvector
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_session_id ON call_recording USING btree (session_id);
CREATE INDEX IF NOT EXISTS search_vector_idx ON call_recording USING gin (search_vector);

-- Keeps search_vector current for the full-text search used by
-- GET /get-recording-data's search_query path (ts_rank/ts_headline).
-- Title (recording_name) weighted higher than the transcript body.
CREATE OR REPLACE FUNCTION update_call_recording_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.recording_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.transcript_text, '')), 'B');
  return new;
END
$function$;

DROP TRIGGER IF EXISTS tsvector_update_trigger ON call_recording;
CREATE TRIGGER tsvector_update_trigger
    BEFORE INSERT OR UPDATE ON call_recording
    FOR EACH ROW EXECUTE FUNCTION update_call_recording_search_vector();


CREATE TABLE IF NOT EXISTS app_folders (
    id         varchar PRIMARY KEY,
    name       varchar NOT NULL,
    owner_id   varchar NOT NULL,
    created_at bigint
);


CREATE TABLE IF NOT EXISTS pending_transcriptions (
    job_id                  text PRIMARY KEY,
    session_id              text NOT NULL,
    title                   text,
    owner_email             text,
    device_os               text,
    merged_filename         text,
    recording_names         jsonb,
    folder_id               text,
    audio_file_id           text,
    latitude                double precision,
    longitude               double precision,
    final_duration_seconds  double precision,
    created_at              timestamptz DEFAULT now()
);
