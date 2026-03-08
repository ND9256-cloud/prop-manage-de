-- Part 1: Warehouse redesign database changes
-- Add document metadata columns for property-first data room

ALTER TABLE warehouse.documents
ADD COLUMN IF NOT EXISTS display_name TEXT,
ADD COLUMN IF NOT EXISTS category TEXT,
ADD COLUMN IF NOT EXISTS subcategory TEXT,
ADD COLUMN IF NOT EXISTS property_id UUID,
ADD COLUMN IF NOT EXISTS retention_until DATE;

-- Category must be one of the allowed values (or NULL)
ALTER TABLE warehouse.documents DROP CONSTRAINT IF EXISTS documents_category_check;
ALTER TABLE warehouse.documents ADD CONSTRAINT documents_category_check
CHECK (category IS NULL OR category IN (
  'rechtliches','finanzen',
  'kosten_rechnungen','vertraege',
  'instandhaltung','behoerden','medien'
));

-- Property short_code for display_name generation
ALTER TABLE public."Property"
ADD COLUMN IF NOT EXISTS short_code VARCHAR(5);
