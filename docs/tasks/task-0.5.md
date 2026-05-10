# Task 0.5 — Migration: v2 extraction envelope table

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §3.1 (field-level envelope), §3.3 (document-level envelope), §3.4 (lifecycle sub-envelope)
- `extraction-v2-implementation-plan.md` Task 0.5 section

Prior tasks: 0.1, 0.2, 0.3, 0.4 (all shipped). The claim store from Task 0.4 is now live in `warehouse.claims`, `warehouse.claim_closures`, `warehouse.derivation_records`.

This is a **t2 task** (logic, requires review). It creates the v2 extraction envelope table. This is the **input side** of the claim layer — extractions land here in v2 envelope shape, then claim emitters parse them into claims (Task 0.4's tables). The legacy `warehouse.document_extractions` table stays untouched and continues to receive Haiku Step 5 output during the transition window per architecture §11.

## Repo conventions (do NOT deviate)

- Package manager: **npm**
- Tests run via `npx tsx src/tests/<file>.ts` (with internal dotenv loading) OR `npx tsx -r dotenv/config src/tests/<file>.ts` (with default `.env`). For tests that read Supabase secrets, use the explicit `.env.local` pattern from `src/tests/v2-claim-store-migration.test.ts`:
  ```typescript
  import * as path from 'path';
  import * as dotenv from 'dotenv';
  dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });
  ```
- Validation library: **zod** (already declared)
- Migration filename pattern: `YYYYMMDDHHMMSS_<name>.sql` (date+time prefix). Match the most recent migration (Task 0.4 used `20260510080000_v2_claim_store.sql` and `20260510080001_v2_claim_store_grants.sql`). Use a timestamp later than those.
- Multi-schema: `warehouse.*` tables managed via raw SQL migrations, NOT Prisma. Add a commented Prisma stub for the linter (per Task 0.4's pattern).
- Pipe potentially-paged commands through `| cat`

## Critical: dependency hygiene

Do NOT introduce new runtime dependencies in this task. The migration is pure SQL; the integration test uses `@supabase/supabase-js` and `dotenv` (both already declared).

## Steps

### 1. Create the migration file

Path: `supabase/migrations/<timestamp>_v2_extraction_envelope.sql`

Use a timestamp later than `20260510080001`. Example: `20260510090000`.

Per architecture §3.3 + §3.4, the table stores the entire document-level envelope. The `fields` jsonb column holds the field-level envelope per §3.1 (one entry per extracted field). The `lifecycle` jsonb column holds the lifecycle sub-envelope per §3.4.

```sql
CREATE TABLE IF NOT EXISTS warehouse.document_extractions_v2 (
  -- Identity
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source
  source_document_id        uuid NOT NULL REFERENCES warehouse.documents(id),
  doc_type                  text NOT NULL,

  -- Versioning (per §3.3)
  schema_version            text NOT NULL,
  prompt_version            text NOT NULL,
  model                     text NOT NULL,
  extraction_run_id         uuid NOT NULL,

  -- The envelope payload (per §3.1)
  -- Map of field_name -> field_envelope. Each field_envelope has:
  --   raw_value, normalized_value, evidence, confidence, absence_state,
  --   validation_status, severity
  fields                    jsonb NOT NULL DEFAULT '{}',

  -- Lifecycle sub-envelope (per §3.4)
  -- { issue_date, effective_date, signed_date, expiry_date, document_status,
  --   supersedes_document_id, amended_by_document_id, lifecycle_evidence }
  lifecycle                 jsonb NOT NULL DEFAULT '{}',

  -- Human review (per §3.3)
  human_review_status       text NOT NULL DEFAULT 'not_reviewed'
    CHECK (human_review_status IN ('not_reviewed', 'accepted', 'corrected', 'rejected')),

  -- Audit
  created_at                timestamptz NOT NULL DEFAULT now()
);
```

Important: `warehouse.documents` is the legacy table that already exists and holds source documents. Verify it's spelled correctly when writing the FK — check existing migrations for the quoting convention.

### 2. Add indexes

Per architecture §3.3 implication and the implementation plan's "latest extraction for document" query pattern:

```sql
-- "Get the latest extraction for this document" — most common resolver query
CREATE INDEX idx_doc_extractions_v2_source_latest
  ON warehouse.document_extractions_v2 (source_document_id, created_at DESC);

-- Lookup by extraction_run_id (replay scenarios)
CREATE INDEX idx_doc_extractions_v2_run_id
  ON warehouse.document_extractions_v2 (extraction_run_id);

-- Lookup by schema_version (re-emission candidate queries when schema changes)
CREATE INDEX idx_doc_extractions_v2_schema_version
  ON warehouse.document_extractions_v2 (schema_version);

-- Lookup by doc_type (statistics, eval slicing)
CREATE INDEX idx_doc_extractions_v2_doc_type
  ON warehouse.document_extractions_v2 (doc_type);

-- Lookup by review status (operator dashboard "needs review")
CREATE INDEX idx_doc_extractions_v2_review_status
  ON warehouse.document_extractions_v2 (human_review_status)
  WHERE human_review_status != 'not_reviewed';
```

### 3. Immutability + GoBD triggers

Per implementation plan acceptance criteria: UPDATE blocked except for `human_review_status` (which can change as a human reviews). DELETE blocked entirely.

```sql
-- Block UPDATE except on human_review_status
CREATE OR REPLACE FUNCTION warehouse.doc_extractions_v2_block_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.id IS DISTINCT FROM OLD.id) OR
     (NEW.source_document_id IS DISTINCT FROM OLD.source_document_id) OR
     (NEW.doc_type IS DISTINCT FROM OLD.doc_type) OR
     (NEW.schema_version IS DISTINCT FROM OLD.schema_version) OR
     (NEW.prompt_version IS DISTINCT FROM OLD.prompt_version) OR
     (NEW.model IS DISTINCT FROM OLD.model) OR
     (NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id) OR
     (NEW.fields IS DISTINCT FROM OLD.fields) OR
     (NEW.lifecycle IS DISTINCT FROM OLD.lifecycle) OR
     (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'warehouse.document_extractions_v2 is append-only; only human_review_status may be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_extractions_v2_block_update_trigger
  BEFORE UPDATE ON warehouse.document_extractions_v2
  FOR EACH ROW EXECUTE FUNCTION warehouse.doc_extractions_v2_block_update();

-- Block DELETE entirely (GoBD)
CREATE OR REPLACE FUNCTION warehouse.doc_extractions_v2_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.document_extractions_v2 is append-only; DELETE not permitted (GoBD compliance)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_extractions_v2_block_delete_trigger
  BEFORE DELETE ON warehouse.document_extractions_v2
  FOR EACH ROW EXECUTE FUNCTION warehouse.doc_extractions_v2_block_delete();
```

### 4. RLS policies (separate file, matching Task 0.4 pattern)

Path: `supabase/migrations/<timestamp+1>_v2_extraction_envelope_grants.sql`

Match the structure of `20260510080001_v2_claim_store_grants.sql`. Look at that file for the exact pattern (RLS enable + service-role policies + grants). Do not invent your own — copy the structure used for the claim store and adjust table names.

### 5. Apply the migrations

After writing both files, apply them. Match whatever pattern Task 0.4 used. If unclear, look at how `20260510080000_v2_claim_store.sql` was applied (was it `supabase db push`? something else?) and follow the same pattern.

### 6. Add Prisma stub

Per Task 0.4's pattern, add a commented placeholder model in `prisma/schema.prisma` so the tenant-isolation linter recognizes the table. Annotate as `@tenant-scoped-via source_document_id` (the FK chain: `document_extractions_v2.source_document_id` → `documents.id` → `Property.id`).

The stub is for the linter only; the table is SQL-managed.

### 7. Add an integration test

Create `src/tests/v2-extraction-envelope-migration.test.ts`. Pattern matches `src/tests/v2-claim-store-migration.test.ts` exactly: load `.env.local` explicitly, use service-role client, write idempotent assertions tagged with a timestamped subject so the test data is filterable later.

Assertions to verify:

```typescript
// 1. INSERT a valid envelope → succeeds, returns UUID
// 2. INSERT with invalid human_review_status → fails (CHECK constraint)
// 3. INSERT with default human_review_status='not_reviewed' → succeeds
// 4. INSERT with empty fields jsonb {} → succeeds
// 5. INSERT with rich fields jsonb (one field with raw_value, normalized_value, evidence, confidence, absence_state, validation_status, severity) → succeeds
// 6. INSERT with full lifecycle sub-envelope → succeeds
// 7. UPDATE the envelope's fields jsonb → fails (immutability trigger)
// 8. UPDATE the envelope's human_review_status from 'not_reviewed' to 'accepted' → succeeds
// 9. UPDATE human_review_status with arbitrary string → fails (CHECK constraint)
// 10. DELETE the envelope → fails (GoBD trigger)
// 11. Index lookup: query by source_document_id ordered by created_at DESC works
// 12. Index lookup: query by extraction_run_id works
```

12 assertions. Test data uses a real source_document_id from the existing `warehouse.documents` table (not a fabricated UUID — the FK requires it to exist). Pick the first available one; same pattern Task 0.4's test uses for Property.

Run via: `npx tsx src/tests/v2-extraction-envelope-migration.test.ts`

Expected output: `✓ 12 v2 extraction envelope migration assertions passed`

### 8. Update tenant-isolation lint configuration

Same approach as Task 0.4. Annotate the new table per the linter's expectations. Look at how Task 0.4's claim tables were annotated and follow the same pattern.

### 9. Update ARCHITECTURE_STATE.md

Add a section describing:
- New table `warehouse.document_extractions_v2`
- Append-only with one exception: `human_review_status` is mutable to support the triage workflow
- DELETE blocked (GoBD)
- Indexes: `(source_document_id, created_at DESC)`, `extraction_run_id`, `schema_version`, `doc_type`, partial on review status
- Tenant isolation: `@tenant-scoped-via source_document_id`
- Migration: `supabase/migrations/<timestamp>_v2_extraction_envelope.sql` + `_grants.sql`
- Integration test: `src/tests/v2-extraction-envelope-migration.test.ts`
- Status: schema live, no code yet writes envelopes (Phase 1 emitters do that)
- Note: legacy `warehouse.document_extractions` (Haiku Step 5) untouched; both paths coexist during transition window

### 10. Verify

Run regression tests + the new integration test:

```bash
# New
npx tsx src/tests/v2-extraction-envelope-migration.test.ts

# Regression
npx tsx src/tests/v2-claim-store-migration.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx -r dotenv/config src/tests/schemas.test.ts
npm run gen:schemas:check
npx tsc --noEmit
```

Expected:
- New test prints `✓ 12 v2 extraction envelope migration assertions passed`
- All prior tests still pass
- `tsc` silent

### 11. Commit and push

Branch protection requires PR workflow. Create a feature branch:

```bash
git checkout -b feature/task-0.5-extraction-envelope
```

Commit message: `v2: add extraction envelope migration (document_extractions_v2) (Task 0.5)`

Push the branch:

```bash
git push -u origin feature/task-0.5-extraction-envelope
```

Report back the URL of the new branch. Nils will open the PR and merge after CI passes.

## Acceptance gates (verify before reporting completion)

- `ls supabase/migrations/ | tail -3 | cat` shows two new migration files
- Migrations applied locally without error
- `npx tsx src/tests/v2-extraction-envelope-migration.test.ts` exits 0 with `✓ 12 v2 extraction envelope migration assertions passed`
- All 12 assertions in the integration test pass (CHECK constraints, triggers, mutability of human_review_status, immutability of everything else)
- All prior regression tests still pass (claim store migration, domain knowledge, schemas, generator check)
- `npx tsc --noEmit` is silent
- Branch pushed to origin with the expected commit
- Legacy `warehouse.document_extractions` table is NOT modified

## Constraints

- Do NOT modify or migrate the legacy `warehouse.document_extractions` table. It stays for the Haiku Step 5 transition window per architecture §11.
- Do NOT add Prisma models for the new table beyond the linter stub. SQL-only access.
- Do NOT skip the conditional UPDATE trigger logic. The selective mutability of `human_review_status` is critical for the triage workflow; mistakenly making the whole row immutable breaks human review entirely.
- Do NOT modify existing migrations. Add new files with later timestamps.
- Do NOT use `pnpm` or `yarn`.
- Do NOT push directly to main. Use the feature branch + PR workflow.
- Pipe git commands through `| cat`.
