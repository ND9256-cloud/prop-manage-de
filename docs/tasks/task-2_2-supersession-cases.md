# Task 2.2 — Supersession cases end-to-end test (Paul + Kuru + Weber)

**Task type:** t1 M (deterministic integration test, no production code change; multiple fixture envelopes)

**Branch:** `feature/task-2.2-supersession-cases`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.2 acceptance criteria ("Weber-bug-resolution gate")
- Task 1.11 — Lena Everding fixture pattern (the template this task follows)
- Task 2.1 (just shipped) — Mieterhöhung emitter
- Task 1.7 — Mietvertrag emitter
- Task 1.8 — claim-store applier (handles close_overlapping_only)
- Task 1.10 — rent_for_unit resolver
- Architecture §5.5.2 (closing matrix), §5.5.3 (three close_modes), §5.2 (resolver algorithm)

**Phase 2 success criterion this task delivers:** the supersession chain — Mietvertrag claim → Mieterhöhung supersedes it → resolver returns new rent for today, old rent for historical dates — works end-to-end for three independent fixtures. **This is the Weber-bug-resolution gate.** If this test passes, the architectural fix for the original bug is verified.

---

## Scope

A single CI-runnable test (`src/tests/integration/supersession-cases.test.ts`) that runs three independent cases inside its own rollback transaction. For each case:

1. Insert synthetic Mietvertrag envelope → run emitter → run applier → assert 1 kaltmiete claim live with the OLD amount
2. Insert synthetic Mieterhöhung envelope → run emitter → run applier → assert: NEW kaltmiete claim live with new amount, OLD claim has `valid_to = effective_date - 1`, closure applied
3. Call `rentForUnit({ as_of_date: today })` → assert returns NEW amount, `status === "single_active_claim"`
4. Call `rentForUnit({ as_of_date: <date_before_effective_date> })` → assert returns OLD amount, `status === "single_active_claim"`
5. Rollback (no production residue)

Three cases:
- **Paul** at KO132, unit EG: €525 → €575 effective 2024-01-01
- **Kuru** at KO132, unit DG: €440 → €470 effective 2024-09-01
- **Weber** at HHS55, unit OG: €900 → €1,000 effective 2024-04-01 (the original bug case)

