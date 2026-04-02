-- Add cost_class column to warehouse.documents
ALTER TABLE warehouse.documents ADD COLUMN IF NOT EXISTS cost_class text;
