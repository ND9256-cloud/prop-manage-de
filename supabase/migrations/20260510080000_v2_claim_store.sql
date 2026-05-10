-- Migration: v2 claim store tables
-- Task 0.4: claims, claim_closures, derivation_records
-- Architecture refs: §4.2, §4.3, §4.6, §4.7, §5.5.3, §5.5.7

-- =============================================================================
-- Table 1: warehouse.claims
-- =============================================================================

CREATE TABLE IF NOT EXISTS warehouse.claims (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL REFERENCES "Property"(id),
  subject                   text NOT NULL,
  predicate                 text NOT NULL,
  value                     jsonb NOT NULL,
  claim_kind                text NOT NULL CHECK (claim_kind IN ('assertion', 'snapshot', 'event', 'reference')),
  source_type               text NOT NULL CHECK (source_type IN ('document_extraction', 'human_adjudication', 'system_derivation')),
  valid_from                date NOT NULL,
  valid_to                  date,
  source_document_id        uuid,
  source_extraction_run_id  uuid,
  source_field_path         text,
  human_actor_id            uuid,
  confidence                text CHECK (confidence IN ('high', 'medium', 'low') OR confidence IS NULL),
  evidence_id               uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  superseded_at             timestamptz,
  superseded_by_claim_id    uuid REFERENCES warehouse.claims(id),

  -- Architecture §4.7: source_type → field constraints
  CONSTRAINT human_adjudication_has_actor
    CHECK (source_type != 'human_adjudication' OR human_actor_id IS NOT NULL),
  CONSTRAINT document_extraction_has_extraction_run
    CHECK (source_type != 'document_extraction' OR source_extraction_run_id IS NOT NULL),

  -- valid_to must be >= valid_from when set (no negative-duration claims)
  CONSTRAINT valid_interval_sane
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- =============================================================================
-- Table 2: warehouse.claim_closures
-- =============================================================================

CREATE TABLE IF NOT EXISTS warehouse.claim_closures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_claim_id     uuid NOT NULL REFERENCES warehouse.claims(id),
  reason_claim_id     uuid NOT NULL REFERENCES warehouse.claims(id),
  close_mode          text NOT NULL CHECK (close_mode IN (
                        'close_overlapping_only',
                        'close_overlapping_and_future',
                        'close_overlapping_and_supersede_future'
                      )),
  applied_valid_to    date NOT NULL,
  applier_version     text NOT NULL,
  applied_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_self_closure CHECK (target_claim_id != reason_claim_id)
);

-- =============================================================================
-- Table 3: warehouse.derivation_records
-- =============================================================================

