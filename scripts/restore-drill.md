## Backup-Restore Drill — May 3, 2026

**Result: PASSED**

- pg_dump from production via pooler (port 6543): 4.7MB compressed dump
- pg_restore into separate Supabase project (restore-drill-temp)
- Verified: 634 documents, 402 intelligence rows, 411 extraction rows — all match production
- 318 restore errors, all Supabase system extensions (event triggers, permissions) — no data loss
- Cadence: quarterly (next drill: August 2026)

**Recovery procedure:**
1. Install libpq: brew install libpq
2. Dump: pg_dump "postgresql://postgres.vatsmyvkeuxkcwemmxau:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:6543/postgres" --no-owner --no-acl -F c -f backup.dump
3. Restore: pg_restore --no-owner --no-acl -d "TARGET_CONNECTION_STRING" backup.dump
4. Expect ~300 extension errors (harmless). Verify warehouse.documents count matches.
