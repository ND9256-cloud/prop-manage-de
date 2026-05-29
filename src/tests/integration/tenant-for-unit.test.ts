// Integration test for the tenant_for_unit resolver.
//
// Mirrors everding-end-to-end.test.ts: runs the full v2 chain
// (envelope -> emitter -> applier -> resolver) on the real Lena Everding
// fixture inside a transaction that always rolls back. Adds the no-claim
// (phantom vacancy) and multi-claim conflict scenarios that exercise the
// rest of the §5.2 status vocabulary.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
//     src/tests/integration/tenant-for-unit.test.ts

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../lib/db";
import { emitMietvertragClaims } from "../../lib/emitters/mietvertrag";
import { applyEmission } from "../../lib/claim-store/applier";
import { tenantForUnit } from "../../lib/resolvers/tenant-for-unit";
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

const TEST_RUN = randomUUID().slice(0, 8);
function testSubject(unit: string): string {
  return `unit:test-${TEST_RUN}-${unit}`;
}

async function getTestPropertyId(): Promise<string> {
  // @tenant-isolation-disable-next-line -- reason: test bootstrap fetching property id for tenant_for_unit integration test, org-scoped by TEST_ORG_ID constant
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Property"
    WHERE "organizationId" = ${TEST_ORG_ID}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No test property found for org ${TEST_ORG_ID}`);
  return rows[0].id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertTenantClaim(tx: any, args: {
  property_id: string;
  subject: string;
  value: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
  confidence: string;
  superseded_by_claim_id?: string | null;
}): Promise<string> {
  const docId = randomUUID();
  const runId = randomUUID();
  // @tenant-isolation-disable-next-line -- reason: test helper inserting synthetic tenant_active seed claim for resolver integration tests
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.claims (
      property_id, subject, predicate, value, claim_kind, source_type,
      valid_from, valid_to,
      source_document_id, source_extraction_run_id, source_field_path,
      human_actor_id, confidence, evidence_id, superseded_by_claim_id
    ) VALUES (
      ${args.property_id}::uuid, ${args.subject}, 'tenant_active',
      ${JSON.stringify(args.value)}::jsonb, 'assertion', 'document_extraction',
      ${args.valid_from}::date, ${args.valid_to ?? null}::date,
      ${docId}::uuid, ${runId}::uuid, 'fields.tenant_identity',
      null, ${args.confidence}, null,
      ${args.superseded_by_claim_id ?? null}::uuid
    ) RETURNING id
  `;
  return rows[0].id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRollback(fn: (tx: any) => Promise<void>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await fn(tx);
    throw new Error("rollback");
  }).catch((e: Error) => {
    if (e.message !== "rollback") throw e;
  });
}

