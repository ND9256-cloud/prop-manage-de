# Task 1.11 — Lena Everding fixture test (Phase 1 verification gate)

**Task type:** t1 S (test infrastructure, deterministic fixture, no production code change)

**Branch:** `feature/task-1.11-lena-fixture-test`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 1.11 acceptance criteria ("If this test passes, Phase 1 is done. If it doesn't, no further phases proceed until it does.")
- Task 1.7 (emitter), Task 1.8 (applier), Task 1.10 (resolver) — what this test exercises
- Existing test patterns: `src/tests/api/apply-emission.test.ts` (Task 1.9), `src/tests/claim-store/applier.test.ts` (Task 1.8) — both use `tx` rollback to avoid production residue

**Phase 1 gate criterion:** `rentForUnit({ property_id: KO132, unit_ref: "1.OG", org_id })` returns €650 deterministically, given a known envelope of Lena Everding's Mietvertrag, through the full emitter → applier → resolver chain.

---

## Scope

A single CI-runnable test that:

1. Loads a deterministic fixture envelope from `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json`.
2. Inserts a synthetic `warehouse.documents` row + the fixture envelope into `warehouse.document_extractions_v2` (inside a tx).
3. Runs the mietvertrag emitter on the envelope → asserts the EmissionResult contains 2 claims (kaltmiete €650, tenant_active "Everding, Lena").
4. Calls `applyEmission()` with the EmissionResult → asserts 2 claims land in `warehouse.claims`.
5. Calls `rentForUnit({ property_id, unit_ref: "1.OG", org_id })` → asserts `value.amount === 65000`, `value.currency === "EUR"`, `status === "single_active_claim"`, `confidence === "high"`.
6. Rolls back the transaction (test leaves no residue).

The source PDF is included for reference and future re-extraction parity tests, but **this test does not invoke OCR or Sonnet**. The envelope is the deterministic input; the pipeline upstream of emission is out of scope (covered by Edge Function smoke tests, not CI unit tests).

---

## Out of scope

- OCR / Sonnet invocation — too stochastic and expensive for CI
- The HTTP bridge route (`/api/pipeline/apply-emission`) — Task 1.9's own integration test covers that
- Multi-claim conflict scenarios — Task 1.10's resolver tests cover those
- Other doc types — separate fixtures land per their tasks
- Re-extraction parity (assert that re-running OCR + Sonnet today still produces an envelope matching expected.json) — defer until we have a way to pin Sonnet behavior cheaply

---

## Files touched

