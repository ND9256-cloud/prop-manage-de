-- Pipeline monitoring: dead-letter overview, stuck-job recovery, pg_cron schedule

-- 1. Dead-letter overview view
CREATE OR REPLACE VIEW warehouse.dead_letter_overview AS
SELECT
    j.id            AS job_id,
    j.document_id,
    d.file_name,
    j.org_id,
    j.last_stage,
    j.error_message,
    j.error_detail,
    j.attempt_count,
    j.updated_at
FROM warehouse.processing_jobs j
JOIN warehouse.documents d ON d.id = j.document_id
WHERE j.status = 'dead_letter'
ORDER BY j.updated_at DESC;

-- 2. Recover stuck jobs function
CREATE OR REPLACE FUNCTION warehouse.recover_stuck_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    recovered INTEGER;
BEGIN
    UPDATE warehouse.processing_jobs
    SET status = 'queued',
        updated_at = now()
    WHERE status = 'processing'
      AND updated_at < now() - INTERVAL '10 minutes';

    GET DIAGNOSTICS recovered = ROW_COUNT;
    RAISE LOG 'recover_stuck_jobs: reset % jobs', recovered;
    RETURN recovered;
END;
$$;

-- 3. Schedule recovery every 5 minutes via pg_cron
SELECT cron.schedule(
  'recover-stuck-jobs',
  '*/5 * * * *',
  $$ SELECT warehouse.recover_stuck_jobs(); $$
);
