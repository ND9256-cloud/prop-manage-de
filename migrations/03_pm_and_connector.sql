-- ============================================================
-- SCHEMA: pm
-- Purpose: Canonical PM tool tables
-- BOUNDARY: These tables are ONLY written to by connector functions
--           The warehouse schema has zero direct references to pm.*
-- ============================================================

CREATE SCHEMA IF NOT EXISTS pm;

-- ------------------------------------------------------------
-- Properties (buildings)
-- ------------------------------------------------------------
CREATE TABLE pm.properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  name            TEXT NOT NULL,
  address_street  TEXT NOT NULL,
  address_number  TEXT NOT NULL,
  address_zip     TEXT NOT NULL,
  address_city    TEXT NOT NULL,
  address_country TEXT NOT NULL DEFAULT 'DE',
  property_type   TEXT DEFAULT 'residential',
  purchase_price  NUMERIC(15,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Units (apartments within a property)
-- ------------------------------------------------------------
CREATE TABLE pm.units (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  property_id     UUID NOT NULL REFERENCES pm.properties(id),
  unit_ref        TEXT NOT NULL,           -- e.g. "WE 01", "2.OG links", "3B"
  floor           INTEGER,
  size_sqm        NUMERIC(8,2),
  rooms           NUMERIC(4,1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, unit_ref)
);

-- ------------------------------------------------------------
-- Tenants
-- ------------------------------------------------------------
CREATE TABLE pm.tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  iban            TEXT,                    -- encrypted at app layer
  gdpr_consent    BOOLEAN NOT NULL DEFAULT false,
  gdpr_consent_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Leases
-- ------------------------------------------------------------
CREATE TABLE pm.leases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  unit_id         UUID NOT NULL REFERENCES pm.units(id),
  tenant_id       UUID NOT NULL REFERENCES pm.tenants(id),
  rent_cold       NUMERIC(10,2) NOT NULL,
  rent_warm       NUMERIC(10,2),
  deposit         NUMERIC(10,2),
  lease_start     DATE NOT NULL,
  lease_end       DATE,                    -- NULL = indefinite
  notice_period   INTEGER DEFAULT 3,       -- months
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Payments
-- ------------------------------------------------------------
CREATE TABLE pm.payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  lease_id        UUID NOT NULL REFERENCES pm.leases(id),
  amount          NUMERIC(10,2) NOT NULL,
  due_date        DATE NOT NULL,
  paid_date       DATE,
  method          TEXT CHECK (method IN ('sepa', 'transfer', 'cash', 'other')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'overdue', 'partial')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Ledger entries (GoBD: immutable financial records)
-- ------------------------------------------------------------
CREATE TABLE pm.ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES shared.organisations(id),
  property_id     UUID REFERENCES pm.properties(id),
  unit_id         UUID REFERENCES pm.units(id),
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
  category        TEXT NOT NULL,           -- BetrKV category or custom
  amount          NUMERIC(10,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'EUR',
  entry_date      DATE NOT NULL,
  vendor_name     TEXT,
  invoice_number  TEXT,
  description     TEXT,
  source_doc_id   UUID,                    -- warehouse document_id (reference only, no FK)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger is append-only (GoBD)
CREATE RULE ledger_no_update AS ON UPDATE TO pm.ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO pm.ledger_entries DO INSTEAD NOTHING;

-- ------------------------------------------------------------
-- RLS — PM tables
-- ------------------------------------------------------------
ALTER TABLE pm.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm.ledger_entries ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pm.properties', 'pm.units', 'pm.tenants',
    'pm.leases', 'pm.payments', 'pm.ledger_entries'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY org_isolation ON %s USING (org_id = shared.current_org_id())', t
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
CREATE INDEX ON pm.properties (org_id);
CREATE INDEX ON pm.units (org_id, property_id);
CREATE INDEX ON pm.tenants (org_id);
CREATE INDEX ON pm.leases (org_id, unit_id);
CREATE INDEX ON pm.leases (org_id, lease_end) WHERE lease_end IS NOT NULL;
CREATE INDEX ON pm.payments (org_id, status);
CREATE INDEX ON pm.ledger_entries (org_id, property_id, entry_date);


-- ============================================================
-- SCHEMA: connector
-- Purpose: The ONLY bridge between warehouse and pm schemas
--          warehouse.* → connector.resolve() + connector.apply()
--          → pm.* tables
--
-- These are Postgres functions that act as the internal API.
-- Later, extracting these to real HTTP Edge Functions
-- requires only changing the transport — not the logic.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS connector;

-- ------------------------------------------------------------
-- connector.resolve()
-- Input:  org_id, entity_type, extracted_fields (JSONB)
-- Output: match_result JSONB with match_type + candidates
--
-- This is the ONLY function that reads pm.* tables
-- to find matching entities. Warehouse never queries pm directly.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION connector.resolve(
  p_org_id        UUID,
  p_entity_type   TEXT,      -- 'property' | 'unit' | 'tenant' | 'vendor' | 'lease'
  p_fields        JSONB,     -- extracted fields to match against
  p_confidence_threshold NUMERIC DEFAULT 90.0
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSONB;
  v_candidates JSONB := '[]'::JSONB;
  v_match_score NUMERIC;
BEGIN

  IF p_entity_type = 'property' THEN
    -- Fuzzy match on address (street + number + zip)
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', p.id,
      'name',         p.name,
      'address',      concat(p.address_street, ' ', p.address_number, ', ', p.address_zip, ' ', p.address_city),
      'confidence',   -- simple similarity score (replace with pg_trgm for production)
      CASE 
        WHEN lower(p.address_street) = lower(p_fields->>'address_street') 
         AND p.address_zip = (p_fields->>'address_zip')
        THEN 95.0
        WHEN lower(p.address_street) LIKE lower('%' || (p_fields->>'address_street') || '%')
        THEN 70.0
        ELSE 40.0
      END
    ))
    INTO v_candidates
    FROM pm.properties p
    WHERE p.org_id = p_org_id;

  ELSIF p_entity_type = 'unit' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', u.id,
      'unit_ref',     u.unit_ref,
      'property_id',  u.property_id,
      'confidence',
      CASE
        WHEN lower(u.unit_ref) = lower(p_fields->>'unit_ref') THEN 95.0
        WHEN lower(u.unit_ref) LIKE lower('%' || (p_fields->>'unit_ref') || '%') THEN 70.0
        ELSE 40.0
      END
    ))
    INTO v_candidates
    FROM pm.units u
    WHERE u.org_id = p_org_id
      AND (p_fields->>'property_id' IS NULL OR u.property_id = (p_fields->>'property_id')::UUID);

  ELSIF p_entity_type = 'tenant' THEN
    SELECT jsonb_agg(jsonb_build_object(
      'pm_entity_id', t.id,
      'name',         concat(t.first_name, ' ', t.last_name),
      'confidence',
      CASE
        WHEN lower(concat(t.first_name, ' ', t.last_name)) = lower(p_fields->>'tenant_name') THEN 95.0
        WHEN lower(t.last_name) = lower(p_fields->>'last_name') THEN 75.0
        ELSE 40.0
      END
    ))
    INTO v_candidates
    FROM pm.tenants t
    WHERE t.org_id = p_org_id;

  END IF;

  -- Route to match_type based on best candidate score
  SELECT CASE
    WHEN v_candidates IS NULL OR jsonb_array_length(v_candidates) = 0 THEN
      jsonb_build_object('match_type', 'new', 'candidates', '[]'::JSONB)
    WHEN (SELECT MAX((c->>'confidence')::NUMERIC) FROM jsonb_array_elements(v_candidates) c) >= p_confidence_threshold THEN
      jsonb_build_object(
        'match_type', 'existing',
        'candidates', v_candidates,
        'best_match', (SELECT c FROM jsonb_array_elements(v_candidates) c ORDER BY (c->>'confidence')::NUMERIC DESC LIMIT 1)
      )
    WHEN (SELECT COUNT(*) FROM jsonb_array_elements(v_candidates) c WHERE (c->>'confidence')::NUMERIC >= 60) > 1 THEN
      jsonb_build_object('match_type', 'ambiguous', 'candidates', v_candidates)
    ELSE
      jsonb_build_object('match_type', 'new', 'candidates', v_candidates)
  END INTO v_result;

  RETURN v_result;
