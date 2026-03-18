-- Drop the closed-enum CHECK constraint on warehouse.documents.doc_type
-- to allow open taxonomy classification (German Hausverwaltung terms).
ALTER TABLE warehouse.documents
  DROP CONSTRAINT IF EXISTS documents_doc_type_check;

-- Also try the unnamed-constraint form that Postgres may have generated
DO $$
BEGIN
  EXECUTE (
    SELECT 'ALTER TABLE warehouse.documents DROP CONSTRAINT ' || conname
    FROM   pg_constraint
    WHERE  conrelid = 'warehouse.documents'::regclass
      AND  contype  = 'c'
      AND  pg_get_constraintdef(oid) ILIKE '%doc_type%'
    LIMIT  1
  );
EXCEPTION WHEN OTHERS THEN
  NULL; -- constraint already dropped or does not exist
END $$;