CREATE TABLE IF NOT EXISTS warehouse.derivation_records (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                 uuid NOT NULL REFERENCES "Property"(id),
  output_type                 text NOT NULL CHECK (output_type IN (
                                'claim', 'closure', 'resolved_fact',
                                'property_snapshot', 'derived_claim'
                              )),
  output_id                   uuid NOT NULL,
  input_claim_ids             uuid[] NOT NULL DEFAULT '{}',
  input_extraction_run_ids    uuid[] NOT NULL DEFAULT '{}',
  rule_refs                   text[] NOT NULL DEFAULT '{}',
  emitter_version             text,
  resolver_version            text,
  composer_version            text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Resolver query: "find claims for (property, subject, predicate) ordered by valid_from"
CREATE INDEX idx_claims_pspf
  ON warehouse.claims (property_id, subject, predicate, valid_from);

-- §5.5.7 partial index: "find currently-active claims" (most common applier query)
CREATE INDEX idx_claims_open
  ON warehouse.claims (property_id, subject, predicate)
  WHERE valid_to IS NULL;

-- Lookup by source document (for "all claims from this extraction")
CREATE INDEX idx_claims_source_document
  ON warehouse.claims (source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Closures by target (audit trail "what closed this claim?")
CREATE INDEX idx_closures_target
  ON warehouse.claim_closures (target_claim_id);

-- Derivation records: GIN index on input_claim_ids per §4.6
CREATE INDEX idx_derivation_input_claims
  ON warehouse.derivation_records USING GIN (input_claim_ids);

-- Derivation records: lookup by output (for "what derived this claim?")
CREATE INDEX idx_derivation_output
  ON warehouse.derivation_records (output_type, output_id);

-- Tenant scope index for derivation_records
CREATE INDEX idx_derivation_property
  ON warehouse.derivation_records (property_id);

-- =============================================================================
-- Immutability + GoBD triggers
-- =============================================================================

-- Block UPDATE on claims, EXCEPT on the supersession columns
CREATE OR REPLACE FUNCTION warehouse.claims_block_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow only updates that set valid_to / superseded_at / superseded_by_claim_id
  -- when transitioning from NULL to non-NULL (one-way supersession).
  IF (NEW.id IS DISTINCT FROM OLD.id) OR
     (NEW.property_id IS DISTINCT FROM OLD.property_id) OR
     (NEW.subject IS DISTINCT FROM OLD.subject) OR
     (NEW.predicate IS DISTINCT FROM OLD.predicate) OR
     (NEW.value IS DISTINCT FROM OLD.value) OR
     (NEW.claim_kind IS DISTINCT FROM OLD.claim_kind) OR
     (NEW.source_type IS DISTINCT FROM OLD.source_type) OR
     (NEW.valid_from IS DISTINCT FROM OLD.valid_from) OR
     (NEW.source_document_id IS DISTINCT FROM OLD.source_document_id) OR
     (NEW.source_extraction_run_id IS DISTINCT FROM OLD.source_extraction_run_id) OR
     (NEW.source_field_path IS DISTINCT FROM OLD.source_field_path) OR
     (NEW.human_actor_id IS DISTINCT FROM OLD.human_actor_id) OR
     (NEW.confidence IS DISTINCT FROM OLD.confidence) OR
     (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) OR
     (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'warehouse.claims is append-only; only valid_to, superseded_at, and superseded_by_claim_id may be updated (and only from NULL to non-NULL)';
  END IF;

  -- Supersession columns are one-way: NULL → value, never value → NULL or value → other-value
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'warehouse.claims.valid_to is immutable once set';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'warehouse.claims.superseded_at is immutable once set';
  END IF;
  IF OLD.superseded_by_claim_id IS NOT NULL AND NEW.superseded_by_claim_id IS DISTINCT FROM OLD.superseded_by_claim_id THEN
    RAISE EXCEPTION 'warehouse.claims.superseded_by_claim_id is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_block_update_trigger
  BEFORE UPDATE ON warehouse.claims
  FOR EACH ROW EXECUTE FUNCTION warehouse.claims_block_update();

-- Block DELETE on claims (GoBD)
CREATE OR REPLACE FUNCTION warehouse.claims_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.claims is append-only; DELETE not permitted (GoBD compliance)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_block_delete_trigger
  BEFORE DELETE ON warehouse.claims
  FOR EACH ROW EXECUTE FUNCTION warehouse.claims_block_delete();

-- Block UPDATE and DELETE on claim_closures (it's an audit log)
CREATE OR REPLACE FUNCTION warehouse.claim_closures_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.claim_closures is append-only audit log; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_closures_block_update
  BEFORE UPDATE ON warehouse.claim_closures
  FOR EACH ROW EXECUTE FUNCTION warehouse.claim_closures_block_modify();

CREATE TRIGGER claim_closures_block_delete
  BEFORE DELETE ON warehouse.claim_closures
  FOR EACH ROW EXECUTE FUNCTION warehouse.claim_closures_block_modify();

-- Block UPDATE and DELETE on derivation_records (audit log)
CREATE OR REPLACE FUNCTION warehouse.derivation_records_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.derivation_records is append-only; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER derivation_records_block_update
  BEFORE UPDATE ON warehouse.derivation_records
  FOR EACH ROW EXECUTE FUNCTION warehouse.derivation_records_block_modify();

CREATE TRIGGER derivation_records_block_delete
  BEFORE DELETE ON warehouse.derivation_records
  FOR EACH ROW EXECUTE FUNCTION warehouse.derivation_records_block_modify();

-- =============================================================================
-- RLS Policies (tenant isolation via org_id on Property FK)
-- =============================================================================

ALTER TABLE warehouse.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.claim_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse.derivation_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY claims_org_isolation ON warehouse.claims
  USING (property_id IN (
    SELECT id FROM "Property" WHERE "organizationId" = shared.current_org_id()
  ));

CREATE POLICY claim_closures_org_isolation ON warehouse.claim_closures
  USING (target_claim_id IN (
    SELECT id FROM warehouse.claims WHERE property_id IN (
      SELECT id FROM "Property" WHERE "organizationId" = shared.current_org_id()
    )
  ));

CREATE POLICY derivation_records_org_isolation ON warehouse.derivation_records
  USING (property_id IN (
    SELECT id FROM "Property" WHERE "organizationId" = shared.current_org_id()
  ));
