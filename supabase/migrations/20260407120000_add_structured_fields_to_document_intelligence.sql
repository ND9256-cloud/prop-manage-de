-- Add structured_fields column for doc-type-specific extraction data
ALTER TABLE warehouse.document_intelligence
ADD COLUMN IF NOT EXISTS structured_fields jsonb;

COMMENT ON COLUMN warehouse.document_intelligence.structured_fields
IS 'Doc-type-specific structured extraction fields from Sonnet. Schema varies per doc_type. Includes schema_version for migration tracking.';

CREATE INDEX IF NOT EXISTS idx_document_intelligence_structured_fields
ON warehouse.document_intelligence USING gin (structured_fields)
WHERE structured_fields IS NOT NULL;