- `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf` — the actual Lena Mietvertrag PDF (already in Supabase storage; we copy it here for reproducibility). ~8MB binary.
- `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json` — the deterministic envelope, copied from production extraction_run_id `883934f6-5367-4575-98ea-a692da4f66f6` (the Lena envelope that produced the correct €650 claims in Task 1.9's verification). Includes the full `fields` and `lifecycle` JSONB.
- `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/README.md` — short note explaining what this fixture is and how it was generated.
- `src/tests/integration/everding-end-to-end.test.ts` — the test itself.
- `ARCHITECTURE_STATE.md` — append "Phase 1 closed" note.

**NOT touched:**
- Production code under `src/lib/*` — this task is test-only
- Existing test files
- DB schema, Edge Function, API routes

---

## Repo conventions (recap)

- npm (not pnpm), tsc clean, lint clean
- Tests run via `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- Branch protection on main, feature branch + PR
- Single descriptive commit per PR
- The fixture PDF is binary — commit it directly (no LFS for an 8MB file)

---

## Step 1 — Acquire fixture PDF and envelope

Pull the source PDF from Supabase storage (the file_name we saw earlier: `20250208_Lena Everding MV_signed.pdf`, storage_path `310131df-d6ed-4007-83c2-ac69a7e9df42/f7c3e663-11bf-4b91-947c-9136df9eefae/20250208_Lena_Everding_MV_signed.pdf` — verify the exact path before download):

```bash
mkdir -p tests/fixtures/extraction/mietvertrag/everding-ko132-1og
cd ~/repos/property-management-saas

# Download PDF from Supabase storage to fixture path
cat > /tmp/fetch-fixture.js << 'EOF'
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  // First find the exact storage path
  const docRes = await c.schema('warehouse').from('documents')
    .select('storage_path')
    .eq('id', 'f7c3e663-11bf-4b91-947c-9136df9eefae')
    .single();
  const path = docRes.data.storage_path;
  console.log('storage_path:', path);
  const dl = await c.storage.from('documents').download(path);
  if (dl.error) { console.error('download error:', dl.error); return; }
  const buf = Buffer.from(await dl.data.arrayBuffer());
  fs.writeFileSync('tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf', buf);
  console.log('wrote', buf.length, 'bytes');
})();
EOF
node /tmp/fetch-fixture.js
rm /tmp/fetch-fixture.js
ls -la tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf
```

The bucket name (`documents` above) needs to match the actual storage bucket — if different (e.g. `warehouse-documents`), adjust. Probe `supabase storage ls` to confirm if needed.

Pull the envelope from `warehouse.document_extractions_v2` for extraction_run_id `883934f6-5367-4575-98ea-a692da4f66f6` (the canonical Lena envelope) and write to `expected.json`:

```bash
cat > /tmp/fetch-envelope.js << 'EOF'
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'warehouse' } });
(async () => {
  const res = await c.from('document_extractions_v2')
    .select('doc_type, schema_version, prompt_version, model, fields, lifecycle')
    .eq('extraction_run_id', '883934f6-5367-4575-98ea-a692da4f66f6')
    .single();
  if (res.error) { console.error(res.error); return; }
  fs.writeFileSync(
    'tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json',
    JSON.stringify(res.data, null, 2)
  );
  console.log('wrote envelope');
})();
EOF
node /tmp/fetch-envelope.js
rm /tmp/fetch-envelope.js
cat tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json | head -30
```

The expected.json must contain at minimum: `doc_type: "mietvertrag"`, `schema_version: "2026-05-21-v1"`, `fields.kaltmiete.normalized_value = { amount: 65000, currency: "EUR" }`, `fields.unit_ref.normalized_value = "1.OG"`, `fields.tenant_identity.normalized_value.name = "Everding, Lena"`, `fields.mietbeginn.normalized_value = "2025-04-01"`. The test asserts these explicitly.

---

## Step 2 — Fixture README

Create `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/README.md`:

```markdown
# Everding KO132 1.OG — Phase 1 verification fixture

The canonical Mietvertrag for verifying the v2 extraction pipeline end-to-end.

**Source document:** `20250208_Lena Everding MV_signed.pdf`
**Property:** KO132 (Korbacher Straße 132, Schauenburg), unit 1.OG
**Tenant:** Everding, Lena
**Kaltmiete:** €650 / month
**Lease start:** 2025-04-01 (open-ended)

## Files

- `source.pdf` — the original signed Mietvertrag, 8.2 MB
- `expected.json` — the deterministic v2 envelope produced by Sonnet against
  this PDF on extraction_run_id `883934f6-5367-4575-98ea-a692da4f66f6`,
  schema_version `2026-05-21-v1`

## Updating the fixture

Re-extracting this PDF produces an envelope with new UUIDs but the same
`fields.*` content (modulo Sonnet stochasticity on edge fields). If the schema
version changes or extraction logic materially changes, regenerate:

1. Trigger a re-extraction (insert a row into `warehouse.processing_jobs`)
2. Pull the new envelope from `warehouse.document_extractions_v2`
3. Diff against `expected.json`; if material differences are intentional,
   replace expected.json.

## What this fixture verifies

The Phase 1 gate test (`src/tests/integration/everding-end-to-end.test.ts`)
feeds `expected.json` through emitter → applier → resolver and asserts the
resolver returns €650 with `single_active_claim` status. If the test fails,
Phase 1 is broken and must be fixed before any Phase 2 work proceeds.
```

---

## Step 3 — The test

Create `src/tests/integration/everding-end-to-end.test.ts`:

```typescript
// Phase 1 verification gate.
//
// Runs the full v2 chain on a known, deterministic fixture:
//   expected.json envelope → emitter → applier → resolver → €650
//
// If this test fails, Phase 1 is broken. No further phases proceed.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
//     src/tests/integration/everding-end-to-end.test.ts
//
// Required env:
//   - DATABASE_URL (or whatever the project's db.ts reads)
//   - TEST_ORG_ID, TEST_PROPERTY_ID (or hardcoded fallbacks for known test fixtures)
//   - PIPELINE_INTERNAL_SECRET (not used by this test directly; just env hygiene)

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../lib/db";
import { emitMietvertragClaims } from "../../lib/emitters/mietvertrag";
import { applyEmission } from "../../lib/claim-store/applier";
import { rentForUnit } from "../../lib/resolvers/rent-for-unit";
import type { ApplyContext } from "../../lib/claim-store/types";

