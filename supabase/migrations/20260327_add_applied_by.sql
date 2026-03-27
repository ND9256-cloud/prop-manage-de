ALTER TABLE warehouse.documents
  ADD COLUMN IF NOT EXISTS applied_by UUID;