All envelopes are **synthetic JSON fixtures** committed under `tests/fixtures/extraction/supersession/`. We do NOT need real PDFs or real production extraction runs — this test verifies the chain logic from envelope onward (Sonnet accuracy is out of scope; covered by Phase 0 verifier tests + Task 1.11's Lena fixture).

---

## Out of scope

- OCR / Sonnet invocation — synthetic envelopes, no LLM calls in this test
- Multi-tenant cases (multiple tenants on same lease)
- Staffelmiete blocker scenarios — covered by emitter unit tests (Task 2.1 Scenario 3)
- Mieterhöhung with missing prerequisites (no signatures, draft status) — emitter unit tests cover this
- Übergabeprotokoll, Eigentümerwechsel, Kündigung — separate later tasks
- Updating any production code under `src/lib/*` — this is test-only

---

## Files touched

Three fixture directories with three files each, plus the test, plus ARCHITECTURE_STATE.md:

- `tests/fixtures/extraction/supersession/paul-ko132-eg/mietvertrag.json`
- `tests/fixtures/extraction/supersession/paul-ko132-eg/mieterhoehung.json`
- `tests/fixtures/extraction/supersession/paul-ko132-eg/README.md`
- `tests/fixtures/extraction/supersession/kuru-ko132-dg/mietvertrag.json`
- `tests/fixtures/extraction/supersession/kuru-ko132-dg/mieterhoehung.json`
- `tests/fixtures/extraction/supersession/kuru-ko132-dg/README.md`
- `tests/fixtures/extraction/supersession/weber-hhs55-og/mietvertrag.json`
- `tests/fixtures/extraction/supersession/weber-hhs55-og/mieterhoehung.json`
- `tests/fixtures/extraction/supersession/weber-hhs55-og/README.md`
- `src/tests/integration/supersession-cases.test.ts` — the test
- `ARCHITECTURE_STATE.md` — append Task 2.2 section

**NOT touched:**
- Production code under `src/lib/*`
- Other tests
- Schemas, domain knowledge files
- DB schema
- Edge Function

---

## Repo conventions (recap)

- npm, tsc clean, lint clean
- Tests run via `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- Test directory `src/tests/integration/` is already allowlisted for raw SQL (added in Task 1.11's CI fix)
- tx-rollback pattern from Task 1.8, 1.11
- Single descriptive commit per PR

---

## Step 1 — Verify property IDs and unit_refs

Quick probe before drafting fixtures. The test needs to know the real test property IDs for KO132 and HHS55, plus the unit_refs that should match.

```bash
cd ~/repos/property-management-saas
cat > probe-props.cjs << 'EOF'
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env.local' });
const prisma = new PrismaClient();
(async () => {
  const props = await prisma.$queryRaw`
    SELECT id, name, "organizationId"
    FROM "Property"
    WHERE "organizationId" = '310131df-d6ed-4007-83c2-ac69a7e9df42'::uuid
    ORDER BY name
  `;
  console.log(JSON.stringify(props, null, 2));
  await prisma.$disconnect();
})();
EOF
node probe-props.cjs
rm probe-props.cjs
```

Expected: KO132 at `f37448e4-11ae-453c-ac3c-850385039c0b` and HHS55 at `d2e8e9c7-957a-4e0f-8150-452c21bcae56`. Confirm and **substitute the actual IDs into the test file before running.**

For unit_ref values: Paul is at KO132 EG; Kuru is at KO132 DG; Weber/Bonsmann is at HHS55 OG. These are conventions from existing claims; if you find different unit_refs in the actual KO132/HHS55 properties, adjust the fixtures and test accordingly.

---

## Step 2 — Fixture files

Each pair (mietvertrag.json, mieterhoehung.json) is a hand-written envelope that matches the existing schema versions. Use Lena's `expected.json` as the structural template — same shape, same fields, different values.

### Paul, KO132 EG: `tests/fixtures/extraction/supersession/paul-ko132-eg/mietvertrag.json`

```json
{
  "doc_type": "mietvertrag",
  "schema_version": "2026-05-21-v1",
  "prompt_version": "2026-05-21-v1",
  "model": "synthetic-fixture",
  "fields": {
    "kaltmiete": {
      "normalized_value": { "amount": 52500, "currency": "EUR", "raw_value": "525,00 €" },
      "absence_state": null,
      "confidence": "high"
    },
    "unit_ref": {
      "normalized_value": "EG",
      "absence_state": null,
      "confidence": "high"
    },
    "tenant_identity": {
      "normalized_value": { "name": "Paul, Friedrich", "is_legal_entity": false, "legal_form": null },
      "absence_state": null,
      "confidence": "high"
    },
    "mietbeginn": {
      "normalized_value": "2022-03-01",
      "absence_state": null,
      "confidence": "high"
    },
    "landlord_signature_present": {
      "normalized_value": true,
      "absence_state": null,
      "confidence": "high"
    },
    "tenant_signature_present": {
      "normalized_value": true,
      "absence_state": null,
      "confidence": "high"
    }
  },
  "lifecycle": {}
}
```

If the actual mietvertrag schema requires additional fields (kaution, nebenkostenvorauszahlung, mietende, landlord_identity), include them with appropriate `absence_state: "absent"` markers. Check Lena's `expected.json` for the canonical field set.

### Paul, KO132 EG: `tests/fixtures/extraction/supersession/paul-ko132-eg/mieterhoehung.json`

```json
{
  "doc_type": "mieterhoehung",
  "schema_version": "2026-05-27-v1",
  "prompt_version": "2026-05-27-v1",
  "model": "synthetic-fixture",
  "fields": {
    "new_kaltmiete": {
      "normalized_value": { "amount": 57500, "currency": "EUR", "raw_value": "575,00 €" },
      "absence_state": null,
      "confidence": "high"
    },
    "previous_kaltmiete": {
      "normalized_value": { "amount": 52500, "currency": "EUR", "raw_value": "525,00 €" },
      "absence_state": null,
      "confidence": "high"
    },
    "effective_date": {
      "normalized_value": "2024-01-01",
      "absence_state": null,
      "confidence": "high"
    },
    "notice_date": {
      "normalized_value": "2023-09-15",
      "absence_state": null,
      "confidence": "high"
    },
    "unit_ref": {
      "normalized_value": "EG",
      "absence_state": null,
      "confidence": "high"
    },
    "tenant_identity": {
      "normalized_value": { "name": "Paul, Friedrich", "is_legal_entity": false, "legal_form": null },
      "absence_state": null,
      "confidence": "high"
    },
    "landlord_signature_present": {
      "normalized_value": true,
      "absence_state": null,
      "confidence": "high"
    },
    "tenant_signature_present": {
      "normalized_value": false,
      "absence_state": null,
      "confidence": "high"
    },
    "document_status": {
      "normalized_value": "signed",
      "absence_state": null,
      "confidence": "high"
    },
    "rechtsgrundlage": {
      "normalized_value": "§558",
      "absence_state": null,
      "confidence": "high"
    },
    "nachtrag_typ": {
      "normalized_value": "mieterhoehung",
      "absence_state": null,
      "confidence": "high"
    },
    "staffelmiete_context": {
      "normalized_value": false,
      "absence_state": null,
      "confidence": "high"
    }
  },
  "lifecycle": {}
}
```

### Kuru, KO132 DG: same structure

`tests/fixtures/extraction/supersession/kuru-ko132-dg/mietvertrag.json`:
- kaltmiete: 44000 / "440,00 €"
- unit_ref: "DG"
- tenant_identity: { name: "Kuru, Mehmet", is_legal_entity: false, legal_form: null }
- mietbeginn: "2020-11-01"
- both signatures present

`tests/fixtures/extraction/supersession/kuru-ko132-dg/mieterhoehung.json`:
- new_kaltmiete: 47000 / "470,00 €"
- previous_kaltmiete: 44000 / "440,00 €"
- effective_date: "2024-09-01"
- notice_date: "2024-05-15"
- unit_ref: "DG"
- tenant_identity: { name: "Kuru, Mehmet", ... }
- landlord_signature_present: true
- tenant_signature_present: false
- document_status: "signed"
- rechtsgrundlage: "§558"
- nachtrag_typ: "mieterhoehung"
- staffelmiete_context: false

### Weber, HHS55 OG: same structure (the original bug case)

`tests/fixtures/extraction/supersession/weber-hhs55-og/mietvertrag.json`:
- kaltmiete: 90000 / "900,00 €"
- unit_ref: "OG"
- tenant_identity: { name: "Weber, Anna", is_legal_entity: false, legal_form: null }
- mietbeginn: "2018-06-01"
- both signatures present

`tests/fixtures/extraction/supersession/weber-hhs55-og/mieterhoehung.json`:
- new_kaltmiete: 100000 / "1.000,00 €"
- previous_kaltmiete: 90000 / "900,00 €"
- effective_date: "2024-04-01"
- notice_date: "2023-12-20"
- unit_ref: "OG"
- tenant_identity: { name: "Weber, Anna", ... }
- landlord_signature_present: true
- tenant_signature_present: false
- document_status: "signed"
- rechtsgrundlage: "§558"
- nachtrag_typ: "mieterhoehung"
- staffelmiete_context: false

### Per-fixture README.md

Short, three sections: who/where/why, the supersession scenario, and what the test asserts.

For Paul:
```markdown
# Paul Mieterhöhung supersession fixture

**Property:** KO132 (Korbacher Straße 132), unit EG
**Tenant:** Paul, Friedrich
**Lease start:** 2022-03-01
**Rent history:** €525 → €575 effective 2024-01-01 (§558)

## Scenario

Tests the supersession chain. Original Mietvertrag emits a kaltmiete claim
of €525. A subsequent Mieterhöhung emits a new kaltmiete claim of €575 plus
a `close_overlapping_only` closure intent that sets `valid_to = 2023-12-31`
on the original claim.

Resolver assertions:
- `rentForUnit(today)` returns €575 (single_active_claim, the new one)
- `rentForUnit("2023-06-01")` returns €525 (single_active_claim, the
  original — its `valid_to` is after this date)
```

Adapt for Kuru and Weber.

---

## Step 3 — The test

`src/tests/integration/supersession-cases.test.ts`. Follow Task 1.11's structure but parameterized over the three cases.

```typescript
// Phase 2 supersession gate — Weber-bug-resolution test.
//
// For each of three cases (Paul, Kuru, Weber):
//   1. emit Mietvertrag claims via emitMietvertragClaims + applyEmission
//   2. emit Mieterhöhung claims via emitMieterhoehungClaims + applyEmission
//   3. assert resolver returns new rent for today
//   4. assert resolver returns old rent for a date before effective_date
//
// All inside a tx that's rolled back at the end.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
//     src/tests/integration/supersession-cases.test.ts

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../lib/db";
import { emitMietvertragClaims } from "../../lib/emitters/mietvertrag";
import { emitMieterhoehungClaims } from "../../lib/emitters/mieterhoehung";
import { applyEmission } from "../../lib/claim-store/applier";
import { rentForUnit } from "../../lib/resolvers/rent-for-unit";
import type { ApplyContext } from "../../lib/claim-store/types";

const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";
const KO132_ID = process.env.KO132_ID || "f37448e4-11ae-453c-ac3c-850385039c0b";
const HHS55_ID = process.env.HHS55_ID || "d2e8e9c7-957a-4e0f-8150-452c21bcae56";

const FIXTURE_ROOT = join(__dirname, "..", "..", "..", "tests", "fixtures", "extraction", "supersession");

interface SupersessionCase {
  name: string;
  property_id: string;
  unit_ref: string;
  oldAmount: number;
  newAmount: number;
  effective_date: string;       // YYYY-MM-DD
  historical_query_date: string; // YYYY-MM-DD, before effective_date
  expectedValidTo: string;       // effective_date - 1
  fixtureDir: string;
}

const CASES: SupersessionCase[] = [
  {
    name: "Paul (KO132 EG, €525 → €575)",
    property_id: KO132_ID,
    unit_ref: "EG",
    oldAmount: 52500,
    newAmount: 57500,
    effective_date: "2024-01-01",
    historical_query_date: "2023-06-01",
    expectedValidTo: "2023-12-31",
    fixtureDir: "paul-ko132-eg",
  },
  {
    name: "Kuru (KO132 DG, €440 → €470)",
    property_id: KO132_ID,
    unit_ref: "DG",
    oldAmount: 44000,
    newAmount: 47000,
    effective_date: "2024-09-01",
    historical_query_date: "2024-03-01",
    expectedValidTo: "2024-08-31",
    fixtureDir: "kuru-ko132-dg",
  },
  {
    name: "Weber (HHS55 OG, €900 → €1,000) — original bug case",
    property_id: HHS55_ID,
    unit_ref: "OG",
    oldAmount: 90000,
    newAmount: 100000,
    effective_date: "2024-04-01",
    historical_query_date: "2023-09-01",
    expectedValidTo: "2024-03-31",
    fixtureDir: "weber-hhs55-og",
  },
];

let passed = 0;
function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

async function runCase(c: SupersessionCase) {
  console.log(`\n=== ${c.name} ===\n`);

  const mietvertragEnv = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, c.fixtureDir, "mietvertrag.json"), "utf-8")
  );
  const mieterhoehungEnv = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, c.fixtureDir, "mieterhoehung.json"), "utf-8")
  );

  await prisma
    .$transaction(async (tx) => {
      // --- Document 1: Mietvertrag --------------------------------------
      const mvDocId = randomUUID();
      const mvRunId = randomUUID();

      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${mvDocId}::uuid, ${TEST_ORG_ID}::uuid, ${c.property_id}::uuid,
          'mietvertrag', ${c.fixtureDir + "-mietvertrag.pdf"},
          ${"test/" + mvDocId + "/mietvertrag.pdf"},
          ${"phase2-test-mv-" + mvDocId}, 1000, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;
      await tx.$executeRaw`
        INSERT INTO warehouse.document_extractions_v2 (
          source_document_id, doc_type, schema_version, prompt_version, model,
          extraction_run_id, fields, lifecycle, human_review_status
        ) VALUES (
          ${mvDocId}::uuid, 'mietvertrag', ${mietvertragEnv.schema_version},
          ${mietvertragEnv.prompt_version ?? mietvertragEnv.schema_version},
          ${mietvertragEnv.model ?? "synthetic-fixture"},
          ${mvRunId}::uuid,
          ${JSON.stringify(mietvertragEnv.fields)}::jsonb,
          ${JSON.stringify(mietvertragEnv.lifecycle ?? {})}::jsonb,
          'not_reviewed'
        )
      `;

      const mvEmit = emitMietvertragClaims(
        mietvertragEnv as any,
        {
          property_id: c.property_id,
          source_document_id: mvDocId,
          source_extraction_run_id: mvRunId,
          evidence_id_for_field: () => null,
        }
      );

      const mvApply = await applyEmission(
        mvEmit,
        {
          property_id: c.property_id,
          org_id: TEST_ORG_ID,
          extraction_run_id: mvRunId,
          emitter_version: "1.0.0",
        } as ApplyContext,
        { tx }
      );

      ok(mvApply.inserted_claim_ids.length === 2, `[${c.name}] Mietvertrag: 2 claims inserted`);
      ok(mvApply.applied_closure_ids.length === 0, `[${c.name}] Mietvertrag: 0 closures`);

      // --- Document 2: Mieterhöhung -------------------------------------
      const mhDocId = randomUUID();
      const mhRunId = randomUUID();

      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${mhDocId}::uuid, ${TEST_ORG_ID}::uuid, ${c.property_id}::uuid,
          'mieterhoehung', ${c.fixtureDir + "-mieterhoehung.pdf"},
          ${"test/" + mhDocId + "/mieterhoehung.pdf"},
          ${"phase2-test-mh-" + mhDocId}, 1000, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;
      await tx.$executeRaw`
        INSERT INTO warehouse.document_extractions_v2 (
          source_document_id, doc_type, schema_version, prompt_version, model,
          extraction_run_id, fields, lifecycle, human_review_status
        ) VALUES (
          ${mhDocId}::uuid, 'mieterhoehung', ${mieterhoehungEnv.schema_version},
          ${mieterhoehungEnv.prompt_version ?? mieterhoehungEnv.schema_version},
          ${mieterhoehungEnv.model ?? "synthetic-fixture"},
          ${mhRunId}::uuid,
          ${JSON.stringify(mieterhoehungEnv.fields)}::jsonb,
          ${JSON.stringify(mieterhoehungEnv.lifecycle ?? {})}::jsonb,
          'not_reviewed'
        )
      `;

      const mhEmit = emitMieterhoehungClaims(
        mieterhoehungEnv as any,
        {
          property_id: c.property_id,
          source_document_id: mhDocId,
          source_extraction_run_id: mhRunId,
          evidence_id_for_field: () => null,
        }
      );

      ok(mhEmit.claims_to_insert.length === 1, `[${c.name}] Mieterhöhung emitter: 1 new claim`);
      ok(mhEmit.closure_intents.length === 1, `[${c.name}] Mieterhöhung emitter: 1 closure intent`);
      ok(mhEmit.closure_intents[0].close_mode === "close_overlapping_only", `[${c.name}] close_mode === close_overlapping_only`);
      ok(mhEmit.closure_intents[0].close_at === c.expectedValidTo, `[${c.name}] close_at === ${c.expectedValidTo}`);
      ok(mhEmit.closure_intents[0].blocker_status === "none", `[${c.name}] blocker_status === none`);

      const mhApply = await applyEmission(
        mhEmit,
        {
          property_id: c.property_id,
          org_id: TEST_ORG_ID,
          extraction_run_id: mhRunId,
          emitter_version: "1.0.0",
        } as ApplyContext,
        { tx }
      );

      ok(mhApply.inserted_claim_ids.length === 1, `[${c.name}] Mieterhöhung applier: 1 claim inserted`);
      ok(mhApply.applied_closure_ids.length === 1, `[${c.name}] Mieterhöhung applier: 1 closure applied`);
      ok(mhApply.blocked_closure_intents.length === 0, `[${c.name}] no blocked closures`);

      // --- Verify the old kaltmiete claim has valid_to set ---------------
      const oldClaims = await tx.$queryRaw<{ valid_to: Date | null; value: any }[]>`
        SELECT valid_to, value
        FROM warehouse.claims
        WHERE property_id = ${c.property_id}::uuid
          AND subject = ${"unit:" + c.unit_ref}
          AND predicate = 'kaltmiete'
          AND (value->>'amount')::int = ${c.oldAmount}
      `;
      ok(oldClaims.length === 1, `[${c.name}] exactly 1 old kaltmiete claim`);
      ok(
        oldClaims[0].valid_to !== null && oldClaims[0].valid_to.toISOString().slice(0, 10) === c.expectedValidTo,
        `[${c.name}] old claim valid_to === ${c.expectedValidTo}`
      );

      // --- Resolver: as_of_date = today returns NEW amount ---------------
      const todayResult = await rentForUnit(
        { property_id: c.property_id, unit_ref: c.unit_ref, org_id: TEST_ORG_ID },
        { tx }
      );
      ok(todayResult.value?.amount === c.newAmount, `[${c.name}] resolver(today) === €${c.newAmount / 100}`);
      ok(todayResult.status === "single_active_claim", `[${c.name}] resolver(today) status === single_active_claim`);
      ok(todayResult.confidence === "high", `[${c.name}] resolver(today) confidence === high`);

      // --- Resolver: as_of_date = before effective_date returns OLD amount
      const historicalResult = await rentForUnit(
        {
          property_id: c.property_id,
          unit_ref: c.unit_ref,
          org_id: TEST_ORG_ID,
          as_of_date: new Date(c.historical_query_date + "T12:00:00.000Z"),
        },
        { tx }
      );
      ok(historicalResult.value?.amount === c.oldAmount, `[${c.name}] resolver(${c.historical_query_date}) === €${c.oldAmount / 100}`);
      ok(historicalResult.status === "single_active_claim", `[${c.name}] resolver(historical) status === single_active_claim`);

      throw new Error("rollback");
    })
    .catch((e: any) => {
      if (e.message !== "rollback") throw e;
    });
}