const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "extraction",
  "mietvertrag",
  "everding-ko132-1og",
  "expected.json"
);

let passed = 0;
function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

async function getTestPropertyId(): Promise<string> {
  // @tenant-isolation-disable-next-line -- reason: test bootstrap fetching property id for end-to-end test, org-scoped by TEST_ORG_ID constant
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Property"
    WHERE "organizationId" = ${TEST_ORG_ID}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No test property found for org ${TEST_ORG_ID}`);
  return rows[0].id;
}

async function run() {
  console.log("Phase 1 verification gate — Everding KO132 1.OG\n");

  const envelope = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  const property_id = await getTestPropertyId();

  // --- Fixture sanity: assert the envelope itself is what we expect ---------
  ok(envelope.doc_type === "mietvertrag", "envelope.doc_type === mietvertrag");
  ok(envelope.schema_version === "2026-05-21-v1", "envelope.schema_version === 2026-05-21-v1");
  ok(
    envelope.fields?.kaltmiete?.normalized_value?.amount === 65000,
    "envelope.fields.kaltmiete.normalized_value.amount === 65000"
  );
  ok(
    envelope.fields?.kaltmiete?.normalized_value?.currency === "EUR",
    "envelope.fields.kaltmiete.normalized_value.currency === EUR"
  );
  ok(
    envelope.fields?.unit_ref?.normalized_value === "1.OG",
    "envelope.fields.unit_ref.normalized_value === 1.OG"
  );
  ok(
    envelope.fields?.tenant_identity?.normalized_value?.name === "Everding, Lena",
    "envelope.fields.tenant_identity.normalized_value.name === Everding, Lena"
  );
  ok(
    envelope.fields?.mietbeginn?.normalized_value === "2025-04-01",
    "envelope.fields.mietbeginn.normalized_value === 2025-04-01"
  );

  // --- The integration test: tx-wrapped, rolled back at end ----------------
  let resolverResult: any = null;

  await prisma
    .$transaction(async (tx) => {
      // Synthetic IDs for this run (different from any real prod IDs)
      const source_document_id = randomUUID();
      const extraction_run_id = randomUUID();

      // 1. Insert a synthetic warehouse.documents row referencing the test property
      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${source_document_id}::uuid, ${TEST_ORG_ID}::uuid, ${property_id}::uuid,
          'mietvertrag', 'everding-fixture.pdf', ${"test/" + source_document_id + "/everding-fixture.pdf"},
          ${"phase1-test-" + source_document_id}, 8265123, 'application/pdf',
          'test', 'de', 'applied'
        )
      `;

      // 2. Insert the synthetic envelope (the fixture envelope, with new IDs)
      await tx.$executeRaw`
        INSERT INTO warehouse.document_extractions_v2 (
          source_document_id, doc_type, schema_version, prompt_version, model,
          extraction_run_id, fields, lifecycle, human_review_status
        ) VALUES (
          ${source_document_id}::uuid, ${envelope.doc_type}, ${envelope.schema_version},
          ${envelope.prompt_version ?? envelope.schema_version}, ${envelope.model ?? "test-fixture"},
          ${extraction_run_id}::uuid,
          ${JSON.stringify(envelope.fields)}::jsonb,
          ${JSON.stringify(envelope.lifecycle ?? {})}::jsonb,
          'not_reviewed'
        )
      `;

      // 3. Run the emitter
      const emissionResult = emitMietvertragClaims(
        {
          doc_type: envelope.doc_type,
          schema_version: envelope.schema_version,
          fields: envelope.fields,
          lifecycle: envelope.lifecycle ?? {},
        } as any,
        {
          property_id,
          source_document_id,
          source_extraction_run_id: extraction_run_id,
          evidence_id_for_field: () => null,
        }
      );

      ok(
        emissionResult.claims_to_insert.length === 2,
        "emitter produced 2 claims (kaltmiete + tenant_active)"
      );
      ok(
        emissionResult.closure_intents.length === 0,
        "emitter produced 0 closure intents for mietvertrag"
      );

      const kaltmieteClaim = emissionResult.claims_to_insert.find(
        (c) => c.predicate === "kaltmiete"
      );
      const tenantClaim = emissionResult.claims_to_insert.find(
        (c) => c.predicate === "tenant_active"
      );
      ok(kaltmieteClaim !== undefined, "emitter emitted a kaltmiete claim");
      ok(tenantClaim !== undefined, "emitter emitted a tenant_active claim");
      ok(
        (kaltmieteClaim?.value as any)?.amount === 65000,
        "kaltmiete claim value.amount === 65000"
      );
      ok(
        kaltmieteClaim?.subject === "unit:1.OG",
        "kaltmiete claim subject === unit:1.OG"
      );
      ok(
        (tenantClaim?.value as any)?.tenants?.[0]?.name === "Everding, Lena",
        "tenant_active claim value.tenants[0].name === Everding, Lena"
      );

      // 4. Run the applier
      const applyContext: ApplyContext = {
        property_id,
        org_id: TEST_ORG_ID,
        extraction_run_id,
        emitter_version: "1.0.0",
      };
      const applyResult = await applyEmission(emissionResult, applyContext, { tx });

      ok(
        applyResult.inserted_claim_ids.length === 2,
        "applier inserted 2 claims into warehouse.claims"
      );
      ok(
        applyResult.applied_closure_ids.length === 0,
        "applier applied 0 closures"
      );
      ok(
        applyResult.blocked_closure_intents.length === 0,
        "applier had 0 blocked closure intents"
      );
      ok(
        applyResult.derivation_record_ids.length === 2,
        "applier wrote 2 derivation records (1 per claim)"
      );

      // 5. Run the resolver
      resolverResult = await rentForUnit(
        {
          property_id,
          unit_ref: "1.OG",
          org_id: TEST_ORG_ID,
        },
        { tx }
      );

      ok(
        resolverResult.value?.amount === 65000,
        "rentForUnit returns value.amount === 65000"
      );
      ok(
        resolverResult.value?.currency === "EUR",
        "rentForUnit returns value.currency === EUR"
      );
      ok(
        resolverResult.status === "single_active_claim",
        "rentForUnit status === single_active_claim"
      );
      ok(
        resolverResult.confidence === "high",
        "rentForUnit confidence === high"
      );
      ok(
        resolverResult.source_claim_ids.length === 1,
        "rentForUnit source_claim_ids has exactly 1 entry"
      );
      ok(
        resolverResult.conflicts.length === 0,
        "rentForUnit conflicts is empty"
      );
      ok(
        resolverResult.resolver.name === "rent_for_unit",
        "rentForUnit.resolver.name === rent_for_unit"
      );

      // Force rollback to keep production tables clean
      throw new Error("rollback");
    })
    .catch((e: any) => {
      if (e.message !== "rollback") throw e;
    });

  console.log(`\n✓ ${passed} Phase 1 gate assertions passed`);
  console.log(`✓ Phase 1 success criterion: rent_for_unit(KO132, 1.OG) = €650 verified`);
}

