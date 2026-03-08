-- ============================================================
-- STORAGE: property-documents bucket
-- Private bucket — all access via signed URLs only
-- ============================================================

-- Run in Supabase Dashboard > Storage > New Bucket
-- OR via SQL (Supabase storage schema):

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-documents',
  'property-documents',
  false,                    -- PRIVATE: never public
  52428800,                 -- 50MB max per file
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv'
  ]
);

-- Storage RLS: users can only upload to their org's path
-- Storage path format: {org_id}/{document_id}/{filename}
-- Path is ALWAYS generated server-side — never from user input

CREATE POLICY "authenticated_upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'property-documents'
  AND (storage.foldername(name))[1] = shared.current_org_id()::TEXT
);

CREATE POLICY "authenticated_read_own_org"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'property-documents'
  AND (storage.foldername(name))[1] = shared.current_org_id()::TEXT
);

-- Service role only for delete (no user-triggered deletes)
CREATE POLICY "service_role_delete"
ON storage.objects FOR DELETE
TO service_role
USING (bucket_id = 'property-documents');


-- ============================================================
-- HELPER: pg_trgm for fuzzy address matching
-- Enable for connector.resolve() accuracy improvement
-- Run: SELECT * FROM pg_extension WHERE extname = 'pg_trgm';
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Add trigram index on property address for faster fuzzy matching
CREATE INDEX IF NOT EXISTS idx_properties_address_trgm
  ON pm.properties USING GIN (
    (lower(address_street || ' ' || address_number || ' ' || address_zip)) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS idx_tenants_name_trgm
  ON pm.tenants USING GIN (
    (lower(first_name || ' ' || last_name)) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS idx_units_ref_trgm
  ON pm.units USING GIN (lower(unit_ref) gin_trgm_ops);


-- ============================================================
-- INTAKE: Ingestion job queue
-- Simple state machine for async processing
-- ============================================================
CREATE TABLE warehouse.processing_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID NOT NULL REFERENCES warehouse.documents(id),
  org_id            UUID NOT NULL REFERENCES shared.organisations(id),

  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'done', 'failed', 'dead_letter')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What stage failed (for partial retry)
  last_stage        TEXT CHECK (last_stage IN ('ocr', 'extraction', 'matching', 'apply')),
  error_message     TEXT,
  error_detail      JSONB,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE warehouse.processing_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON warehouse.processing_jobs
  USING (org_id = shared.current_org_id());

CREATE INDEX ON warehouse.processing_jobs (status, next_attempt_at)
  WHERE status IN ('queued', 'failed');

-- Retry with exponential backoff (called by Edge Function on failure)
CREATE OR REPLACE FUNCTION warehouse.schedule_retry(
  p_job_id UUID,
  p_error  TEXT,
  p_stage  TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_job warehouse.processing_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM warehouse.processing_jobs WHERE id = p_job_id;

  IF v_job.attempt_count >= v_job.max_attempts THEN
    UPDATE warehouse.processing_jobs
    SET status = 'dead_letter',
        error_message = p_error,
        last_stage = p_stage,
        updated_at = now()
    WHERE id = p_job_id;

    -- Also mark the document as failed
    UPDATE warehouse.documents
    SET status = 'failed', updated_at = now()
    WHERE id = v_job.document_id;
  ELSE
    UPDATE warehouse.processing_jobs
    SET status = 'queued',
        attempt_count = attempt_count + 1,
        -- Exponential backoff: 1min, 5min, 25min
        next_attempt_at = now() + (INTERVAL '1 minute' * POWER(5, attempt_count)),
        error_message = p_error,
        last_stage = p_stage,
        updated_at = now()
    WHERE id = p_job_id;
  END IF;
END;
$$;


-- ============================================================
-- SUMMARY: Boundary enforcement
-- This comment is the contract — enforce it in code review
-- ============================================================

-- ✅ warehouse.* CAN:
--    • Read/write warehouse.documents
--    • Read/write warehouse.document_extractions
--    • Read/write warehouse.suggested_matches
--    • Read/write warehouse.review_tasks
--    • Read/write warehouse.apply_log
--    • Read/write warehouse.processing_jobs
--    • Read/write warehouse.document_chunks
--    • Call connector.resolve()  ← read-only view of pm.*
--    • Call connector.apply()    ← only write path to pm.*

-- ❌ warehouse.* CANNOT:
--    • SELECT from pm.*  (directly)
--    • INSERT/UPDATE/DELETE pm.*  (directly)
--    • Reference pm.* tables in foreign keys
--    • Bypass connector.apply() for pm writes

-- ✅ connector.* CAN:
--    • Read pm.* (for resolve)
--    • Write pm.* (for apply)
--    • Write warehouse.apply_log
--    • Write shared.audit_log

-- ✅ pm.* CAN:
--    • Be read/written by connector.*
--    • Be read directly by the PM tool frontend (via RLS)

-- ❌ pm.* CANNOT:
--    • Be written by warehouse.* directly
--    • Be written by frontend directly (only connector.apply())
