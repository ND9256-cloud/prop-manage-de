-- Add cost classification columns to document_intelligence
ALTER TABLE warehouse.document_intelligence ADD COLUMN IF NOT EXISTS cost_class text;
ALTER TABLE warehouse.document_intelligence ADD COLUMN IF NOT EXISTS umlagefaehig boolean;
