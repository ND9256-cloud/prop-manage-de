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

import "dotenv/config";
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

  // --- Fixture sanity ------------------------------------------------------
  ok(envelope.doc_type === "mietvertrag", "envelope.doc_type === mietvertrag");
  ok(envelope.schema_version === "2026-05-21-v1", "envelope.schema_version === 2026-05-21-v1");
  ok(envelope.fields?.kaltmiete?.normalized_value?.amount === 65000, "envelope kaltmiete.amount === 65000");
  ok(envelope.fields?.kaltmiete?.normalized_value?.currency === "EUR", "envelope kaltmiete.currency === EUR");
  ok(envelope.fields?.unit_ref?.normalized_value === "1.OG", "envelope unit_ref === 1.OG");
  ok(envelope.fields?.tenant_identity?.normalized_value?.name === "Everding, Lena", "envelope tenant name === Everding, Lena");
  ok(envelope.fields?.mietbeginn?.normalized_value === "2025-04-01", "envelope mietbeginn === 2025-04-01");

  // --- Integration: tx-wrapped, rolled back at end -------------------------
  await prisma
    .$transaction(async (tx) => {
      const source_document_id = randomUUID();
      const extraction_run_id = randomUUID();

      await tx.$executeRaw`
        INSERT INTO warehouse.documents (
          id, org_id, property_id, doc_type, file_name, storage_path,
          file_hash, file_size_bytes, mime_type, source, language, status
        ) VALUES (
          ${source_document_id}::uuid, ${TEST_ORG_ID}::uuid, ${property_id}::uuid,
          'mietvertrag', 'everding-fixture.pdf',
          ${"test/" + source_document_id + "/everding-fixture.pdf"},
          ${"phase1-test-" + source_document_id}, 8265123, 'application/pdf',
          'api', 'de', 'applied'
        )
      `;

      await tx.$executeRaw`
        INSERT INTO warehouse.document_extractions_v2 (
          source_document_id, doc_type, schema_version, prompt_version, model,
          extraction_run_id, fields, lifecycle, human_review_status
        ) VALUES (
          ${source_document_id}::uuid, ${envelope.doc_type}, ${envelope.schema_version},
          ${envelope.prompt_version ?? envelope.schema_version},
          ${envelope.model ?? "test-fixture"},
          ${extraction_run_id}::uuid,
          ${JSON.stringify(envelope.fields)}::jsonb,
          ${JSON.stringify(envelope.lifecycle ?? {})}::jsonb,
          'not_reviewed'
        )
      `;

      // Emitter
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

      ok(emissionResult.claims_to_insert.length === 2, "emitter produced 2 claims");
      ok(emissionResult.closure_intents.length === 0, "emitter produced 0 closure intents");

      const kaltmieteClaim = emissionResult.claims_to_insert.find((c) => c.predicate === "kaltmiete");
      const tenantClaim = emissionResult.claims_to_insert.find((c) => c.predicate === "tenant_active");
      ok(kaltmieteClaim !== undefined, "emitter emitted a kaltmiete claim");
      ok(tenantClaim !== undefined, "emitter emitted a tenant_active claim");
      ok((kaltmieteClaim?.value as any)?.amount === 65000, "kaltmiete claim value.amount === 65000");
      ok(kaltmieteClaim?.subject === "unit:1.OG", "kaltmiete claim subject === unit:1.OG");
      ok((tenantClaim?.value as any)?.tenants?.[0]?.name === "Everding, Lena", "tenant claim name === Everding, Lena");

      // Applier
      const applyContext: ApplyContext = {
        property_id,
        org_id: TEST_ORG_ID,
        extraction_run_id,
        emitter_version: "1.0.0",
      };
      const applyResult = await applyEmission(emissionResult, applyContext, { tx });

      ok(applyResult.inserted_claim_ids.length === 2, "applier inserted 2 claims");
      ok(applyResult.applied_closure_ids.length === 0, "applier applied 0 closures");
      ok(applyResult.blocked_closure_intents.length === 0, "applier had 0 blocked intents");
      ok(applyResult.derivation_record_ids.length === 2, "applier wrote 2 derivation records");

      // Resolver
      const resolverResult = await rentForUnit(
        { property_id, unit_ref: "1.OG", org_id: TEST_ORG_ID },
        { tx }
      );

      ok(resolverResult.value?.amount === 65000, "rentForUnit value.amount === 65000");
      ok(resolverResult.value?.currency === "EUR", "rentForUnit value.currency === EUR");
      ok(resolverResult.status === "single_active_claim", "rentForUnit status === single_active_claim");
      ok(resolverResult.confidence === "high", "rentForUnit confidence === high");
      ok(resolverResult.source_claim_ids.length === 1, "rentForUnit source_claim_ids.length === 1");
      ok(resolverResult.conflicts.length === 0, "rentForUnit conflicts is empty");
      ok(resolverResult.resolver.name === "rent_for_unit", "rentForUnit.resolver.name === rent_for_unit");

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
