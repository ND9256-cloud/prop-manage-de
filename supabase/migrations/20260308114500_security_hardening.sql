-- Migration: Add quarantine fields to warehouse.documents
-- quarantined_by is TEXT to match NextAuth/Prisma User.id type (UUID stored as TEXT)

ALTER TABLE warehouse.documents
ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
ADD COLUMN IF NOT EXISTS quarantine_notes TEXT,
ADD COLUMN IF NOT EXISTS quarantined_by TEXT,
ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMP;

-- apply_log.trigger_type already exists (created in connector_apply_prisma_compat.sql)
-- Add CHECK constraint if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'apply_log_trigger_type_check'
  ) THEN
    ALTER TABLE warehouse.apply_log
    ADD CONSTRAINT apply_log_trigger_type_check
    CHECK (trigger_type IN ('auto', 'user_confirmed', 'user_corrected'));
  END IF;
END $$;
