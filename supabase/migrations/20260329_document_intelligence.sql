-- Document Intelligence table: stores AI-generated summaries, tags, entity refs, and action signals per document
CREATE TABLE warehouse.document_intelligence (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES warehouse.documents(id),
    org_id uuid NOT NULL,
    summary text NOT NULL,
    tags text[],
    entity_name text,
    entity_type text,
    unit_ref text,
    period_start text,
    period_end text,
    related_documents jsonb,
    action_signals jsonb,
    viewer_safe boolean DEFAULT true,
    viewer_safety_reasons text[],
    created_at timestamptz DEFAULT now(),
    is_current boolean DEFAULT true
);

CREATE INDEX idx_di_doc ON warehouse.document_intelligence(document_id) WHERE is_current = true;
CREATE INDEX idx_di_org ON warehouse.document_intelligence(org_id);

ALTER TABLE warehouse.document_intelligence ENABLE ROW LEVEL SECURITY;