async function run() {
  console.log("tenant_for_unit resolver — integration tests\n");

  const propertyId = await getTestPropertyId();
  const envelope = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

  // Fixture sanity — the test stands or falls on this content.
  ok(envelope.fields?.tenant_identity?.normalized_value?.name === "Everding, Lena",
    "fixture tenant_identity.name === Everding, Lena");
  ok(envelope.fields?.tenant_identity?.normalized_value?.is_legal_entity === false,
    "fixture tenant_identity.is_legal_entity === false");

  // =========================================================================
  // Scenario 1 — Positive: full chain on real Lena fixture
  // =========================================================================
  console.log("\n--- Scenario 1: Lena Everding (single_active_claim, end-to-end) ---");
  await withRollback(async (tx) => {
    const source_document_id = randomUUID();
    const extraction_run_id = randomUUID();

    await tx.$executeRaw`
      INSERT INTO warehouse.documents (
        id, org_id, property_id, doc_type, file_name, storage_path,
        file_hash, file_size_bytes, mime_type, source, language, status
      ) VALUES (
        ${source_document_id}::uuid, ${TEST_ORG_ID}::uuid, ${propertyId}::uuid,
        'mietvertrag', 'tenant-resolver-fixture.pdf',
        ${"test/" + source_document_id + "/tenant-resolver-fixture.pdf"},
        ${"tenant-resolver-test-" + source_document_id}, 8265123, 'application/pdf',
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

    const emission = emitMietvertragClaims(
      {
        doc_type: envelope.doc_type,
        schema_version: envelope.schema_version,
        fields: envelope.fields,
        lifecycle: envelope.lifecycle ?? {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        property_id: propertyId,
        source_document_id,
        source_extraction_run_id: extraction_run_id,
        evidence_id_for_field: () => null,
      }
    );

    const applyContext: ApplyContext = {
      property_id: propertyId,
      org_id: TEST_ORG_ID,
      extraction_run_id,
      emitter_version: "1.0.0",
    };
    await applyEmission(emission, applyContext, { tx });

    const fact = await tenantForUnit(
      { property_id: propertyId, unit_ref: "1.OG", org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value !== null, "value is not null");
    ok(fact.value!.name === "Everding, Lena", "value.name === Everding, Lena");
    ok(fact.value!.is_legal_entity === false, "value.is_legal_entity === false");
    ok(fact.status === "single_active_claim", "status === single_active_claim");
    ok(fact.source_claim_ids.length === 1, "source_claim_ids.length === 1");
    ok(fact.conflicts.length === 0, "conflicts.length === 0");
    ok(fact.resolver.name === "tenant_for_unit", "resolver.name === tenant_for_unit");
    ok(fact.resolver.version === "1.0.0", "resolver.version === 1.0.0");
    ok(fact.confidence === "high", "confidence === high (no downgrade)");
    ok(fact.derivation_record_id !== null, "derivation_record_id !== null");
  });

  // =========================================================================
  // Scenario 2 — No-claim / phantom vacancy
  // =========================================================================
  // Use a fresh unit_ref that has no tenant_active claim. Mirrors the
  // KO132 EG "phantom vacancy" case the task spec calls out: a unit on a
  // real property with no claims yet must NOT throw and must return
  // status="no_active_claim", value=null.
  console.log("\n--- Scenario 2: No tenant_active claim (phantom vacancy) ---");
  await withRollback(async (tx) => {
    const unitRef = `test-${TEST_RUN}-VACANT-EG`;
    const fact = await tenantForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value === null, "value === null (no tenant claim)");
    ok(fact.status === "no_active_claim", "status === no_active_claim");
    ok(fact.confidence === "low", "confidence === low");
    ok(fact.source_claim_ids.length === 0, "source_claim_ids is empty");
    ok(fact.conflicts.length === 0, "conflicts is empty");
    ok(fact.resolver.name === "tenant_for_unit", "resolver.name === tenant_for_unit");
    ok(fact.derivation_record_id !== null, "derivation_record_id !== null (DR still written)");
  });

  // =========================================================================
  // Scenario 3 — Multi-claim conflict (synthetic, no closure applied)
  // =========================================================================
  // Two overlapping active tenant_active claims with neither superseded:
  // mirrors rent_for_unit's conflict case exactly. The latest by
  // (valid_from DESC, created_at DESC) wins; the other becomes a conflict.
  console.log("\n--- Scenario 3: Conflict — two active tenant_active claims, no closure ---");
  await withRollback(async (tx) => {
    const subj = testSubject("conflict");
    const claimAId = await insertTenantClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { tenants: [{ name: "Schmidt, Anna", is_legal_entity: false }] },
      valid_from: "2024-01-01",
      valid_to: null,
      confidence: "high",
    });
    const claimBId = await insertTenantClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { tenants: [{ name: "Müller, Klaus", is_legal_entity: false }] },
      valid_from: "2024-06-01",
      valid_to: null,
      confidence: "high",
    });

    const unitRef = subj.replace(/^unit:/, "");
    const fact = await tenantForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.status === "latest_active_claim_with_conflicts",
      "status === latest_active_claim_with_conflicts");
    ok(fact.value!.name === "Müller, Klaus", "winner is B (latest valid_from)");
    ok(fact.conflicts.length === 1, "conflicts.length === 1");
    ok(fact.conflicts[0].claim_id === claimAId, "conflicts[0].claim_id === A.id");
    ok(fact.conflicts[0].reason === "superseded_by_later_claim",
      "conflicts[0].reason === superseded_by_later_claim");
    ok(fact.confidence === "medium", "confidence downgraded high → medium");
    ok(fact.source_claim_ids.length === 2, "source_claim_ids.length === 2");
    ok(fact.source_claim_ids[0] === claimBId, "source_claim_ids[0] === winner (B)");
    ok(fact.resolver.name === "tenant_for_unit", "resolver.name === tenant_for_unit");
  });

  console.log(`\n✓ ${passed} tenant_for_unit integration assertions passed`);
}

run()
  .catch((err) => {
    console.error(`\n✗ FAILED after ${passed} assertions:`, err.message);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
