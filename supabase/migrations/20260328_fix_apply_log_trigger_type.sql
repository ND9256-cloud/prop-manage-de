-- Fix: drop all CHECK constraints on warehouse.apply_log.trigger_type
-- and add a single clean constraint with all allowed values.
-- The original inline CHECK only allowed ('auto','user_confirmed','user_override')
-- which conflicts with the code sending 'user_corrected'.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Drop every CHECK constraint on warehouse.apply_log that references trigger_type
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'warehouse'
      AND rel.relname = 'apply_log'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%trigger_type%'
  LOOP
    EXECUTE format('ALTER TABLE warehouse.apply_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE warehouse.apply_log
ADD CONSTRAINT apply_log_trigger_type_check
CHECK (trigger_type IN ('auto', 'user_confirmed', 'user_corrected', 'bulk'));
