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
const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "extraction",
  "hofmann",
  "hhs55-dg"
);

let passed = 0;
function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

// Seed a synthetic document + envelope row, return ids.
async function seedDoc(
  tx: Tx,
  doc_type: string,
  env: { schema_version: string; prompt_version?: string; model?: string; fields: unknown; lifecycle?: unknown }
) {
  const docId = randomUUID();
  const runId = randomUUID();
  // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.documents under TEST_ORG_ID scope
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
  // @tenant-isolation-disable-next-line -- reason: integration test seeding warehouse.document_extractions_v2 under TEST_ORG_ID scope
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

function applyCtx(runId: string): ApplyContext {
  return {
    property_id: HHS55_ID,
    org_id: TEST_ORG_ID,
    extraction_run_id: runId,
    emitter_version: "1.0.0",
  };
}

function emitterCtx(docId: string, runId: string) {
  return {
    property_id: HHS55_ID,
    source_document_id: docId,
    source_extraction_run_id: runId,
    evidence_id_for_field: () => null,
  };
}

/**
 * Test setup: HHS55 DG has pre-existing committed claims (kaltmiete +
 * tenant_active from the real 20210412_Mietvertrag Dachgeschoss.pdf). They
 * interfere with this test by giving rentForUnit a second active claim and
 * inflating closure counts. Close them by setting valid_to to a past date.
 * Triggers allow UPDATE of valid_to (NULL → non-NULL). The transaction
 * rollback restores production state — no residue.
 */
async function isolateTestUnit(tx: Tx) {
  // @tenant-isolation-disable-next-line -- reason: integration test test-isolation setup, scoping to HHS55 + unit:DG inside a rolled-back transaction
  await tx.$executeRaw`
    UPDATE warehouse.claims
    SET valid_to = valid_from
    WHERE property_id = ${HHS55_ID}::uuid
      AND subject = 'unit:DG'
      AND predicate IN ('kaltmiete', 'tenant_active', 'kaution', 'nebenkostenvorauszahlung')
      AND valid_to IS NULL
      AND superseded_by_claim_id IS NULL
  `;
}

async function transactionA() {
  console.log("\n=== Transaction A — Hofmann positive (Eigentümerwechsel preserves tenancy) ===\n");
  const mvEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "mietvertrag.json"), "utf-8"));
  const ewEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "eigentuemerwechsel.json"), "utf-8"));

  await prisma
    .$transaction(async (tx) => {
      // 0. Isolate: close any pre-existing real claims on unit:DG (test setup).
      await isolateTestUnit(tx);

      // 1. Hofmann Mietvertrag → kaltmiete + tenant_active for unit:DG
      const mv = await seedDoc(tx, "mietvertrag", mvEnv);
      const mvEmit = emitMietvertragClaims(mvEnv, emitterCtx(mv.docId, mv.runId));
      const mvApply = await applyEmission(mvEmit, applyCtx(mv.runId), { tx });
      ok(
        mvApply.inserted_claim_ids.length >= 2,
        "Mietvertrag: kaltmiete + tenant_active inserted"
      );

      // 2. Seed initial owner claim (Bernhardt) — no emitter produces owner
      //    claims from a Mietvertrag (ownership isn't in the lease). Shape
      //    matches what the Übergabeprotokoll emitter would produce:
      //    value = { owner: { name, is_legal_entity, legal_form } }.
      const ownerDocId = randomUUID();
      const ownerRunId = randomUUID();
      // @tenant-isolation-disable-next-line -- reason: integration test seeding pre-existing owner claim under TEST_ORG_ID and explicit HHS55 property scope
      await tx.$executeRaw`
        INSERT INTO warehouse.claims (
          property_id, subject, predicate, value, claim_kind, valid_from, valid_to,
          source_document_id, source_extraction_run_id, source_field_path, confidence,
          source_type, human_actor_id
        ) VALUES (
          ${HHS55_ID}::uuid, 'property', 'owner',
          ${JSON.stringify({ owner: { name: "Bernhardt, Cornelia", is_legal_entity: false, legal_form: null } })}::jsonb,
          'assertion', '2021-01-01'::date, NULL,
          ${ownerDocId}::uuid, ${ownerRunId}::uuid, 'seed.owner', 'high',
          'document_extraction', NULL
        )
      `;

      // 3. Process Eigentümerwechsel
      const ew = await seedDoc(tx, "wohnungsuebergabeprotokoll", ewEnv);
      const ewEmit = emitWohnungsuebergabeprotokollClaims(ewEnv, emitterCtx(ew.docId, ew.runId));
      ok(
        ewEmit.claims_to_insert.length === 2,
        "Eigentümerwechsel: 2 claims emitted (ownership_transferred + owner)"
      );
      ok(
        ewEmit.closure_intents.length === 1,
        "Eigentümerwechsel: exactly 1 closure intent (owner only — Hofmann safeguard structural)"
      );
      ok(
        ewEmit.closure_intents[0].target_predicates.includes("owner") &&
          ewEmit.closure_intents[0].target_predicates.length === 1,
        "Eigentümerwechsel closure targets ['owner'] and only 'owner'"
      );
      const tenantClosures = ewEmit.closure_intents.filter((ci) =>
        ci.target_predicates.some((p) =>
          ["tenant_active", "kaltmiete", "kaution", "nebenkostenvorauszahlung"].includes(p)
        )
      );
      ok(
        tenantClosures.length === 0,
        "Eigentümerwechsel emits NO tenant/rent closures (Hofmann safeguard, structural)"
      );

      const ewApply = await applyEmission(ewEmit, applyCtx(ew.runId), { tx });

      // 4. Owner claim transitioned
      // @tenant-isolation-disable-next-line -- reason: integration test verifying owner claim state under explicit HHS55 scope
      const owners = await tx.$queryRaw<{ value: { owner?: { name?: string } }; valid_to: Date | null }[]>`
        SELECT value, valid_to FROM warehouse.claims
        WHERE property_id = ${HHS55_ID}::uuid
          AND subject = 'property' AND predicate = 'owner'
        ORDER BY valid_from
      `;
      ok(owners.length === 2, "two owner claims exist (Bernhardt + Denn Immobilienverwaltung)");
      const bernhardt = owners.find((o) => (o.value?.owner?.name ?? "").includes("Bernhardt"));
      const denn = owners.find((o) => (o.value?.owner?.name ?? "").includes("Denn"));
      ok(
        bernhardt !== undefined && bernhardt.valid_to !== null,
        "previous owner (Bernhardt) closed (valid_to set)"
      );
      ok(
        bernhardt !== undefined &&
          bernhardt.valid_to !== null &&
          bernhardt.valid_to.toISOString().slice(0, 10) === "2025-11-14",
        "Bernhardt valid_to === 2025-11-14 (uebergabe_datum − 1 day)"
      );
      ok(
        denn !== undefined && denn.valid_to === null,
        "new owner (Denn Immobilienverwaltung) active (valid_to NULL)"
      );

      // 5. THE HOFMANN SAFEGUARD — tenancy survives
      // @tenant-isolation-disable-next-line -- reason: integration test verifying tenant + rent claim survival under explicit HHS55 scope
      const lease = await tx.$queryRaw<{ predicate: string; valid_to: Date | null }[]>`
        SELECT predicate, valid_to FROM warehouse.claims
        WHERE property_id = ${HHS55_ID}::uuid
          AND subject = 'unit:DG'
          AND predicate IN ('kaltmiete', 'tenant_active')
          AND claim_kind = 'assertion'
      `;
      const kaltmiete = lease.find((l) => l.predicate === "kaltmiete");
      const tenant = lease.find((l) => l.predicate === "tenant_active");
      ok(
        kaltmiete !== undefined && kaltmiete.valid_to === null,
        "HOFMANN: kaltmiete claim STILL ACTIVE after Eigentümerwechsel"
      );
      ok(
        tenant !== undefined && tenant.valid_to === null,
        "HOFMANN: tenant_active claim STILL ACTIVE after Eigentümerwechsel"
      );
      ok(
        ewApply.applied_closure_ids.length === 1,
        "exactly 1 closure applied (owner only)"
      );
      ok(
        ewApply.blocked_closure_intents.length === 0,
        "no blocked closures"
      );

      // 6. Resolver still returns €900
      const rent = await rentForUnit(
        { property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID },
        { tx }
      );
      ok(
        rent.value?.amount === 90000,
        "rentForUnit(HHS55, DG) returns €900 after ownership transfer"
      );
      ok(
        rent.status === "single_active_claim",
        "rentForUnit status === single_active_claim"
      );

      throw new Error("rollback");
    })
    .catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
}

