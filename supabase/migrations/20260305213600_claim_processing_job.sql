-- Safe concurrent job claiming with FOR UPDATE SKIP LOCKED
-- Called by process-document Edge Function via supabase.rpc('claim_next_job')

CREATE OR REPLACE FUNCTION warehouse.claim_next_job()
RETURNS warehouse.processing_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job warehouse.processing_jobs;
BEGIN
  SELECT * INTO v_job
  FROM warehouse.processing_jobs
  WHERE status = 'queued'
    AND next_attempt_at <= now()
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE warehouse.processing_jobs
  SET status = 'processing',
      updated_at = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;
