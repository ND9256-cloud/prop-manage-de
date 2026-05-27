// Phase 2 supersession gate — Weber-bug-resolution test.
//
// For each of three cases (Paul, Kuru, Weber):
//   1. emit Mietvertrag claims via emitMietvertragClaims + applyEmission
//   2. emit Mieterhöhung claims via emitMieterhoehungClaims + applyEmission
//      (emits 2 claims: kaltmiete assertion + kaltmiete_amended event, plus
//      1 closure intent close_overlapping_only)
//   3. assert resolver returns new rent for today (single_active_claim)
//   4. assert resolver returns old rent for a date before effective_date
//
// All inside per-case tx that is rolled back at the end.

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
  effective_date: string;
  historical_query_date: string;
  expectedValidTo: string;
  fixtureDir: string;
}

const CASES: SupersessionCase[] = [
  {
    name: "Paul (KO132 EG, 525->575)",
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
    name: "Kuru (KO132 DG, 440->470)",
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
    name: "Weber (HHS55 OG, 900->1000) - original bug case",
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

      // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.documents row for fixture under TEST_ORG_ID scope
      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${mvDocId}::uuid, ${TEST_ORG_ID}::uuid, ${c.property_id}::uuid,
          'mietvertrag', ${c.fixtureDir + "-mv.pdf"},
          ${"test/" + mvDocId + "/mv.pdf"},
          ${"phase2-test-mv-" + mvDocId}, 1000, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;
      // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.document_extractions_v2 envelope for fixture under TEST_ORG_ID scope
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

      const mvEmit = emitMietvertragClaims(mietvertragEnv as any, {
        property_id: c.property_id,
        source_document_id: mvDocId,
        source_extraction_run_id: mvRunId,
        evidence_id_for_field: () => null,
      });

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

      ok(mvApply.inserted_claim_ids.length >= 2, `[${c.name}] Mietvertrag: >=2 claims inserted`);
      ok(mvApply.applied_closure_ids.length === 0, `[${c.name}] Mietvertrag: 0 closures applied`);

      // --- Document 2: Mieterhöhung -------------------------------------
      const mhDocId = randomUUID();
      const mhRunId = randomUUID();

      // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.documents row for fixture under TEST_ORG_ID scope
      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${mhDocId}::uuid, ${TEST_ORG_ID}::uuid, ${c.property_id}::uuid,
          'mieterhoehung', ${c.fixtureDir + "-mh.pdf"},
          ${"test/" + mhDocId + "/mh.pdf"},
          ${"phase2-test-mh-" + mhDocId}, 1000, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;
      // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.document_extractions_v2 envelope for fixture under TEST_ORG_ID scope
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

      const mhEmit = emitMieterhoehungClaims(mieterhoehungEnv as any, {
        property_id: c.property_id,
        source_document_id: mhDocId,
        source_extraction_run_id: mhRunId,
        evidence_id_for_field: () => null,
      });

      // Mieterhöhung emits 2 claims (kaltmiete assertion + kaltmiete_amended event)
      // + 1 closure intent.
      ok(mhEmit.claims_to_insert.length === 2, `[${c.name}] Mieterhöhung: 2 claims emitted`);
      ok(mhEmit.closure_intents.length === 1, `[${c.name}] Mieterhöhung: 1 closure intent emitted`);
      ok(mhEmit.closure_intents[0].close_mode === "close_overlapping_only", `[${c.name}] close_mode === close_overlapping_only`);
      ok(mhEmit.closure_intents[0].close_at === c.expectedValidTo, `[${c.name}] close_at === ${c.expectedValidTo}`);
      ok(mhEmit.closure_intents[0].blocker_status === "none", `[${c.name}] blocker_status === none`);
      ok(
        mhEmit.closure_intents[0].target_predicates.includes("kaltmiete"),
        `[${c.name}] closure targets kaltmiete predicate`
      );

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

      ok(mhApply.inserted_claim_ids.length === 2, `[${c.name}] Mieterhöhung applier: 2 claims inserted`);
      ok(mhApply.applied_closure_ids.length === 1, `[${c.name}] Mieterhöhung applier: 1 closure applied`);
      ok(mhApply.blocked_closure_intents.length === 0, `[${c.name}] no blocked closures`);

      // --- Verify old kaltmiete claim has valid_to set -------------------
      // @tenant-isolation-disable-next-line -- reason: integration test verifying claim state under TEST_ORG_ID and explicit property_id
      const oldClaims = await tx.$queryRaw<{ valid_to: Date | null }[]>`
        SELECT valid_to
        FROM warehouse.claims
        WHERE property_id = ${c.property_id}::uuid
          AND subject = ${"unit:" + c.unit_ref}
          AND predicate = 'kaltmiete'
          AND claim_kind = 'assertion'
          AND (value->>'amount')::int = ${c.oldAmount}
      `;
      ok(oldClaims.length === 1, `[${c.name}] exactly 1 old kaltmiete assertion`);
      ok(
        oldClaims[0].valid_to !== null &&
          oldClaims[0].valid_to.toISOString().slice(0, 10) === c.expectedValidTo,
        `[${c.name}] old claim valid_to === ${c.expectedValidTo}`
      );

      // --- Resolver as_of_date today returns NEW amount -----------------
      const todayResult = await rentForUnit(
        { property_id: c.property_id, unit_ref: c.unit_ref, org_id: TEST_ORG_ID },
        { tx }
      );
      ok(todayResult.value?.amount === c.newAmount, `[${c.name}] resolver(today) amount === ${c.newAmount}`);
      ok(todayResult.status === "single_active_claim", `[${c.name}] resolver(today) status === single_active_claim`);
      ok(todayResult.confidence === "high", `[${c.name}] resolver(today) confidence === high`);

      // --- Resolver historical date returns OLD amount ------------------
      const historicalResult = await rentForUnit(
        {
          property_id: c.property_id,
          unit_ref: c.unit_ref,
          org_id: TEST_ORG_ID,
          as_of_date: new Date(c.historical_query_date + "T12:00:00.000Z"),
        },
        { tx }
      );
      ok(
        historicalResult.value?.amount === c.oldAmount,
        `[${c.name}] resolver(${c.historical_query_date}) amount === ${c.oldAmount}`
      );
      ok(
        historicalResult.status === "single_active_claim",
        `[${c.name}] resolver(historical) status === single_active_claim`
      );

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
