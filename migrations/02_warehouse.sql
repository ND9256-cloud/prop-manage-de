-- ============================================================
-- SCHEMA: warehouse
-- Purpose: Document intake, extraction, staging, review
-- BOUNDARY: This schema NEVER references pm.* tables directly
-- ============================================================

CREATE SCHEMA IF NOT EXISTS warehouse;

-- ------------------------------------------------------------
-- Documents
-- One row per ingested file, regardless of source
-- ------------------------------------------------------------
CREATE TABLE warehouse.documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  uploader_id     UUID REFERENCES shared.users(id),  -- NULL = system (email/telegram)

  -- File identity
  storage_path    TEXT NOT NULL UNIQUE,    -- Supabase storage path (generated, never user-controlled)
  file_name       TEXT NOT NULL,           -- original filename for display only
  file_hash       TEXT NOT NULL,           -- SHA-256 of file content (idempotency)
  file_size_bytes BIGINT NOT NULL,
  mime_type       TEXT NOT NULL,

  -- Source tracking
  source          TEXT NOT NULL
                  CHECK (source IN ('email', 'telegram', 'ui', 'api')),
  source_ref      TEXT,                    -- email Message-ID | telegram file_id | null

  -- Classification (set by AI)
  doc_type        TEXT
                  CHECK (doc_type IN (
                    'lease', 'invoice', 'inspection_report',
                    'floor_plan', 'photo', 'financial_report',
                    'utility_bill', 'other', 'unknown'
                  )),
  language        TEXT CHECK (language IN ('de', 'en', 'mixed', 'unknown')),

  -- Pipeline status (state machine)
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN (
                    'queued',           -- received, not yet processed
                    'processing',       -- OCR/extraction in progress
                    'needs_review',     -- low confidence, human needed
                    'ready_to_apply',   -- high confidence, staged
                    'applied',          -- written to PM tables via connector
                    'failed',           -- processing error
                    'quarantined',      -- security/type/size rejection
                    'duplicate'         -- same hash already exists
                  )),

  -- OCR
  ocr_text        TEXT,                   -- raw extracted text (for embeddings later)
  ocr_confidence  NUMERIC(5,2),           -- 0.00–100.00
  ocr_engine      TEXT,                   -- 'tesseract' | 'textract'

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,

  -- Idempotency: same org + same file hash = duplicate
  UNIQUE (org_id, file_hash)
);

-- ------------------------------------------------------------
-- Document extractions (staging — AI output, versioned)
-- Each extraction attempt creates a new row (never overwrite)
-- ------------------------------------------------------------
CREATE TABLE warehouse.document_extractions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID NOT NULL REFERENCES warehouse.documents(id),
  org_id            UUID NOT NULL REFERENCES shared.organisations(id),

  -- Model metadata
  model             TEXT NOT NULL,         -- e.g. 'claude-haiku-4-5'
  prompt_version    TEXT NOT NULL,         -- e.g. 'v1.2' (for rerun tracking)
  extraction_ms     INTEGER,               -- processing time

  -- Extracted fields (schema varies by doc_type, stored as JSONB)
  -- Lease:    { tenant_name, unit_ref, address, rent_cold, rent_warm, 
  --             lease_start, lease_end, deposit, ... }
  -- Invoice:  { vendor_name, amount, currency, date, invoice_number,
  --             description, category_hint, ... }
  -- Inspection: { unit_ref, address, condition, meter_readings, damages, ... }
  extracted_fields  JSONB NOT NULL,

  -- Confidence
  confidence_score  NUMERIC(5,2) NOT NULL, -- 0.00–100.00 overall
  field_confidence  JSONB,                 -- per-field confidence scores
  flags             JSONB,                 -- e.g. ["missing_unit_ref", "amount_suspicious"]

  -- Translation (derived artifact — Phase 1 optional, Phase 2 standard)
  translated_summary TEXT,                 -- EN summary if doc is DE, or vice versa
  translation_lang   TEXT,

  -- Status
  is_current        BOOLEAN NOT NULL DEFAULT true,  -- latest extraction for this doc
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one current extraction per document
CREATE UNIQUE INDEX one_current_extraction 
  ON warehouse.document_extractions (document_id) 
  WHERE is_current = true;

