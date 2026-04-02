-- Property Intelligence brain table
CREATE TABLE warehouse.property_intelligence (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  property_id uuid NOT NULL,
  org_id uuid NOT NULL,
  analysis jsonb NOT NULL,
  suggested_views jsonb,
  generated_at timestamptz DEFAULT now(),
  is_stale boolean DEFAULT false,
  document_count int,
  is_current boolean DEFAULT true
);

ALTER TABLE warehouse.property_intelligence DISABLE ROW LEVEL SECURITY;

GRANT ALL ON warehouse.property_intelligence TO service_role, authenticated, anon;

CREATE INDEX idx_pi_property ON warehouse.property_intelligence(property_id) WHERE is_current = true;