END;
$$;

-- ------------------------------------------------------------
-- connector.apply()
-- Input:  apply instruction from warehouse pipeline
-- Output: { success, pm_entity_id, action_taken }
--
-- This is the ONLY function that writes to pm.* tables.
-- All writes are idempotent and audit-logged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION connector.apply(
  p_org_id            UUID,
  p_document_id       UUID,
  p_extraction_id     UUID,
  p_action            TEXT,      -- 'lease.create' | 'ledger.append' | 'tenant.create' | etc.
  p_payload           JSONB,     -- fields to write
  p_triggered_by      UUID,      -- user_id (NULL = auto)
  p_trigger_type      TEXT,      -- 'auto' | 'user_confirmed' | 'user_override'
  p_idempotency_key   TEXT       -- caller must provide: hash(document_id + action + key fields)
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_existing_apply warehouse.apply_log%ROWTYPE;
  v_pm_entity_id   UUID;
  v_result         JSONB;
BEGIN

  -- Idempotency check: if this key already succeeded, return cached result
  SELECT * INTO v_existing_apply
  FROM warehouse.apply_log
  WHERE idempotency_key = p_idempotency_key AND status = 'success';

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'pm_entity_id', v_existing_apply.pm_entity_id,
      'action', p_action
    );
  END IF;

  -- Execute the action
  BEGIN

    IF p_action = 'ledger.append' THEN
      INSERT INTO pm.ledger_entries (
        org_id, property_id, unit_id, entry_type, category,
        amount, currency, entry_date, vendor_name,
        invoice_number, description, source_doc_id
      ) VALUES (
        p_org_id,
        (p_payload->>'property_id')::UUID,
        (p_payload->>'unit_id')::UUID,
        p_payload->>'entry_type',
        p_payload->>'category',
        (p_payload->>'amount')::NUMERIC,
        COALESCE(p_payload->>'currency', 'EUR'),
        (p_payload->>'entry_date')::DATE,
        p_payload->>'vendor_name',
        p_payload->>'invoice_number',
        p_payload->>'description',
        p_document_id
      ) RETURNING id INTO v_pm_entity_id;

    ELSIF p_action = 'tenant.create' THEN
      INSERT INTO pm.tenants (
        org_id, first_name, last_name, email, phone
      ) VALUES (
        p_org_id,
        p_payload->>'first_name',
        p_payload->>'last_name',
        p_payload->>'email',
        p_payload->>'phone'
      ) RETURNING id INTO v_pm_entity_id;

    ELSIF p_action = 'lease.create' THEN
      INSERT INTO pm.leases (
        org_id, unit_id, tenant_id, rent_cold, rent_warm,
        deposit, lease_start, lease_end
      ) VALUES (
        p_org_id,
        (p_payload->>'unit_id')::UUID,
        (p_payload->>'tenant_id')::UUID,
        (p_payload->>'rent_cold')::NUMERIC,
        (p_payload->>'rent_warm')::NUMERIC,
        (p_payload->>'deposit')::NUMERIC,
        (p_payload->>'lease_start')::DATE,
        (p_payload->>'lease_end')::DATE
      ) RETURNING id INTO v_pm_entity_id;

    ELSIF p_action = 'property.create' THEN
      -- Property creation always requires user_confirmed or user_override
      IF p_trigger_type = 'auto' THEN
        RAISE EXCEPTION 'property.create cannot be auto-triggered. Requires user confirmation.';
      END IF;
      INSERT INTO pm.properties (
        org_id, name, address_street, address_number,
        address_zip, address_city, address_country
      ) VALUES (
        p_org_id,
        p_payload->>'name',
        p_payload->>'address_street',
        p_payload->>'address_number',
        p_payload->>'address_zip',
        p_payload->>'address_city',
        COALESCE(p_payload->>'address_country', 'DE')
      ) RETURNING id INTO v_pm_entity_id;

    ELSIF p_action = 'unit.create' THEN
      -- Unit creation also requires confirmation
      IF p_trigger_type = 'auto' THEN
        RAISE EXCEPTION 'unit.create cannot be auto-triggered. Requires user confirmation.';
      END IF;
      INSERT INTO pm.units (
        org_id, property_id, unit_ref, floor, size_sqm, rooms
      ) VALUES (
        p_org_id,
        (p_payload->>'property_id')::UUID,
        p_payload->>'unit_ref',
        (p_payload->>'floor')::INTEGER,
        (p_payload->>'size_sqm')::NUMERIC,
        (p_payload->>'rooms')::NUMERIC
      ) RETURNING id INTO v_pm_entity_id;

    ELSE
      RAISE EXCEPTION 'Unknown connector action: %', p_action;
    END IF;

    -- Write apply_log (always, on success)
    INSERT INTO warehouse.apply_log (
      document_id, extraction_id, org_id,
      triggered_by, trigger_type,
      connector_action, pm_entity_type, pm_entity_id,
      request_payload, status, idempotency_key
    ) VALUES (
      p_document_id, p_extraction_id, p_org_id,
      p_triggered_by, p_trigger_type,
      p_action,
      split_part(p_action, '.', 1),  -- 'ledger', 'tenant', 'lease', etc.
      v_pm_entity_id,
      p_payload,
      'success',
      p_idempotency_key
    );

    -- Write shared audit log
    INSERT INTO shared.audit_log (
      org_id, actor_id, actor_type, action,
      entity_type, entity_id, payload
    ) VALUES (
      p_org_id,
      p_triggered_by,
      CASE WHEN p_triggered_by IS NULL THEN 'system' ELSE 'connector' END,
      p_action,
      split_part(p_action, '.', 1),
      v_pm_entity_id,
      jsonb_build_object('document_id', p_document_id, 'trigger_type', p_trigger_type)
    );

    -- Update document status
    UPDATE warehouse.documents
    SET status = 'applied', applied_at = now(), updated_at = now()
    WHERE id = p_document_id;

    v_result := jsonb_build_object(
      'success', true,
      'pm_entity_id', v_pm_entity_id,
      'action', p_action
    );

  EXCEPTION WHEN OTHERS THEN
    -- Log the failure
    INSERT INTO warehouse.apply_log (
      document_id, extraction_id, org_id,
      triggered_by, trigger_type,
      connector_action, pm_entity_type,
      request_payload, status,
      error_message, idempotency_key
    ) VALUES (
      p_document_id, p_extraction_id, p_org_id,
      p_triggered_by, p_trigger_type,
      p_action, split_part(p_action, '.', 1),
      p_payload, 'failed',
      SQLERRM, p_idempotency_key
    );

    v_result := jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'action', p_action
    );
  END;

  RETURN v_result;
END;
$$;
