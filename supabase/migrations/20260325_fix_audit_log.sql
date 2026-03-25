ALTER TABLE shared.audit_log ADD COLUMN IF NOT EXISTS property_id uuid;
ALTER TABLE shared.audit_log ADD COLUMN IF NOT EXISTS unit_id uuid;
