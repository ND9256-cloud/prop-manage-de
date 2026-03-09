# LedgerEntry.id Default Fix

During UUID migration on 2026-03-09, `LedgerEntry.id` had `DEFAULT gen_random_uuid()::TEXT`
which blocked `ALTER TYPE`. Fixed by:

1. `DROP DEFAULT` before cast
2. `SET DEFAULT gen_random_uuid()` after cast (native UUID default)

This ensures `LedgerEntry.id` generates UUIDs correctly in all environments.

## Related migration files

- `20260309_org_uuid_migration.sql` — main TEXT→UUID migration
- `20260309_connector_apply_uuid_fix.sql` — removes ::TEXT casts in connector.apply()
