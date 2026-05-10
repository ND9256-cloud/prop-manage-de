# Task 0.4 — Migration: claim store tables

Reference docs (must be in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §4.2 (claim schema), §4.3 (immutability), §4.6 (DerivationRecord), §4.7 (source_type), §5.5.3 (close_modes), §5.5.7 (partial index)
- `extraction-v2-implementation-plan.md` (Task 0.4 section)

Prior tasks: `docs/tasks/task-0.1.md`, `task-0.2.md`, `task-0.3.md` (all shipped). Tier 0 gates active: `architecture-state.yml`, `migration-drift.yml`, `tenant-isolation.yml`.

This is a **t2 task** (logic, requires review). It creates the foundational table set for the entire claim layer. Three tables: `warehouse.claims`, `warehouse.claim_closures`, `warehouse.derivation_records`.

## Repo conventions (do NOT deviate)

- Package manager: **npm**
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Validation library: **zod** (already declared)
- YAML parsing: **js-yaml** (already declared)
- Migration filename pattern: match the most recent migration's pattern. Recent files use `YYYYMMDDHHMMSS_<name>.sql` (date+time prefix). Use that.
- Multi-schema mode: this repo manages `warehouse.*` tables via raw SQL migrations, NOT via Prisma. Do NOT add Prisma models for the claim tables — keep them SQL-only, accessed via Supabase service-role client. (Architecture §6 / project pattern.)
- Pipe potentially-paged commands through `| cat`

## Critical: dependency hygiene

Before importing ANY library, verify it is declared in `package.json`. Do NOT introduce new runtime dependencies in this task — the migration is pure SQL.

## Steps

### 1. Create the migration file

Path: `supabase/migrations/<timestamp>_v2_claim_store.sql`

Use a timestamp like `20260509100000` (or the actual timestamp at run-time, in UTC). The filename should sort AFTER `20260503120000_gobd_soft_delete.sql`.

The migration creates three tables in the `warehouse` schema, all with immutability triggers and GoBD-compliant DELETE prevention.

#### Table 1: warehouse.claims

Per architecture §4.2 + §4.7:

```sql
CREATE TABLE IF NOT EXISTS warehouse.claims (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               uuid NOT NULL REFERENCES "Property"(id),
  subject                   text NOT NULL,
  predicate                 text NOT NULL,
  value                     jsonb NOT NULL,
  claim_kind                text NOT NULL CHECK (claim_kind IN ('assertion', 'snapshot', 'event', 'reference')),
  source_type               text NOT NULL CHECK (source_type IN ('document_extraction', 'human_adjudication', 'system_derivation')),
  valid_from                date NOT NULL,
  valid_to                  date,
  source_document_id        uuid,
  source_extraction_run_id  uuid,
  source_field_path         text,
  human_actor_id            uuid,
  confidence                text CHECK (confidence IN ('high', 'medium', 'low') OR confidence IS NULL),
  evidence_id               uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  superseded_at             timestamptz,
  superseded_by_claim_id    uuid REFERENCES warehouse.claims(id),

  -- Architecture §4.7: source_type → field constraints
  CONSTRAINT human_adjudication_has_actor
    CHECK (source_type != 'human_adjudication' OR human_actor_id IS NOT NULL),
  CONSTRAINT document_extraction_has_extraction_run
    CHECK (source_type != 'document_extraction' OR source_extraction_run_id IS NOT NULL),

  -- valid_to must be >= valid_from when set (no negative-duration claims)
  CONSTRAINT valid_interval_sane
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
```

Note: the `Property` table is named `"Property"` with capital P in the existing schema (per project memory). Use the quoted form in the FK reference.

#### Table 2: warehouse.claim_closures

Audit trail for executed closures. Per architecture §5.5.4:

```sql
CREATE TABLE IF NOT EXISTS warehouse.claim_closures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_claim_id     uuid NOT NULL REFERENCES warehouse.claims(id),
  reason_claim_id     uuid NOT NULL REFERENCES warehouse.claims(id),
  close_mode          text NOT NULL CHECK (close_mode IN (
                        'close_overlapping_only',
                        'close_overlapping_and_future',
                        'close_overlapping_and_supersede_future'
                      )),
  applied_valid_to    date NOT NULL,
  applier_version     text NOT NULL,
  applied_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_self_closure CHECK (target_claim_id != reason_claim_id)
);
```

#### Table 3: warehouse.derivation_records

Per architecture §4.6:

```sql
CREATE TABLE IF NOT EXISTS warehouse.derivation_records (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                 uuid NOT NULL REFERENCES "Property"(id),
  output_type                 text NOT NULL CHECK (output_type IN (
                                'claim', 'closure', 'resolved_fact',
                                'property_snapshot', 'derived_claim'
                              )),
  output_id                   uuid NOT NULL,
  input_claim_ids             uuid[] NOT NULL DEFAULT '{}',
  input_extraction_run_ids    uuid[] NOT NULL DEFAULT '{}',
  rule_refs                   text[] NOT NULL DEFAULT '{}',
  emitter_version             text,
  resolver_version            text,
  composer_version            text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
```

Note: `property_id` is added to `derivation_records` (not in architecture §4.6's literal schema) so the tenant-isolation gate can scope this table cleanly. This is consistent with §4.6 which says the table is annotated `@tenant-scoped-via property_id`.

### 2. Add indexes

Per architecture §4.2 (resolver queries) and §5.5.7 (partial index for active claims):

```sql
-- Resolver query: "find claims for (property, subject, predicate) ordered by valid_from"
CREATE INDEX idx_claims_pspf
  ON warehouse.claims (property_id, subject, predicate, valid_from);

-- §5.5.7 partial index: "find currently-active claims" (most common applier query)
CREATE INDEX idx_claims_open
  ON warehouse.claims (property_id, subject, predicate)
  WHERE valid_to IS NULL;

-- Lookup by source document (for "all claims from this extraction")
CREATE INDEX idx_claims_source_document
  ON warehouse.claims (source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Closures by target (audit trail "what closed this claim?")
CREATE INDEX idx_closures_target
  ON warehouse.claim_closures (target_claim_id);

-- Derivation records: GIN index on input_claim_ids per §4.6
CREATE INDEX idx_derivation_input_claims
  ON warehouse.derivation_records USING GIN (input_claim_ids);

-- Derivation records: lookup by output (for "what derived this claim?")
CREATE INDEX idx_derivation_output
  ON warehouse.derivation_records (output_type, output_id);

-- Tenant scope index for derivation_records
CREATE INDEX idx_derivation_property
  ON warehouse.derivation_records (property_id);
```

### 3. Immutability + GoBD triggers

Per architecture §4.3 (claims are append-only), §4.6 (derivation_records append-only), §5.5.4 (closure rows are audit log):

```sql
-- Block UPDATE on claims, EXCEPT on the supersession columns
CREATE OR REPLACE FUNCTION warehouse.claims_block_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow only updates that set valid_to / superseded_at / superseded_by_claim_id
  -- when transitioning from NULL to non-NULL (one-way supersession).
  IF (NEW.id IS DISTINCT FROM OLD.id) OR
     (NEW.property_id IS DISTINCT FROM OLD.property_id) OR
     (NEW.subject IS DISTINCT FROM OLD.subject) OR
     (NEW.predicate IS DISTINCT FROM OLD.predicate) OR
     (NEW.value IS DISTINCT FROM OLD.value) OR
     (NEW.claim_kind IS DISTINCT FROM OLD.claim_kind) OR
     (NEW.source_type IS DISTINCT FROM OLD.source_type) OR
     (NEW.valid_from IS DISTINCT FROM OLD.valid_from) OR
     (NEW.source_document_id IS DISTINCT FROM OLD.source_document_id) OR
     (NEW.source_extraction_run_id IS DISTINCT FROM OLD.source_extraction_run_id) OR
     (NEW.source_field_path IS DISTINCT FROM OLD.source_field_path) OR
     (NEW.human_actor_id IS DISTINCT FROM OLD.human_actor_id) OR
     (NEW.confidence IS DISTINCT FROM OLD.confidence) OR
     (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id) OR
     (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'warehouse.claims is append-only; only valid_to, superseded_at, and superseded_by_claim_id may be updated (and only from NULL to non-NULL)';
  END IF;

  -- Supersession columns are one-way: NULL → value, never value → NULL or value → other-value
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'warehouse.claims.valid_to is immutable once set';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'warehouse.claims.superseded_at is immutable once set';
  END IF;
  IF OLD.superseded_by_claim_id IS NOT NULL AND NEW.superseded_by_claim_id IS DISTINCT FROM OLD.superseded_by_claim_id THEN
    RAISE EXCEPTION 'warehouse.claims.superseded_by_claim_id is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_block_update_trigger
  BEFORE UPDATE ON warehouse.claims
  FOR EACH ROW EXECUTE FUNCTION warehouse.claims_block_update();

-- Block DELETE on claims (GoBD)
CREATE OR REPLACE FUNCTION warehouse.claims_block_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.claims is append-only; DELETE not permitted (GoBD compliance)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_block_delete_trigger
  BEFORE DELETE ON warehouse.claims
  FOR EACH ROW EXECUTE FUNCTION warehouse.claims_block_delete();

-- Block UPDATE and DELETE on claim_closures (it's an audit log)
CREATE OR REPLACE FUNCTION warehouse.claim_closures_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.claim_closures is append-only audit log; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_closures_block_update
  BEFORE UPDATE ON warehouse.claim_closures
  FOR EACH ROW EXECUTE FUNCTION warehouse.claim_closures_block_modify();

CREATE TRIGGER claim_closures_block_delete
  BEFORE DELETE ON warehouse.claim_closures
  FOR EACH ROW EXECUTE FUNCTION warehouse.claim_closures_block_modify();

-- Block UPDATE and DELETE on derivation_records (audit log)
CREATE OR REPLACE FUNCTION warehouse.derivation_records_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'warehouse.derivation_records is append-only; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER derivation_records_block_update
  BEFORE UPDATE ON warehouse.derivation_records
  FOR EACH ROW EXECUTE FUNCTION warehouse.derivation_records_block_modify();

CREATE TRIGGER derivation_records_block_delete
  BEFORE DELETE ON warehouse.derivation_records
  FOR EACH ROW EXECUTE FUNCTION warehouse.derivation_records_block_modify();
```

### 4. Apply the migration locally

After writing the migration file, apply it to the local Supabase dev database (or remote dev branch — match whatever the existing migration workflow uses):

```
supabase db reset --local   # if applicable
# OR
supabase migration up --local
# OR (if migrations are applied via psql / Prisma)
# psql ... -f supabase/migrations/<timestamp>_v2_claim_store.sql
```

Use whatever pattern the existing migrations use. If unclear, look at how `20260503120000_gobd_soft_delete.sql` was applied and follow the same pattern.

### 5. Add an integration test

Create `src/tests/v2-claim-store-migration.test.ts`. This test verifies the migration's contracts using the Supabase service-role client:

```typescript
// 1. INSERT a valid claim → succeeds, returns a UUID
// 2. INSERT a claim with invalid claim_kind → fails (CHECK constraint)
// 3. INSERT a claim with source_type='human_adjudication' but human_actor_id=NULL → fails
// 4. INSERT a claim with source_type='document_extraction' but source_extraction_run_id=NULL → fails
// 5. INSERT a claim with valid_to < valid_from → fails (CHECK constraint)
// 6. UPDATE the claim's value → fails (immutability trigger)
// 7. UPDATE the claim's valid_to (NULL → date) → succeeds (one-way supersession)
// 8. UPDATE the claim's valid_to again (date → other date) → fails (one-way only)
// 9. DELETE the claim → fails (GoBD trigger)
// 10. INSERT a claim_closure → succeeds
// 11. UPDATE the claim_closure → fails (audit log immutability)
// 12. INSERT a derivation_record → succeeds
// 13. DELETE a derivation_record → fails

// Cleanup: not allowed (GoBD). The test must be run against a disposable dev DB
// where the test can re-create the schema, OR claims/closures/derivation_records
// inserted by the test are tagged with a specific subject (e.g., "test:integration_<timestamp>")
// so they can be filtered out of production queries.
```

The test must use the existing service-role client wrapper if one exists, or import directly from `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY` from `.env`.

Run via: `npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts`

Expected output: `✓ 13 claim store migration assertions passed`

### 6. Update the tenant-isolation lint configuration

The `tools/tenant-isolation-lint/` checker (per `.github/workflows/tenant-isolation.yml`) needs to know that the new tables are tenant-scoped. Find the configuration the linter reads (look for a list of tenant-scoped tables, or a Prisma annotation list, or whatever pattern the repo uses).

For the v2 claim tables, all three are `@tenant-scoped-via property_id`:
- `warehouse.claims` — has `property_id` column
- `warehouse.claim_closures` — does NOT have property_id directly, but is tenant-scoped via the FK to `warehouse.claims.target_claim_id` (which has property_id). Annotate as `@tenant-scoped-via target_claim_id.property_id` if the linter supports indirect references; otherwise add a comment explaining the indirection.
- `warehouse.derivation_records` — has `property_id` column

If the linter requires Prisma model annotations, add commented-out placeholder models in `prisma/schema.prisma` with the appropriate `@tenant-scoped-via property_id` annotation. The tables themselves remain SQL-only; the Prisma stubs exist purely for the linter.

If unclear how the linter is configured, check `tools/tenant-isolation-lint/` source and the Prisma schema for examples of existing `warehouse.*` table annotations.

### 7. Update ARCHITECTURE_STATE.md

Extend the existing v2 section with:

- Three new tables in `warehouse.*` schema: `claims`, `claim_closures`, `derivation_records`
- Append-only by design: triggers block UPDATE (except one-way supersession on claims) and DELETE (GoBD)
- Indexes: composite index on `(property_id, subject, predicate, valid_from)`, partial index on open claims (`WHERE valid_to IS NULL`), GIN on `derivation_records.input_claim_ids`
- Tenant isolation: all three tables annotated `@tenant-scoped-via property_id` (directly or transitively)
- Migration: `supabase/migrations/<timestamp>_v2_claim_store.sql`
- Integration test: `src/tests/v2-claim-store-migration.test.ts`
- Status: schema live, no code yet writes claims (Phase 1 emitters do that)

### 8. Verify

Run the regression checks plus the new integration test:

```
# Regression
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx -r dotenv/config src/tests/schemas.test.ts
npm run gen:schemas:check

# New
npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts

# Tier 0 gates
# (these run in CI; locally check what's available)
```

Expected:
- All regression tests pass (no changes from prior tasks)
- The new claim-store test prints `✓ 13 claim store migration assertions passed`
- `npm run gen:schemas:check` still exits 0
- The migration file exists and was applied locally

### 9. Commit and push

Commit message: `v2: add claim store migration (claims, claim_closures, derivation_records) (Task 0.4)`

Push to main.

**Critical: this push will be the first one with branch protection enforced (no bypass).** The 3 status checks must pass. If any block:
- `architecture-state.yml` — fails if ARCHITECTURE_STATE.md isn't updated. Fix: ensure step 7 is committed.
- `migration-drift.yml` — fails if the migration file format / location doesn't match the existing pattern.
- `tenant-isolation.yml` — fails if the new tables aren't annotated correctly. Fix: ensure step 6 covers the new tables.

If a gate fails, the push is blocked entirely. Read the failure, fix the cause, recommit (amend if appropriate), push again.

## Acceptance gates (verify before reporting completion)

- `ls supabase/migrations/ | tail -3 | cat` shows the new migration file
- The migration applied locally without error
- `npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts` exits 0 with `✓ 13 claim store migration assertions passed`
- All 13 assertions in the integration test pass (constraints, triggers, immutability)
- All prior regression tests still pass
- All 3 CI status checks pass on the push (no bypass warning, no failed gate)
- `git log -1 --stat | cat` shows the commit landed with: migration SQL, integration test, ARCHITECTURE_STATE.md, tenant-isolation lint config update

## Constraints

- Do NOT add Prisma models for the claim tables. Tables are SQL-only, accessed via Supabase service-role client. (Optional: commented placeholder models for linter purposes only.)
- Do NOT skip the immutability trigger logic. The one-way supersession contract is load-bearing for the entire claim layer.
- Do NOT modify existing migrations. Add a new file with a later timestamp.
- Do NOT use `pnpm` or `yarn`.
- Do NOT install ajv or new validators.
- Do NOT bypass the branch protection rules. If the push is blocked, fix the issue.
- Pipe git commands through `| cat`.