-- ------------------------------------------------------------
-- Suggested matches (staging — connector candidates)
-- AI proposes what PM entities this doc relates to
-- Warehouse reads connector.resolve() output into here
-- ------------------------------------------------------------
CREATE TABLE warehouse.suggested_matches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID NOT NULL REFERENCES warehouse.documents(id),
  extraction_id     UUID NOT NULL REFERENCES warehouse.document_extractions(id),
  org_id            UUID NOT NULL REFERENCES shared.organisations(id),

  -- What the match is for
  entity_type       TEXT NOT NULL
                    CHECK (entity_type IN ('property', 'unit', 'tenant', 'vendor', 'lease')),

  -- Connector resolve() output
  -- For existing: { match_type: 'existing', pm_entity_id: uuid, confidence: 0.92, reason: '...' }
  -- For new:      { match_type: 'new',      suggested_fields: {...}, confidence: 0.85 }
  -- For ambiguous:{ match_type: 'ambiguous', candidates: [...] }
  match_result      JSONB NOT NULL,

  confidence_score  NUMERIC(5,2) NOT NULL,
  match_type        TEXT NOT NULL
                    CHECK (match_type IN ('existing', 'new', 'ambiguous', 'unresolved')),

  -- User override (set during review)
  user_override     JSONB,                 -- user's manual correction
  overridden_by     UUID REFERENCES shared.users(id),
  overridden_at     TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Review tasks ("Needs Attention" queue)
-- Created when confidence < threshold OR match_type = ambiguous/new
-- ------------------------------------------------------------
CREATE TABLE warehouse.review_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES warehouse.documents(id),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  assigned_to     UUID REFERENCES shared.users(id),

  reason          TEXT NOT NULL,           -- human-readable: why needs review
  reason_code     TEXT NOT NULL
                  CHECK (reason_code IN (
                    'low_confidence',
                    'ambiguous_match',
                    'new_asset_detected',
                    'conflict_detected',
                    'missing_required_field',
                    'manual_request'
                  )),

  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),

  resolved_by     UUID REFERENCES shared.users(id),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Apply log (immutable audit — every connector.apply() call)
-- GoBD: records what was written to PM tables, by whom, when
-- This is the ONLY evidence of warehouse → PM writes
-- ------------------------------------------------------------
CREATE TABLE warehouse.apply_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID NOT NULL REFERENCES warehouse.documents(id),
  extraction_id     UUID NOT NULL REFERENCES warehouse.document_extractions(id),
  org_id            UUID NOT NULL REFERENCES shared.organisations(id),

  -- Who triggered the apply
  triggered_by      UUID REFERENCES shared.users(id),  -- NULL = auto-apply
  trigger_type      TEXT NOT NULL
                    CHECK (trigger_type IN ('auto', 'user_confirmed', 'user_override')),

  -- What the connector did
  connector_action  TEXT NOT NULL,         -- e.g. 'lease.create', 'ledger.append'
  pm_entity_type    TEXT NOT NULL,         -- e.g. 'lease', 'ledger_entry'
  pm_entity_id      UUID,                  -- ID returned by PM connector (null if failed)

  -- Connector call details
  request_payload   JSONB NOT NULL,        -- what was sent to connector (no full PII)
  response_payload  JSONB,                 -- what connector returned
  status            TEXT NOT NULL
                    CHECK (status IN ('success', 'failed', 'rolled_back')),
  error_message     TEXT,

  -- Idempotency key (prevents double-apply)
  idempotency_key   TEXT NOT NULL UNIQUE,  -- hash of (document_id + connector_action + key fields)

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Apply log is append-only
CREATE RULE apply_log_no_update AS ON UPDATE TO warehouse.apply_log DO INSTEAD NOTHING;
CREATE RULE apply_log_no_delete AS ON DELETE TO warehouse.apply_log DO INSTEAD NOTHING;

-- ------------------------------------------------------------
-- Document chunks (Phase 2 — RAG/chatbot, placeholder for now)
-- ------------------------------------------------------------
CREATE TABLE warehouse.document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES warehouse.documents(id),
  org_id        UUID NOT NULL REFERENCES shared.organisations(id),
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  -- embedding  vector(1536),             -- uncomment when pgvector enabled (Phase 2)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- RLS — All warehouse tables
-- ------------------------------------------------------------
ALTER TABLE warehouse.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.suggested_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.apply_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.document_chunks ENABLE ROW LEVEL SECURITY;

-- Org isolation on all warehouse tables
DO $$ 
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'warehouse.documents',
    'warehouse.document_extractions', 
    'warehouse.suggested_matches',
    'warehouse.review_tasks',
    'warehouse.apply_log',
    'warehouse.document_chunks'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY org_isolation ON %s USING (org_id = shared.current_org_id())', t
    );
  END LOOP;
END $$;

-- External managers: can only see documents for their assigned properties
-- (property_scope added in Phase 2 once property assignment is built)

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
CREATE INDEX ON warehouse.documents (org_id, status);
CREATE INDEX ON warehouse.documents (org_id, file_hash);
CREATE INDEX ON warehouse.documents (source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX ON warehouse.document_extractions (document_id, is_current);
CREATE INDEX ON warehouse.suggested_matches (document_id, entity_type);
CREATE INDEX ON warehouse.review_tasks (org_id, status);
CREATE INDEX ON warehouse.apply_log (document_id);
CREATE INDEX ON warehouse.apply_log (idempotency_key);