async function transactionB() {
  console.log("\n=== Transaction B — negative control (Auszug closes tenancy) ===\n");
  const mvEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "mietvertrag.json"), "utf-8"));
  const auszugEnv = JSON.parse(readFileSync(join(FIXTURE_DIR, "auszug.json"), "utf-8"));

  await prisma
    .$transaction(async (tx) => {
      // 0. Isolate: close any pre-existing real claims on unit:DG (test setup).
      await isolateTestUnit(tx);

      const mv = await seedDoc(tx, "mietvertrag", mvEnv);
      const mvEmit = emitMietvertragClaims(mvEnv, emitterCtx(mv.docId, mv.runId));
      await applyEmission(mvEmit, applyCtx(mv.runId), { tx });

      const rentBefore = await rentForUnit(
        { property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID },
        { tx }
      );
      ok(rentBefore.value?.amount === 90000, "before Auszug: rentForUnit returns €900");

      const az = await seedDoc(tx, "wohnungsuebergabeprotokoll", auszugEnv);
      const azEmit = emitWohnungsuebergabeprotokollClaims(auszugEnv, emitterCtx(az.docId, az.runId));
      const azApply = await applyEmission(azEmit, applyCtx(az.runId), { tx });
      ok(
        azApply.applied_closure_ids.length >= 2,
        "Auszug applied closures (kaltmiete + tenant_active)"
      );
      ok(
        azApply.blocked_closure_intents.length === 0,
        "no blocked closures"
      );

      // @tenant-isolation-disable-next-line -- reason: integration test verifying claim closure after Auszug under explicit HHS55 scope
      const kaltmiete = await tx.$queryRaw<{ valid_to: Date | null }[]>`
        SELECT valid_to FROM warehouse.claims
        WHERE property_id = ${HHS55_ID}::uuid
          AND subject = 'unit:DG'
          AND predicate = 'kaltmiete'
          AND claim_kind = 'assertion'
      `;
      ok(
        kaltmiete[0]?.valid_to !== null,
        "after Auszug: kaltmiete claim closed (valid_to set)"
      );

      // @tenant-isolation-disable-next-line -- reason: integration test verifying tenant_active closure after Auszug under explicit HHS55 scope
      const tenantActive = await tx.$queryRaw<{ valid_to: Date | null }[]>`
        SELECT valid_to FROM warehouse.claims
        WHERE property_id = ${HHS55_ID}::uuid
          AND subject = 'unit:DG'
          AND predicate = 'tenant_active'
          AND claim_kind = 'assertion'
      `;
      ok(
        tenantActive[0]?.valid_to !== null,
        "after Auszug: tenant_active claim closed (valid_to set)"
      );

      const rentAfter = await rentForUnit(
        { property_id: HHS55_ID, unit_ref: "DG", org_id: TEST_ORG_ID },
        { tx }
      );
      ok(rentAfter.value === null, "after Auszug: rentForUnit returns null");
      // Resolver semantics: a closed claim still exists for (subject, predicate),
      // so the diagnostic count returns > 0 and status === "no_claim_for_date"
      // ("there exists a claim but not active at as_of_date"). "no_active_claim"
      // is reserved for "no claim of any kind ever existed". Either outcome
      // proves the negative control — the tenancy is no longer active.
      ok(
        rentAfter.status === "no_claim_for_date",
        "after Auszug: status === no_claim_for_date (closed claim still exists in history)"
      );

      throw new Error("rollback");
    })
    .catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
}

async function run() {
  console.log("Phase 2 gate — Hofmann case (HHS55 DG)\n");
  await transactionA();
  await transactionB();
  console.log(`\n✓ ${passed} Hofmann gate assertions passed`);
  console.log(
    "✓ Phase 2 gate: Eigentümerwechsel preserves tenancy; Auszug closes it. Hofmann bug structurally fixed."
  );
}

run()
  .catch((err: Error) => {
    console.error(`\n✗ FAILED after ${passed} assertions:`, err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
