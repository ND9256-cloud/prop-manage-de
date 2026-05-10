-- Grants for v2 extraction envelope table (service_role + authenticated for RLS-filtered access)

GRANT ALL ON warehouse.document_extractions_v2 TO service_role;
GRANT SELECT, INSERT ON warehouse.document_extractions_v2 TO authenticated;