async function run() {
  console.log("Phase 2 supersession gate — Paul, Kuru, Weber\n");
  for (const c of CASES) {
    await runCase(c);
  }
  console.log(`\n✓ ${passed} supersession gate assertions passed across ${CASES.length} cases`);
  console.log(`✓ Phase 2 supersession chain verified for: ${CASES.map((c) => c.name).join(", ")}`);
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

Total assertions: 3 cases × ~14 assertions per case = ~42.

---

## Step 4 — ARCHITECTURE_STATE.md update

Append:

```markdown
## Phase 2 supersession gate (Task 2.2, 2026-05-27)

Three-case integration test (Paul, Kuru, Weber) verifying the supersession
chain end-to-end. The Weber case is the original bug that motivated the
v2 architecture; if this test passes, the bug fix is verified.

**Shipped:**
- `tests/fixtures/extraction/supersession/{paul,kuru,weber}-*/` — synthetic
  envelope JSON files for each case's Mietvertrag and Mieterhöhung
- `src/tests/integration/supersession-cases.test.ts` — 42 assertions across
  3 cases, verifies emitter → applier → resolver chain end-to-end with
  close_overlapping_only closure semantics

**What this proves:**
- Mieterhöhung emitter produces correct close_overlapping_only intents
- Applier sets `valid_to` on the previous kaltmiete claim
- Resolver returns the NEW rent for as_of_date >= effective_date
- Resolver returns the OLD rent for as_of_date < effective_date

**Pending (separate tasks):**
- Task 2.1b: Mietvertragsnachtrag (non-rent amendments)
- Task 2.3-2.4: Übergabeprotokoll with uebergabe_typ dispatch
- Task 2.5: Hofmann fixture (Eigentümerwechsel safeguard)
- Task 2.6: PLZ verifier
```

---

## Step 5 — Verify locally

```bash
cd ~/repos/property-management-saas
git pull
git checkout -b feature/task-2.2-supersession-cases

DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/integration/supersession-cases.test.ts | tail -50

# Regression check
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -3 || break
done

# tenant-isolation gate (integration/ is already allowlisted from Task 1.11)
npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

Expected output end:
```
✓ 42 supersession gate assertions passed across 3 cases
✓ Phase 2 supersession chain verified for: Paul (...), Kuru (...), Weber (...) — original bug case
```

---

## Step 6 — PR

```bash
git add tests/fixtures/extraction/supersession/ \
        src/tests/integration/supersession-cases.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "test(phase-2-gate): supersession cases Paul + Kuru + Weber (Task 2.2)

Phase 2 supersession gate. Three independent fixtures verify the
Mieterhöhung supersession chain end-to-end. The Weber case is the
original bug that motivated v2; if this test passes, the bug fix is
verified.

For each case (Paul KO132/EG €525→€575, Kuru KO132/DG €440→€470,
Weber HHS55/OG €900→€1000):
- Emit Mietvertrag claims (kaltmiete + tenant_active)
- Emit Mieterhöhung claims (new kaltmiete + close_overlapping_only)
- Applier sets valid_to on old kaltmiete = effective_date - 1
- rentForUnit(today) returns new amount
- rentForUnit(before effective_date) returns old amount

Synthetic JSON envelopes per Task 1.11 pattern. All assertions inside
a rollback transaction so no production residue.

- tests/fixtures/extraction/supersession/{paul,kuru,weber}-*/{mietvertrag,mieterhoehung}.json
- tests/fixtures/extraction/supersession/{paul,kuru,weber}-*/README.md
- src/tests/integration/supersession-cases.test.ts (~42 assertions)
- ARCHITECTURE_STATE.md: Task 2.2 section"
git push -u origin feature/task-2.2-supersession-cases
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.2-supersession-cases
```

---

## Definition of done

- [ ] All 9 fixture files created (3 dirs × 3 files)
- [ ] Test file created with ≥40 assertions across 3 cases
- [ ] Test reports all assertions pass
- [ ] `npx tsc --noEmit` silent
- [ ] All existing tests pass (regression)
- [ ] tenant-isolation gate clean
- [ ] Branch pushed, PR opened, CI green
- [ ] ARCHITECTURE_STATE.md section appended
- [ ] PR merged

---

## Notes for reviewer

**Synthetic envelopes vs. real Sonnet output.** The test uses hand-written JSON envelopes rather than real production extractions. Trade-off: synthetic envelopes are deterministic and self-contained, but they don't test that Sonnet actually produces this shape for these documents. The architecture handles this split deliberately — Task 1.11 (Lena) uses a real production envelope; Task 2.2 uses synthetic envelopes for cases where real Mieterhöhung documents may not exist in the system yet. If Paul, Kuru, or Weber Mieterhöhung documents DO exist with real extraction runs, prefer those over synthetic. Check before writing fixtures.

**Why three cases, not just Paul.** The implementation plan specifies Paul + Kuru + Weber explicitly. Weber is the architecturally-significant case (original bug). Paul is the spec example. Kuru adds variance: different effective date, different unit reference. Three cases catch off-by-one errors that one case might miss (e.g., a bug where close_at is wrong only when effective_date is the 1st of the month vs. mid-month).

**The historical query is the test that the bug is fixed.** Pre-v2, the resolver would have returned the new rent for any date (the old kaltmiete value would have been simply overwritten in `document_intelligence`). With v2, the old claim persists with `valid_to` set, and the resolver respects the `as_of_date` parameter. This test specifically queries with `as_of_date` before effective_date and asserts the OLD amount comes back. If that fails, the v2 architecture isn't doing what it was designed to do.

**Property IDs are env-var overridable.** `TEST_ORG_ID`, `KO132_ID`, `HHS55_ID` can be set in CI. Defaults match the known production IDs for the local dev/test environment. In a fresh environment those IDs would differ; setting env vars makes the test portable without code change.

**Tenant identity match strictness is "optional" in the closure intent.** The Mieterhöhung emitter sets this when the tenant_identity is present in the source extraction. The applier's fuzzy match will succeed for "Paul, Friedrich" vs. "Paul, Friedrich" (exact). If the match fails, per architecture §5.5.4 the closure proceeds with confidence downgrade rather than rejection. For these test fixtures, tenant names are identical between Mietvertrag and Mieterhöhung, so match succeeds and there's no downgrade.

**The rollback transaction model means cases don't interact.** Each case runs in its own tx that's rolled back at the end of the case (not at the end of the test). This isolates failures: if Paul's case fails, Kuru and Weber still run and we see their results too. Order independence is also free.

**No new emitter purity test entries needed.** Mieterhöhung is already covered by Task 2.1's purity gate. This test imports both emitters but doesn't introduce new ones.

**Mietvertrag emits 2 claims (kaltmiete + tenant_active).** The supersession only operates on kaltmiete. The tenant_active claim from the Mietvertrag remains open after the Mieterhöhung applies. If a later test asserts "tenant claim still open after rent increase," it'll find it as expected — that's the right semantic.
