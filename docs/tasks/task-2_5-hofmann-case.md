# Task 2.5 — Hofmann fixture test (Phase 2 gate)

**Task type:** t1 M (deterministic integration test, no production code change; the Phase 2 gate)

**Branch:** `feature/task-2.5-hofmann-case`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.5 acceptance criteria ("Phase 2 gate. If this test passes, the second of the two original bugs is structurally fixed.")
- Task 2.4 (just shipped) — Übergabeprotokoll emitter with the Hofmann safeguard
- Task 2.2 — supersession-cases test (the structural template this follows)
- Task 1.11 — Lena fixture test (the original fixture-test pattern)
- `domain_knowledge/wohnungsuebergabeprotokoll.md` — the Hofmann gotcha (HHS55 DG, Nov 2025, Bernhardt → Denn Immobilienverwaltung eGbR)

**Phase 2 gate criterion:** an Eigentümerwechsel-Übergabeprotokoll for HHS55 DG must NOT terminate Dr. Hofmann's tenancy. After processing the ownership transfer, `rentForUnit({ property_id: HHS55, unit_ref: "DG" })` still returns €900 with `single_active_claim`. The negative control: an Auszug for the same unit DOES close the rent, and the resolver then returns null. If both hold, the second original bug (the Hofmann bug) is structurally fixed.

---

## Scope

A single CI-runnable test (`src/tests/integration/hofmann-case.test.ts`) with two independent rollback transactions:

**Transaction A — the Hofmann case (positive):**
1. Seed Hofmann Mietvertrag → emitter → applier → assert 1 active kaltmiete €900 + 1 active tenant_active for HHS55 DG
2. Seed an initial `owner` claim for the property (Bernhardt) — the Mietvertrag emitter doesn't emit owner claims, so seed it directly to represent pre-existing ownership
3. Process Eigentümerwechsel-Übergabeprotokoll (Bernhardt → Denn Immobilienverwaltung eGbR) → emitter → applier
4. Assert: new owner claim created (Denn Immobilienverwaltung), previous owner claim (Bernhardt) closed
5. **Assert: kaltmiete claim STILL active, tenant_active claim STILL active** (the Hofmann safeguard)
6. Assert: `rentForUnit(HHS55, DG)` returns €900, `single_active_claim`
7. Rollback

**Transaction B — the negative control (Auszug):**
1. Seed Hofmann Mietvertrag (same as A) → applier → assert active kaltmiete €900
2. Process an Auszug-Übergabeprotokoll for HHS55 DG (Hofmann moving out) → emitter → applier
3. Assert: kaltmiete claim closed (valid_to set), tenant_active closed
4. Assert: `rentForUnit(HHS55, DG)` returns null, status `no_active_claim`
5. Rollback

---

## Out of scope

