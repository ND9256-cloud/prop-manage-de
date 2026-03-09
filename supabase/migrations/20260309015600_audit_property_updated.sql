-- Add property_updated event type to audit_log CHECK constraint
ALTER TABLE shared.audit_log DROP CONSTRAINT IF EXISTS audit_log_event_type_check;
ALTER TABLE shared.audit_log ADD CONSTRAINT audit_log_event_type_check
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
        'processing_failed',
        'property_updated'
    ));
