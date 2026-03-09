-- Audit log for all organisation activity
-- Tracks document actions, user management, and system events

CREATE SCHEMA IF NOT EXISTS shared;

CREATE TABLE IF NOT EXISTS shared.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_email TEXT,
    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'uploaded',
            'applied',
            'quarantined',
            'unquarantined',
            'dismissed',
            'downloaded',
            'invited',
            'role_changed',
            'apply_failed',
            'processing_failed'
        )),
    document_id UUID,
    property_id UUID,
    unit_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS audit_log_org_id_idx
    ON shared.audit_log(org_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
    ON shared.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_document_id_idx
    ON shared.audit_log(document_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx
    ON shared.audit_log(actor_user_id);

-- Row Level Security
ALTER TABLE shared.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all"
    ON shared.audit_log
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);
