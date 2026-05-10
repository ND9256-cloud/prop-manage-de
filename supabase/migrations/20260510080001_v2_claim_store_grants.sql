-- Grants for v2 claim store tables (service_role + authenticated for RLS-filtered access)

GRANT ALL ON warehouse.claims TO service_role;
GRANT SELECT, INSERT ON warehouse.claims TO authenticated;

GRANT ALL ON warehouse.claim_closures TO service_role;
GRANT SELECT, INSERT ON warehouse.claim_closures TO authenticated;

GRANT ALL ON warehouse.derivation_records TO service_role;
GRANT SELECT, INSERT ON warehouse.derivation_records TO authenticated;