- OCR / Sonnet — synthetic envelopes, no LLM calls
- The real Hofmann PDF documents — synthetic JSON envelopes only (the chain logic is what's under test; Sonnet accuracy is covered by Phase 0 verifiers)
- owner_of_property resolver — this test asserts owner-claim state via direct SQL, not via a resolver (the owner resolver is a later task)
- Multi-unit ownership transfers
- vacant-possession-language false-positive case — could add as a third transaction if time permits, but the core gate is the two above
- Production code changes — test-only

---

## Files touched

- `tests/fixtures/extraction/hofmann/hhs55-dg/mietvertrag.json` — Hofmann lease
- `tests/fixtures/extraction/hofmann/hhs55-dg/eigentuemerwechsel.json` — the ownership transfer
- `tests/fixtures/extraction/hofmann/hhs55-dg/auszug.json` — the negative-control move-out
- `tests/fixtures/extraction/hofmann/hhs55-dg/README.md`
- `src/tests/integration/hofmann-case.test.ts` — the test
- `ARCHITECTURE_STATE.md` — append Phase 2 gate section

**NOT touched:** production code, schemas, domain knowledge, Edge Function, DB schema.

---

## Repo conventions (recap)

- npm, tsc clean, lint clean
- Tests: `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- `src/tests/integration/` already allowlisted for raw SQL (Task 1.11)
- tx-rollback per transaction, no production residue
- HHS55 property_id: `d2e8e9c7-957a-4e0f-8150-452c21bcae56`
- TEST_ORG_ID: `310131df-d6ed-4007-83c2-ac69a7e9df42`
- `documents.source` CHECK constraint: use `'api'` (not `'test'`) — Task 1.11 lesson

---

## Step 0 — Verify shipped contracts

Same discipline as Task 2.2/2.4. Confirm before coding:

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-2.5-hofmann-case

# 1. The Übergabeprotokoll emitter signature + export name (just shipped in 2.4)
echo "=== uebergabeprotokoll emitter exports ==="
grep -n "export function\|export const EMITTER" src/lib/emitters/wohnungsuebergabeprotokoll.ts

# 2. What the Eigentümerwechsel branch actually emits (predicates, subjects, close_mode)
echo "=== Eigentümerwechsel branch ==="
grep -n "ownership_transferred\|owner\|Eigentümer\|close_overlapping" src/lib/emitters/wohnungsuebergabeprotokoll.ts | head -20

# 3. The owner claim shape — does an owner predicate already exist anywhere?
echo "=== owner predicate usage ==="
grep -rn "'owner'\|\"owner\"\|predicate.*owner" src/lib/ | grep -v node_modules | head -10

# 4. How Task 2.2 seeded claims + ran the chain (the template)
echo "=== supersession test structure ==="
sed -n '1,60p' src/tests/integration/supersession-cases.test.ts

# 5. The Mietvertrag emitter envelope shape (for the Hofmann lease fixture)
echo "=== mietvertrag fixture shape (Lena) ==="
cat tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json | head -40
```

**Reconcile before coding.** Confirm the exact owner-claim subject (`property` literal per architecture §4.2), the exact predicate names the 2.4 emitter produces, and the EmissionResult field names. Adjust fixtures + assertions to match the actual shipped emitter.

---

## Step 1 — Fixture files

### `tests/fixtures/extraction/hofmann/hhs55-dg/mietvertrag.json`

Hofmann's lease. €900 kaltmiete, unit DG, tenant Dr. Hellen Hofmann, lease start 2021.

```json
{
  "doc_type": "mietvertrag",
  "schema_version": "2026-05-21-v1",
  "prompt_version": "2026-05-21-v1",
  "model": "synthetic-fixture",
  "fields": {
    "kaltmiete": {
      "absence_state": "present",
      "confidence": "high",
      "raw_value": "900,00 €",
      "normalized_value": { "amount": 90000, "currency": "EUR" }
    },
    "unit_ref": {
      "absence_state": "present",
      "confidence": "high",
      "raw_value": "DG",
      "normalized_value": "DG"
    },
    "tenant_identity": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": { "name": "Hofmann, Hellen", "is_legal_entity": false, "legal_form": null }
    },
    "mietbeginn": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "2021-03-01"
    }
  },
  "lifecycle": {
    "document_status": "executed",
    "effective_date": "2021-03-01"
  }
}
```

### `tests/fixtures/extraction/hofmann/hhs55-dg/eigentuemerwechsel.json`

The ownership transfer. Bernhardt → Denn Immobilienverwaltung eGbR, handover 2025-11-15.

```json
{
  "doc_type": "wohnungsuebergabeprotokoll",
  "schema_version": "2026-05-27-v1",
  "prompt_version": "2026-05-27-v1",
  "model": "synthetic-fixture",
  "fields": {
    "uebergabe_typ": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "Eigentümerwechsel"
    },
    "uebergabe_datum": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "2025-11-15"
    },
    "kaeufer": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": { "name": "Denn Immobilienverwaltung eGbR", "is_legal_entity": true, "legal_form": "eGbR" }
    },
    "verkaeufer": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": { "name": "Bernhardt, Cornelia", "is_legal_entity": false, "legal_form": null }
    },
    "vacant_possession_language_present": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": false
    }
  },
  "lifecycle": {}
}
```

### `tests/fixtures/extraction/hofmann/hhs55-dg/auszug.json`

Negative control — Hofmann moving out, handover 2026-02-28.

```json
{
  "doc_type": "wohnungsuebergabeprotokoll",
  "schema_version": "2026-05-27-v1",
  "prompt_version": "2026-05-27-v1",
  "model": "synthetic-fixture",
  "fields": {
    "uebergabe_typ": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "Auszug"
    },
    "uebergabe_datum": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "2026-02-28"
    },
    "unit_ref": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": "DG"
    },
    "mieter_out": {
      "absence_state": "present",
      "confidence": "high",
      "normalized_value": { "name": "Hofmann, Hellen", "is_legal_entity": false, "legal_form": null }
    }
  },
  "lifecycle": {}
}
```

### `tests/fixtures/extraction/hofmann/hhs55-dg/README.md`

```markdown
# Hofmann case fixture — Phase 2 gate

Property: HHS55 (Heinrich-Heine-Straße 55), unit DG
Tenant: Dr. Hellen Hofmann, €900/month Kaltmiete, since 2021-03-01
Ownership transfer (Nov 2025): Cornelia Bernhardt → Denn Immobilienverwaltung eGbR

The original v1 bug: an Eigentümerwechsel-Übergabeprotokoll was misclassified
and silently closed Hofmann's tenant + rent claims, dropping HHS55's monthly
total from €1,900 to €1,000.

## What this fixture verifies

Positive: processing the Eigentümerwechsel transfers ownership (new owner
claim, previous owner closed) but leaves Hofmann's tenant_active and
kaltmiete claims ACTIVE. rentForUnit(HHS55, DG) still returns €900.

Negative control: processing an Auszug for the same unit DOES close the
rent + tenant claims. rentForUnit then returns null.

If both hold, the Hofmann bug is structurally fixed (BGB §566: Kauf bricht
nicht Miete — sale does not break the lease).
```

---

## Step 2 — The test

`src/tests/integration/hofmann-case.test.ts`. Mirror Task 2.2's structure (per-transaction rollback, the `ok()` helper, synthetic document + envelope seeding). Two transactions.

Key construction notes:
- Seed the initial owner claim (Bernhardt) directly via raw SQL before processing the Eigentümerwechsel, since no emitter produces owner claims yet. Use `subject = 'property'`, `predicate = 'owner'`, `claim_kind = 'assertion'`, `value = { name: "Bernhardt, Cornelia", ... }`, `valid_from = '2021-01-01'`, `valid_to = null`, `source_type = 'document_extraction'` (or whatever the CHECK allows — verify), a synthetic source_document_id + source_extraction_run_id.
- For the owner-closure assertion: after processing the Eigentümerwechsel, query `warehouse.claims WHERE subject='property' AND predicate='owner'` and assert there are two rows — Bernhardt with valid_to set, Denn Immobilienverwaltung with valid_to null.
- The Hofmann safeguard assertion: query kaltmiete + tenant_active for `unit:DG` and assert `valid_to IS NULL` (still active) after the Eigentümerwechsel.

```typescript
// Phase 2 gate — Hofmann case.
//
// Positive: Eigentümerwechsel transfers ownership but leaves the tenancy intact.
// Negative: Auszug closes the tenancy.
//
// If both hold, the second of the two original bugs (Hofmann) is structurally fixed.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
//     src/tests/integration/hofmann-case.test.ts

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../lib/db";
import { emitMietvertragClaims } from "../../lib/emitters/mietvertrag";
import { emitWohnungsuebergabeprotokollClaims } from "../../lib/emitters/wohnungsuebergabeprotokoll";
import { applyEmission } from "../../lib/claim-store/applier";
import { rentForUnit } from "../../lib/resolvers/rent-for-unit";
import type { ApplyContext } from "../../lib/claim-store/types";

const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";
const HHS55_ID = process.env.HHS55_ID || "d2e8e9c7-957a-4e0f-8150-452c21bcae56";
const FIXTURE_DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "extraction", "hofmann", "hhs55-dg");

let passed = 0;
function ok(c: boolean, m: string) {
  if (!c) throw new Error(`Assertion failed: ${m}`);
  passed++;
  console.log(`  ✓ ${passed}. ${m}`);
}

// Helper: seed a synthetic document + envelope row, return ids.
async function seedDoc(tx: any, doc_type: string, env: any) {
  const docId = randomUUID();
  const runId = randomUUID();
  // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.documents under TEST_ORG_ID
  await tx.$executeRaw`
    INSERT INTO warehouse.documents (
      id, org_id, property_id, doc_type, file_name, storage_path,
      file_hash, file_size_bytes, mime_type, source, language, status
    ) VALUES (
      ${docId}::uuid, ${TEST_ORG_ID}::uuid, ${HHS55_ID}::uuid,
      ${doc_type}, ${doc_type + ".pdf"}, ${"test/" + docId + "/" + doc_type + ".pdf"},
      ${"hofmann-test-" + docId}, 1000, 'application/pdf', 'api', 'de', 'applied'
    )
  `;
  // @tenant-isolation-disable-next-line -- reason: integration test seeding envelope under TEST_ORG_ID
  await tx.$executeRaw`
    INSERT INTO warehouse.document_extractions_v2 (
      source_document_id, doc_type, schema_version, prompt_version, model,
      extraction_run_id, fields, lifecycle, human_review_status
    ) VALUES (
      ${docId}::uuid, ${doc_type}, ${env.schema_version},
      ${env.prompt_version ?? env.schema_version}, ${env.model ?? "synthetic-fixture"},
      ${runId}::uuid, ${JSON.stringify(env.fields)}::jsonb,
      ${JSON.stringify(env.lifecycle ?? {})}::jsonb, 'not_reviewed'
    )
  `;
  return { docId, runId };
}

function ctx(docId: string, runId: string): ApplyContext {
  return { property_id: HHS55_ID, org_id: TEST_ORG_ID, extraction_run_id: runId, emitter_version: "1.0.0" };
}
function emitterCtx(docId: string, runId: string) {
  return { property_id: HHS55_ID, source_document_id: docId, source_extraction_run_id: runId, evidence_id_for_field: () => null };
}

async function transactionA() {
  console.log("\n=== Transaction A — Hofmann positive (Eigentümerwechsel preserves tenancy) ===\n");
  const mvEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "mietvertrag.json"), "utf-8"));
  const ewEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "eigentuemerwechsel.json"), "utf-8"));

  await prisma.$transaction(async (tx) => {
    // 1. Hofmann Mietvertrag
    const mv = await seedDoc(tx, "mietvertrag", mvEnv);
    const mvEmit = emitMietvertragClaims(mvEnv, emitterCtx(mv.docId, mv.runId));
    const mvApply = await applyEmission(mvEmit, ctx(mv.docId, mv.runId), { tx });
    ok(mvApply.inserted_claim_ids.length >= 2, "Mietvertrag: kaltmiete + tenant_active inserted");

    // 2. Seed initial owner claim (Bernhardt) — no emitter produces owner claims yet
    const ownerDocId = randomUUID();
    const ownerRunId = randomUUID();
    // @tenant-isolation-disable-next-line -- reason: integration test seeding pre-existing owner claim under TEST_ORG_ID
    await tx.$executeRaw`
      INSERT INTO warehouse.claims (
        property_id, subject, predicate, value, claim_kind, valid_from, valid_to,
        source_document_id, source_extraction_run_id, source_field_path, confidence,
        source_type, human_actor_id
      ) VALUES (
        ${HHS55_ID}::uuid, 'property', 'owner',
        ${JSON.stringify({ name: "Bernhardt, Cornelia", is_legal_entity: false, legal_form: null })}::jsonb,
        'assertion', '2021-01-01'::date, NULL,
        ${ownerDocId}::uuid, ${ownerRunId}::uuid, 'seed.owner', 'high',
        'document_extraction', NULL
      )
    `;

    // 3. Process Eigentümerwechsel
    const ew = await seedDoc(tx, "wohnungsuebergabeprotokoll", ewEnv);
    const ewEmit = emitWohnungsuebergabeprotokollClaims(ewEnv, emitterCtx(ew.docId, ew.runId));
    const ewApply = await applyEmission(ewEmit, ctx(ew.docId, ew.runId), { tx });

    // 4. Owner claim transitioned
    // @tenant-isolation-disable-next-line -- reason: integration test verifying owner claim state under TEST_ORG_ID
    const owners = await tx.$queryRaw<{ value: any; valid_to: Date | null }[]>`
      SELECT value, valid_to FROM warehouse.claims
      WHERE property_id = ${HHS55_ID}::uuid AND subject = 'property' AND predicate = 'owner'
      ORDER BY valid_from
    `;
    ok(owners.length === 2, "two owner claims exist (Bernhardt + Denn Immobilienverwaltung)");
    const bernhardt = owners.find((o) => o.value?.name?.includes("Bernhardt"));
    const denn = owners.find((o) => o.value?.name?.includes("Denn"));
    ok(bernhardt?.valid_to !== null, "previous owner (Bernhardt) closed (valid_to set)");
    ok(denn !== undefined && denn.valid_to === null, "new owner (Denn Immobilienverwaltung) active");

    // 5. THE HOFMANN SAFEGUARD — tenancy survives
    // @tenant-isolation-disable-next-line -- reason: integration test verifying tenant + rent claim survival under TEST_ORG_ID
    const lease = await tx.$queryRaw<{ predicate: string; valid_to: Date | null }[]>`
      SELECT predicate, valid_to FROM warehouse.claims
      WHERE property_id = ${HHS55_ID}::uuid AND subject = 'unit:DG'
        AND predicate IN ('kaltmiete', 'tenant_active')
    `;
    const kaltmiete = lease.find((l) => l.predicate === "kaltmiete");
    const tenant = lease.find((l) => l.predicate === "tenant_active");
    ok(kaltmiete?.valid_to === null, "HOFMANN: kaltmiete claim STILL ACTIVE after Eigentümerwechsel");
    ok(tenant?.valid_to === null, "HOFMANN: tenant_active claim STILL ACTIVE after Eigentümerwechsel");
    ok(ewApply.applied_closure_ids.length === 1, "exactly 1 closure applied (owner only)");

    // 6. Resolver still returns €900
    const rent = await rentForUnit({ property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID }, { tx });
    ok(rent.value?.amount === 90000, "rentForUnit(HHS55, DG) returns €900 after ownership transfer");
    ok(rent.status === "single_active_claim", "rentForUnit status === single_active_claim");

    throw new Error("rollback");
  }).catch((e: any) => { if (e.message !== "rollback") throw e; });
}

async function transactionB() {
  console.log("\n=== Transaction B — negative control (Auszug closes tenancy) ===\n");
  const mvEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "mietvertrag.json"), "utf-8"));
  const auszugEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "auszug.json"), "utf-8"));

  await prisma.$transaction(async (tx) => {
    const mv = await seedDoc(tx, "mietvertrag", mvEnv);
    const mvEmit = emitMietvertragClaims(mvEnv, emitterCtx(mv.docId, mv.runId));
    await applyEmission(mvEmit, ctx(mv.docId, mv.runId), { tx });

    const rentBefore = await rentForUnit({ property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID }, { tx });
    ok(rentBefore.value?.amount === 90000, "before Auszug: rentForUnit returns €900");

    const az = await seedDoc(tx, "wohnungsuebergabeprotokoll", auszugEnv);
    const azEmit = emitWohnungsuebergabeprotokollClaims(auszugEnv, emitterCtx(az.docId, az.runId));
    const azApply = await applyEmission(azEmit, ctx(az.docId, az.runId), { tx });
    ok(azApply.applied_closure_ids.length >= 2, "Auszug applied closures (kaltmiete + tenant_active)");

    // @tenant-isolation-disable-next-line -- reason: integration test verifying claim closure after Auszug under TEST_ORG_ID
    const kaltmiete = await tx.$queryRaw<{ valid_to: Date | null }[]>`
      SELECT valid_to FROM warehouse.claims
      WHERE property_id = ${HHS55_ID}::uuid AND subject = 'unit:DG'
        AND predicate = 'kaltmiete' AND claim_kind = 'assertion'
    `;
    ok(kaltmiete[0]?.valid_to !== null, "after Auszug: kaltmiete claim closed (valid_to set)");

    const rentAfter = await rentForUnit({ property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID }, { tx });
    ok(rentAfter.value === null, "after Auszug: rentForUnit returns null");
    ok(rentAfter.status === "no_active_claim", "after Auszug: status === no_active_claim");

    throw new Error("rollback");
  }).catch((e: any) => { if (e.message !== "rollback") throw e; });
}

async function run() {
  console.log("Phase 2 gate — Hofmann case (HHS55 DG)\n");
  await transactionA();
  await transactionB();
  console.log(`\n✓ ${passed} Hofmann gate assertions passed`);
  console.log("✓ Phase 2 gate: Eigentümerwechsel preserves tenancy; Auszug closes it. Hofmann bug structurally fixed.");
}

run()
  .catch((err) => { console.error(`\n✗ FAILED after ${passed} assertions:`, err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

**Adjust to actual contracts from Step 0** — especially the owner-claim value shape, the `source_type` CHECK-allowed values, and the exact predicate names the 2.4 emitter emits.

---

## Step 3 — ARCHITECTURE_STATE.md

```markdown
## Phase 2 GATE PASSED — Hofmann case (Task 2.5, 2026-05-27)

The second of the two original v1 bugs is structurally fixed.

`src/tests/integration/hofmann-case.test.ts` runs two transactions:
- Positive: an Eigentümerwechsel-Übergabeprotokoll (Bernhardt → Denn
  Immobilienverwaltung eGbR) transfers ownership (new owner claim, previous
  owner closed) but leaves Hofmann's tenant_active and kaltmiete claims
  ACTIVE. rentForUnit(HHS55, DG) still returns €900.
- Negative control: an Auszug for the same unit closes the rent + tenant
  claims; rentForUnit then returns null.

Both original bugs now have structural fixes verified by gate tests:
- Weber (supersession): Task 2.2
- Hofmann (ownership ≠ tenancy): Task 2.5

**Phase 2 core thesis verified.** Remaining Phase 2: Task 2.1b
(Mietvertragsnachtrag), Task 2.6 (PLZ verifier).
```

---

## Step 4 — Verify

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/integration/hofmann-case.test.ts | tail -40

# regression
for f in src/tests/integration/*.test.ts src/tests/emitter-*.test.ts src/tests/claim-store/*.test.ts; do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -2
done

npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

Expected tail:
```
✓ N Hofmann gate assertions passed
✓ Phase 2 gate: Eigentümerwechsel preserves tenancy; Auszug closes it. Hofmann bug structurally fixed.
```

---

## Step 5 — PR

```bash
git add tests/fixtures/extraction/hofmann/ \
        src/tests/integration/hofmann-case.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "test(phase-2-gate): Hofmann case — ownership transfer preserves tenancy (Task 2.5)

Phase 2 gate. Two transactions verify the second original v1 bug is fixed:

Positive: an Eigentümerwechsel-Übergabeprotokoll (Bernhardt → Denn
Immobilienverwaltung eGbR) at HHS55 DG transfers ownership (new owner claim,
previous owner closed) but leaves Hofmann's tenant_active and kaltmiete claims
ACTIVE. rentForUnit(HHS55, DG) still returns €900 (BGB §566).

Negative control: an Auszug for the same unit closes rent + tenant claims;
rentForUnit then returns null.

Both original bugs now have verified structural fixes:
- Weber (supersession): Task 2.2
- Hofmann (ownership ≠ tenancy): Task 2.5

- tests/fixtures/extraction/hofmann/hhs55-dg/{mietvertrag,eigentuemerwechsel,auszug}.json
- tests/fixtures/extraction/hofmann/hhs55-dg/README.md
- src/tests/integration/hofmann-case.test.ts
- ARCHITECTURE_STATE.md: Phase 2 gate passed section"
git push -u origin feature/task-2.5-hofmann-case
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.5-hofmann-case
```

---

## Definition of done

- [ ] Step 0 contracts verified; fixtures + assertions match the shipped 2.4 emitter
- [ ] 4 fixture files created
- [ ] Test file with two transactions, ≥12 assertions total
- [ ] Positive transaction: Eigentümerwechsel preserves kaltmiete + tenant_active (the Hofmann assertion)
- [ ] Negative transaction: Auszug closes them, resolver returns null
- [ ] tsc clean, regression suite passes, tenant-isolation clean
- [ ] Branch pushed, PR opened, CI green
- [ ] ARCHITECTURE_STATE.md appended
- [ ] PR merged → Phase 2 gate passed

---

## Notes for reviewer

**Why seed the owner claim manually.** No emitter currently produces owner claims from a Mietvertrag (ownership isn't in the lease). To test that the Eigentümerwechsel closes the *previous* owner, a previous owner claim must exist. Seeding it directly via SQL is the honest representation of pre-existing ownership state. When a Kaufvertrag doc_type or an initial-ownership ingestion path exists, this seed can be replaced with a real emission.

**The Hofmann assertion is the whole point.** Assertions 5 in Transaction A (kaltmiete + tenant_active still active after the Eigentümerwechsel) are the test. Everything else is scaffolding. If those two ever fail, the Hofmann bug has regressed and Phase 2's core promise is broken.

**The negative control matters as much as the positive.** A test that only checks "Eigentümerwechsel doesn't close tenancy" could pass trivially if the emitter closed nothing ever. Transaction B proves the Auszug branch DOES close the tenancy — so the positive result in A is meaningful (the system can close tenancy; it correctly chooses not to for ownership transfers).

**Synthetic envelopes, consistent with Task 2.2.** No real PDFs. The chain logic from envelope onward is what's under test. Sonnet's ability to classify a real Eigentümerwechsel document correctly is a separate concern (Phase 0 verifiers + the uebergabe_typ critical-severity field).

**Two transactions, not one.** Each rolls back independently so a failure in A still lets B run and report. Also avoids cross-contamination (B's Mietvertrag seeding would otherwise collide with A's residue if they shared a transaction).

**owner-claim state asserted via SQL, not a resolver.** There's no owner_of_property resolver yet (later task). The test queries warehouse.claims directly for the owner predicate. When the owner resolver ships, a follow-up can assert through it instead.
