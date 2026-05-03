-- GoBD soft-delete enforcement for warehouse.documents
-- Adds audit columns and prevents hard DELETE

-- 1. Add soft-delete audit columns
ALTER TABLE warehouse.documents
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid;

-- 2. Create trigger function that blocks hard DELETE
CREATE OR REPLACE FUNCTION warehouse.prevent_hard_delete_documents()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Hard DELETE on warehouse.documents is prohibited (GoBD compliance). Use softDeleteDocument() to set status=deleted.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach trigger to documents table
DROP TRIGGER IF EXISTS trg_prevent_hard_delete ON warehouse.documents;
CREATE TRIGGER trg_prevent_hard_delete
  BEFORE DELETE ON warehouse.documents
  FOR EACH ROW
  EXECUTE FUNCTION warehouse.prevent_hard_delete_documents();

-- 4. Create index on deleted_at for query performance
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at
  ON warehouse.documents(deleted_at)
  WHERE deleted_at IS NOT NULL;
