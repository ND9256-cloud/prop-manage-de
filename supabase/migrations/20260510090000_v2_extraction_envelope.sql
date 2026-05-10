-- Migration: v2 extraction envelope table
-- Task 0.5: document_extractions_v2
-- Architecture refs: §3.1 (field-level envelope), §3.3 (document-level envelope), §3.4 (lifecycle sub-envelope)

-- =============================================================================
-- Table: warehouse.document_extractions_v2
-- =============================================================================

CREATE TABLE IF NOT EXISTS warehouse.document_extractions_v2 (
  -- Identity
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  source_document_id        uuid NOT NULL REFERENCES warehouse.documents(id),
  doc_type                  text NOT NULL,

  -- Versioning (per §3.3)
  schema_version            text NOT NULL,
  prompt_version            text NOT NULL,
  model                     text NOT NULL,
  extraction_run_id         uuid NOT NULL,

  -- The envelope payload (per §3.1)
  -- Map of field_name -> field_envelope. Each field_envelope has:
  --   raw_value, normalized_value, evidence, confidence, absence_state,
  --   validation_status, severity
  fields                    jsonb NOT NULL DEFAULT '{}',

  -- Lifecycle sub-envelope (per §3.4)
  -- { issue_date, effective_date, signed_date, expiry_date, document_status,
  --   supersedes_document_id, amended_by_document_id, lifecycle_evidence }
  lifecycle                 jsonb NOT NULL DEFAULT '{}',

  -- Human review (per §3.3)
  human_review_status       text NOT NULL DEFAULT 'not_reviewed'
    CHECK (human_review_status IN ('not_reviewed', 'accepted', 'corrected', 'rejected')),

  -- Audit
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- "Get the latest extraction for this document" — most common resolver query
CREATE INDEX idx_doc_extractions_v2_source_latest
  ON warehouse.document_extractions_v2 (source_document_id, created_at DESC);

-- Lookup by extraction_run_id (replay scenarios)
CREATE INDEX idx_doc_extractions_v2_run_id
  ON warehouse.document_extractions_v2 (extraction_run_id);

-- Lookup by schema_version (re-emission candidate queries when schema changes)
CREATE INDEX idx_doc_extractions_v2_schema_version
  ON warehouse.document_extractions_v2 (schema_version);

-- Lookup by doc_type (statistics, eval slicing)
CREATE INDEX idx_doc_extractions_v2_doc_type
  ON warehouse.document_extractions_v2 (doc_type);

-- Lookup by review status (operator dashboard "needs review")
CREATE INDEX idx_doc_extractions_v2_review_status
  ON warehouse.document_extractions_v2 (human_review_status)
  WHERE human_review_status != 'not_reviewed';

-- =============================================================================
-- Immutability + GoBD triggers
-- =============================================================================

-- Block UPDATE except on human_review_status
CREATE OR REPLACE FUNCTION warehouse.doc_extractions_v2_block_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.id IS DISTINCT FROM OLD.id) OR
     (NEW.source_document_id IS DISTINCT FROM OLD.source_document_id) OR
     (NEW.doc_type IS DISTINCT FROM OLD.doc_type) OR
     (NEW.schema_version IS DISTINCT FROM OLD.schema_version) OR
     (NEW.prompt_version IS DISTINCT FROM OLD.prompt_version) OR
     (NEW.model IS DISTINCT FROM OLD.model) OR
     (NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id) OR
     (NEW.fields IS DISTINCT FROM OLD.fields) OR
     (NEW.lifecycle IS DISTINCT FROM OLD.lifecycle) OR
     (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'warehouse.document_extractions_v2 is append-only; only human_review_status may be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_extractions_v2_block_update_trigger
  BEFORE UPDATE ON warehouse.document_extractions_v2
  FOR EACH ROW EXECUTE FUNCTION warehouse.doc_extractions_v2_block_update();

-- Block DELETE entirely (GoBD)
CREATE OR REPLACE FUNCTION warehouse.doc_extractions_v2_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.document_extractions_v2 is append-only; DELETE not permitted (GoBD compliance)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_extractions_v2_block_delete_trigger
  BEFORE DELETE ON warehouse.document_extractions_v2
  FOR EACH ROW EXECUTE FUNCTION warehouse.doc_extractions_v2_block_delete();

-- =============================================================================
-- RLS Policies (tenant isolation via org_id on source_document_id → documents → Property)
-- =============================================================================

ALTER TABLE warehouse.document_extractions_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY doc_extractions_v2_org_isolation ON warehouse.document_extractions_v2
  USING (source_document_id IN (
    SELECT id FROM warehouse.documents WHERE property_id IN (
      SELECT id FROM "Property" WHERE "organizationId" = shared.current_org_id()
    )
  ));
