-- Add RLS policy and service_role grant for document_intelligence
CREATE POLICY org_isolation ON warehouse.document_intelligence
    USING (org_id = shared.current_org_id());

GRANT ALL ON warehouse.document_intelligence TO service_role;
