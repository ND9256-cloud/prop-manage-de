-- ============================================================
-- SCHEMA: shared
-- Purpose: Auth, orgs, roles — used by both warehouse + PM tool
-- ============================================================

CREATE SCHEMA IF NOT EXISTS shared;

-- ------------------------------------------------------------
-- Organisations (multi-tenant root)
-- Every row in the system belongs to an org_id
-- ------------------------------------------------------------
CREATE TABLE shared.organisations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,         -- e.g. "muster-immobilien"
  plan          TEXT NOT NULL DEFAULT 'warehouse_only'
                CHECK (plan IN ('warehouse_only', 'pm_only', 'full')),
  locale        TEXT NOT NULL DEFAULT 'de',   -- de | en
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Users (extends Supabase auth.users)
-- ------------------------------------------------------------
CREATE TABLE shared.users (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES shared.organisations(id),
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member', 'external_manager', 'auditor')),
  display_name  TEXT,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Audit log (shared — all schemas write here)
-- GoBD: immutable, append-only, no deletes/updates allowed
-- ------------------------------------------------------------
CREATE TABLE shared.audit_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES shared.organisations(id),
  actor_id      UUID REFERENCES shared.users(id),  -- NULL = system
  actor_type    TEXT NOT NULL DEFAULT 'user'
                CHECK (actor_type IN ('user', 'system', 'connector')),
  action        TEXT NOT NULL,                     -- e.g. 'apply.lease.create'
  entity_type   TEXT NOT NULL,                     -- e.g. 'lease', 'document'
  entity_id     UUID,
  payload       JSONB,                             -- what changed (no PII in logs)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log is append-only: no updates, no deletes
CREATE RULE audit_log_no_update AS ON UPDATE TO shared.audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO shared.audit_log DO INSTEAD NOTHING;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE shared.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared.audit_log ENABLE ROW LEVEL SECURITY;

-- Users can only see their own org
CREATE POLICY "org_isolation" ON shared.organisations
  USING (id = (SELECT org_id FROM shared.users WHERE id = auth.uid()));

CREATE POLICY "org_isolation" ON shared.users
  USING (org_id = (SELECT org_id FROM shared.users WHERE id = auth.uid()));

CREATE POLICY "org_isolation" ON shared.audit_log
  USING (org_id = (SELECT org_id FROM shared.users WHERE id = auth.uid()));

-- Helper function: get current user's org_id (used in all other RLS policies)
CREATE OR REPLACE FUNCTION shared.current_org_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT org_id FROM shared.users WHERE id = auth.uid()
$$;

-- Helper function: get current user's role
CREATE OR REPLACE FUNCTION shared.current_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM shared.users WHERE id = auth.uid()
$$;
