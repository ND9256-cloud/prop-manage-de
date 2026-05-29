// Applier dedup-by-identity integration test.
//
// Pre-customer fix: re-processing a document must not stack duplicate active
// claims. Identity for dedup is (source_document_id, subject, predicate,
// value, valid_from) — not source_extraction_run_id.
//
// Three cases per docs/tasks/task-fix-applier-dedup.md:
//   (a) First apply of Lena's extraction → exactly 1 active kaltmiete claim, €650
//   (b) Re-apply identical facts (new extraction_run_id) → STILL exactly 1
//       active claim, NO new superseded_at written (true no-op)
//   (c) Apply changed value (same document, kaltmiete → €700) → exactly 1
//       active claim at €700, prior €650 claim superseded
//       (superseded_at set, superseded_by_claim_id → new claim)
//
// All three cases run inside a single Prisma transaction that is rolled back
// at the end (GoBD blocks DELETE; rollback is the only cleanup path).
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
//     src/tests/integration/applier-dedup.test.ts

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../lib/db";
import { emitMietvertragClaims } from "../../lib/emitters/mietvertrag";
import { applyEmission } from "../../lib/claim-store/applier";
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
  // @tenant-isolation-disable-next-line -- reason: test bootstrap fetches property id by org for dedup integration test, scoped via TEST_ORG_ID constant
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Property"
    WHERE "organizationId" = ${TEST_ORG_ID}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No test property found for org ${TEST_ORG_ID}`);
  return rows[0].id;
}

interface ClaimRow {
  id: string;
  value: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  superseded_at: Date | null;
  superseded_by_claim_id: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

async function readKaltmieteClaims(
  tx: Tx,
  source_document_id: string
): Promise<ClaimRow[]> {
  // @tenant-isolation-disable-next-line -- reason: test helper reading kaltmiete claim state for assertions, scoped to test's source_document_id
  return await tx.$queryRaw<ClaimRow[]>`
    SELECT id, value, valid_from, valid_to, superseded_at, superseded_by_claim_id
    FROM warehouse.claims
    WHERE source_document_id = ${source_document_id}::uuid
      AND subject = 'unit:1.OG'
      AND predicate = 'kaltmiete'
    ORDER BY created_at ASC
  `;
}

function activeKaltmiete(rows: ClaimRow[]): ClaimRow[] {
  return rows.filter(r => r.valid_to === null && r.superseded_by_claim_id === null);
}

function extractAmount(value: Record<string, unknown>): number | null {
  const v = typeof value === "string" ? JSON.parse(value) : value;
  if (v && typeof v === "object" && "amount" in v && typeof (v as Record<string, unknown>).amount === "number") {
    return (v as Record<string, unknown>).amount as number;
  }
  return null;
}

async function run() {
  console.log("Applier dedup-by-identity test (Lena KO132 1.OG)\n");

  const envelope = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  const property_id = await getTestPropertyId();

  await prisma
    .$transaction(async (tx) => {
      // Fresh source_document_id for this test run — avoids overlap with any
      // existing production claims for Lena's real document.
      const source_document_id = randomUUID();

      // === Case (a) — first apply ============================================
      console.log("\nCase (a) — first apply of Lena's extraction");
      const run_a = randomUUID();

      // warehouse.documents row needed because v2 path requires it for the
      // surrounding pipeline; applier itself does not FK to it but the
      // extraction envelope insert does.
      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${source_document_id}::uuid, ${TEST_ORG_ID}::uuid, ${property_id}::uuid,
          'mietvertrag', 'lena-everding-dedup-test.pdf',
          ${"test/" + source_document_id + "/lena-everding-dedup-test.pdf"},
          ${"dedup-test-" + source_document_id}, 8265123, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;

      const emission_a = emitMietvertragClaims(
        {
          doc_type: envelope.doc_type,
          schema_version: envelope.schema_version,
          fields: envelope.fields,
          lifecycle: envelope.lifecycle ?? {},
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {
          property_id,
          source_document_id,
          source_extraction_run_id: run_a,
          evidence_id_for_field: () => null,
        }
      );

      const ctx_a: ApplyContext = {
        property_id,
        org_id: TEST_ORG_ID,
        extraction_run_id: run_a,
        emitter_version: "1.0.0",
      };
      const result_a = await applyEmission(emission_a, ctx_a, { tx });

      ok(result_a.inserted_claim_ids.length === 2, "(a) 2 claims inserted (kaltmiete + tenant_active)");
      ok(result_a.skipped_duplicate_claim_ids.length === 0, "(a) 0 duplicates skipped");
      ok(result_a.applied_closure_ids.length === 0, "(a) 0 closures applied");

      const rows_a = await readKaltmieteClaims(tx, source_document_id);
      const active_a = activeKaltmiete(rows_a);
      ok(active_a.length === 1, "(a) exactly 1 active kaltmiete claim after first apply");
      ok(extractAmount(active_a[0].value) === 65000, "(a) active kaltmiete value is 65000 cents (€650)");
      ok(active_a[0].superseded_at === null, "(a) active claim superseded_at is null");
      const claim_id_a = active_a[0].id;

      // === Case (b) — identical re-application ==============================
      console.log("\nCase (b) — re-apply identical facts (new extraction_run_id)");
      const run_b = randomUUID();

      const emission_b = emitMietvertragClaims(
        {
          doc_type: envelope.doc_type,
          schema_version: envelope.schema_version,
          fields: envelope.fields,
          lifecycle: envelope.lifecycle ?? {},
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {
          property_id,
          source_document_id,
          source_extraction_run_id: run_b, // NEW run id, same facts
          evidence_id_for_field: () => null,
        }
      );

      const ctx_b: ApplyContext = { ...ctx_a, extraction_run_id: run_b };
      const result_b = await applyEmission(emission_b, ctx_b, { tx });

      ok(result_b.inserted_claim_ids.length === 0, "(b) 0 new claims inserted (true no-op)");
      ok(result_b.skipped_duplicate_claim_ids.length === 2, "(b) 2 duplicates skipped");
      ok(result_b.applied_closure_ids.length === 0, "(b) 0 closures applied");

      const rows_b = await readKaltmieteClaims(tx, source_document_id);
      ok(rows_b.length === 1, "(b) still exactly 1 kaltmiete row in DB (no parallel insert)");
      ok(activeKaltmiete(rows_b).length === 1, "(b) still exactly 1 active kaltmiete claim");
      ok(rows_b[0].superseded_at === null, "(b) superseded_at NOT written on the active claim (no-op)");
      ok(rows_b[0].id === claim_id_a, "(b) the active claim is the same row from case (a)");

      // === Case (c) — same identity, value changed ==========================
      console.log("\nCase (c) — apply with kaltmiete corrected to €700");
      const run_c = randomUUID();

      const fields_c = {
        ...envelope.fields,
        kaltmiete: {
          ...envelope.fields.kaltmiete,
          raw_value: "700,00 Euro",
          normalized_value: { amount: 70000, currency: "EUR" },
        },
      };

      const emission_c = emitMietvertragClaims(
        {
          doc_type: envelope.doc_type,
          schema_version: envelope.schema_version,
          fields: fields_c,
          lifecycle: envelope.lifecycle ?? {},
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {
          property_id,
          source_document_id,
          source_extraction_run_id: run_c,
          evidence_id_for_field: () => null,
        }
      );

      const ctx_c: ApplyContext = { ...ctx_a, extraction_run_id: run_c };
      const result_c = await applyEmission(emission_c, ctx_c, { tx });

      // tenant_active is unchanged → skipped. kaltmiete is changed → insert + supersede.
      ok(result_c.inserted_claim_ids.length === 1, "(c) 1 new claim inserted (corrected kaltmiete)");
      ok(result_c.skipped_duplicate_claim_ids.length === 1, "(c) 1 duplicate skipped (unchanged tenant_active)");
      ok(result_c.applied_closure_ids.length === 1, "(c) 1 closure applied (supersession of prior kaltmiete)");

      const rows_c = await readKaltmieteClaims(tx, source_document_id);
      ok(rows_c.length === 2, "(c) 2 kaltmiete rows in DB (old + new)");

      const active_c = activeKaltmiete(rows_c);
      ok(active_c.length === 1, "(c) exactly 1 active kaltmiete claim after value change");
      ok(extractAmount(active_c[0].value) === 70000, "(c) active claim is the new €700 value");
      const new_claim_id = active_c[0].id;
      ok(new_claim_id !== claim_id_a, "(c) active claim id differs from the original €650 claim");

      const supersededRows = rows_c.filter(r => r.id === claim_id_a);
      ok(supersededRows.length === 1, "(c) the original €650 claim still present (GoBD: not deleted)");
      const superseded = supersededRows[0];
      ok(superseded.superseded_at !== null, "(c) original claim has superseded_at set");
      ok(superseded.superseded_by_claim_id === new_claim_id, "(c) original claim's superseded_by_claim_id points to new claim");
      ok(extractAmount(superseded.value) === 65000, "(c) superseded claim retains original €650 value (immutable)");

      // claim_closures audit row must exist for this supersession
      // @tenant-isolation-disable-next-line -- reason: test helper reading closure audit row for assertion, target_claim_id is the test's own claim
      const closureRows = await tx.$queryRaw<{ close_mode: string; applied_valid_to: Date }[]>`
        SELECT close_mode, applied_valid_to FROM warehouse.claim_closures
        WHERE target_claim_id = ${claim_id_a}::uuid
          AND reason_claim_id = ${new_claim_id}::uuid
      `;
      ok(closureRows.length === 1, "(c) claim_closures audit row recorded for the supersession");
      ok(
        closureRows[0].close_mode === "close_overlapping_and_supersede_future",
        "(c) supersession recorded with close_overlapping_and_supersede_future close_mode"
      );

      throw new Error("rollback");
    })
    .catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "rollback") throw e;
    });

  console.log(`\n✓ ${passed} dedup-by-identity assertions passed`);
}

run()
  .catch((err) => {
    console.error(`\n✗ FAILED after ${passed} assertions:`, err.message);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
