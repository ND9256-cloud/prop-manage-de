-- Migration: warehouse.brain_shadow_comparison
-- Task 3.4: parallel-run safety net. Nightly job diffs composer vs legacy
-- brain per property and writes per-divergence rows here. Customer-facing
-- surfaces continue to read composer only; the legacy brain runs silently.
-- See ARCHITECTURE_STATE.md → "Brain shadow mode" for the framing.

CREATE TABLE IF NOT EXISTS warehouse.brain_shadow_comparison (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at             timestamptz NOT NULL DEFAULT now(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL REFERENCES "Property"(id),
  unit_ref           text,
  divergent_field    text NOT NULL,
  composer_value     jsonb,
  legacy_value       jsonb,
  divergence_class   text NOT NULL,
  notes              text
);

CREATE INDEX IF NOT EXISTS idx_brain_shadow_comparison_run_at
  ON warehouse.brain_shadow_comparison (run_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_shadow_comparison_property_run_at
  ON warehouse.brain_shadow_comparison (property_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_shadow_comparison_class
  ON warehouse.brain_shadow_comparison (divergence_class);

-- RLS — same pattern as other warehouse tables; service_role writes from the
-- nightly job, authenticated reads scoped by org_id via shared.current_org_id().
ALTER TABLE warehouse.brain_shadow_comparison ENABLE ROW LEVEL SECURITY;

CREATE POLICY brain_shadow_comparison_org_isolation
  ON warehouse.brain_shadow_comparison
  FOR ALL
  TO authenticated
  USING (org_id = shared.current_org_id());

GRANT ALL    ON warehouse.brain_shadow_comparison TO service_role;
GRANT SELECT ON warehouse.brain_shadow_comparison TO authenticated;