run()
  .catch((err) => {
    console.error(`\n✗ FAILED after ${passed} assertions:`, err.message);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
```

**Path imports:** the test uses relative paths (`../../lib/...`) rather than `@/lib/...` because tsx with `dotenv/config` doesn't reliably resolve `@/` paths in some configurations. Verify against the existing test files' import style (Task 1.8's `applier.test.ts` uses `../../lib/db` — same pattern).

**`__dirname` works under tsx**. If the runtime complains (ESM mode), substitute `new URL(".", import.meta.url).pathname`.

---

## Step 4 — ARCHITECTURE_STATE.md update

Append:

```markdown
## Phase 1: CLOSED (Task 1.11, 2026-05-27)

Phase 1 of the v2 extraction architecture is complete. The full chain —
extraction envelope → claim emission → applier with closure handling →
resolver — works end-to-end for the Mietvertrag doc type.

**Phase 1 deliverables:**
- Task 1.7: pure Mietvertrag claim emitter
- Task 1.8: transaction applier with closure semantics
- Task 1.9: Edge Function ↔ Node bridge via /api/pipeline/apply-emission
- Task 1.10: rent_for_unit resolver
- Task 1.11: Everding KO132 1.OG end-to-end fixture test (Phase 1 gate)

**The Phase 1 gate test** (`src/tests/integration/everding-end-to-end.test.ts`)
runs the full chain against a deterministic fixture envelope. If this test
ever fails, Phase 1 is broken and must be fixed before any Phase 2 work.
Failing gate ⇒ rollback the breaking change.

**Phase 1 success criterion verified:**
`rentForUnit({ property_id: KO132, unit_ref: "1.OG" })` returns
`{ amount: 65000, currency: "EUR" }`, `status: "single_active_claim"`,
`confidence: "high"`.

**Next:** Phase 2 — extend to other doc types (Mieterhöhung, Kündigung,
Übergabeprotokoll, Eigentümerwechsel) per the closing-matrix pattern.
Each new doc type ships its own schema, prompt, emitter, and verifier; the
applier and resolver are reused without change.
```

---

## Step 5 — Verify locally

```bash
cd ~/repos/property-management-saas
git pull
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/integration/everding-end-to-end.test.ts | tail -30
```

Expected last lines:
```
✓ N Phase 1 gate assertions passed
✓ Phase 1 success criterion: rent_for_unit(KO132, 1.OG) = €650 verified
```

Then run the full existing suite to confirm no regression:

```bash
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" | tail -3 || break
done
```

---

## Step 6 — PR

```bash
git checkout -b feature/task-1.11-lena-fixture-test
git add tests/fixtures/extraction/mietvertrag/everding-ko132-1og/ \
        src/tests/integration/everding-end-to-end.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "test(phase-1-gate): add Everding KO132 1.OG end-to-end fixture test (Task 1.11)

Deterministic Phase 1 gate. Loads a known mietvertrag envelope, runs the full
chain emitter → applier → resolver, asserts rentForUnit returns €650 with
single_active_claim status. Rolls back the transaction so no production residue.

- tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf
  the actual Lena Mietvertrag PDF (~8MB)
- tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json
  the canonical envelope from production extraction_run_id 883934f6-...
- tests/fixtures/extraction/mietvertrag/everding-ko132-1og/README.md
  fixture documentation
- src/tests/integration/everding-end-to-end.test.ts
  the gate test
- ARCHITECTURE_STATE.md: Phase 1 CLOSED section"
git push -u origin feature/task-1.11-lena-fixture-test
```

PR via:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-1.11-lena-fixture-test
```

---

## Definition of done

- [ ] Fixture PDF saved at `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf`
- [ ] Fixture envelope saved at `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json`
- [ ] Fixture README saved alongside
- [ ] Test file `src/tests/integration/everding-end-to-end.test.ts` present
- [ ] Test reports ≥20 assertions, all OK
- [ ] `tsc --noEmit` clean
- [ ] Branch pushed, PR opened, CI green
- [ ] ARCHITECTURE_STATE.md updated with Phase 1 CLOSED note
- [ ] PR merged
- [ ] **Phase 1 closed.** This is the gate. After merge, Phase 2 is unblocked.

---

## Notes for reviewer

**Test is not a re-extraction test.** It asserts the chain from envelope onward, not the OCR/Sonnet stage. Asserting Sonnet output matches a frozen fixture would be brittle: model versions drift, prompts get tweaked, edge fields legitimately vary. The envelope is the contract between extraction and the rest of the pipeline. Anything upstream of that is covered by Edge Function smoke tests, not unit tests.

**The fixture envelope is real, not synthesized.** It came from production (extraction_run_id `883934f6-5367-4575-98ea-a692da4f66f6`), the same envelope that produced the correct €650 claims in Task 1.9's live verification. Using a real envelope means the test reflects what Sonnet actually produces today; if Sonnet behavior drifts materially, regenerate the fixture per the README's update instructions.

**tx-rollback pattern, not test schema.** Same trade as Task 1.8 and Task 1.9 integration tests: insert into real `warehouse.*` tables, roll back the transaction, no residue. Cheaper than a test schema, doesn't require a migration, doesn't accumulate test data over time. The cost is that tests are sequential rather than parallel-safe, which is fine at our scale.

**`source.pdf` is 8MB committed binary.** Some teams use git LFS for files this size. For now, a one-time 8MB commit is cheaper than the LFS setup cost. If we accumulate many large fixtures, revisit.

**Phase 1 CLOSED is a soft commitment, not a freeze.** Future work CAN touch the emitter/applier/resolver code; the gate test ensures regressions are caught. The semantic of "Phase 1 closed" is: Phase 2 work is now unblocked, the pattern is proven, and the next doc types follow the same template.
