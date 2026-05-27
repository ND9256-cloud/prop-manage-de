// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/db";
import { rentForUnit, RESOLVER_NAME, RESOLVER_VERSION } from "../../lib/resolvers/rent-for-unit";

let passed = 0;
const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

let testPropertyId: string | null = null;

// Generate unique subject per test run to avoid collisions with live claims
const TEST_RUN = randomUUID().slice(0, 8);
function testSubject(unit: string): string {
  return `unit:test-${TEST_RUN}-${unit}`;
}

async function getTestPropertyId(): Promise<string> {
  if (testPropertyId) return testPropertyId;
  // @tenant-isolation-disable-next-line -- reason: test helper fetching property id for resolver integration tests, org scoped by TEST_ORG_ID constant
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Property" WHERE "organizationId" = ${TEST_ORG_ID}::uuid LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No property found for org ${TEST_ORG_ID}`);
  testPropertyId = rows[0].id;
  return testPropertyId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertSeedClaim(tx: any, args: {
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
  // @tenant-isolation-disable-next-line -- reason: test helper inserting seed claim for resolver integration tests
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.claims (
      property_id, subject, predicate, value, claim_kind, source_type,
      valid_from, valid_to,
      source_document_id, source_extraction_run_id, source_field_path,
      human_actor_id, confidence, evidence_id, superseded_by_claim_id
    ) VALUES (
      ${args.property_id}::uuid, ${args.subject}, 'kaltmiete',
      ${JSON.stringify(args.value)}::jsonb, 'assertion', 'document_extraction',
      ${args.valid_from}::date, ${args.valid_to ?? null}::date,
      ${docId}::uuid, ${runId}::uuid, 'fields.kaltmiete',
      null, ${args.confidence}, null,
      ${args.superseded_by_claim_id ?? null}::uuid
    ) RETURNING id
  `;
  return rows[0].id;
}

// Wraps a test in a transaction that always rolls back
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRollback(fn: (tx: any) => Promise<void>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await fn(tx);
    throw new Error("rollback");
  }).catch((e) => {
    if (e.message !== "rollback") throw e;
  });
}

async function main() {
  const propertyId = await getTestPropertyId();

  // =========================================================================
  // Scenario 1 — Lena Everding (single_active_claim)
  // =========================================================================
  console.log("\n--- Scenario 1: Lena Everding (single_active_claim) ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s1");
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 65000, currency: "EUR" },
      valid_from: "2025-04-01",
      valid_to: null,
      confidence: "high",
    });

    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: subj, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value !== null, "value is not null");
    ok(fact.value!.amount === 65000, "value.amount === 65000");
    ok(fact.value!.currency === "EUR", "value.currency === EUR");
    ok(fact.confidence === "high", "confidence === high (no downgrade)");
    ok(fact.status === "single_active_claim", "status === single_active_claim");
    ok(fact.source_claim_ids.length === 1, "source_claim_ids.length === 1");
    ok(fact.conflicts.length === 0, "conflicts.length === 0");
    ok(fact.resolver.name === "rent_for_unit", "resolver.name === rent_for_unit");
    ok(fact.resolver.version === "1.0.0", "resolver.version === 1.0.0");
    ok(fact.derivation_record_id !== null, "derivation_record_id !== null");
  });

  // =========================================================================
  // Scenario 2 — Paul/Kuru-style Mieterhöhung (single winner after closure)
  // =========================================================================
  console.log("\n--- Scenario 2: Paul/Kuru Mieterhöhung (single winner after closure) ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s2");
    // Claim B first (so we have its ID for superseded_by)
    const claimBId = await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 57500, currency: "EUR" },
      valid_from: "2024-01-01",
      valid_to: null,
      confidence: "high",
    });

    // Claim A: closed, superseded by B
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 52500, currency: "EUR" },
      valid_from: "2022-06-01",
      valid_to: "2023-12-31",
      confidence: "high",
      superseded_by_claim_id: claimBId,
    });

    // Strip "unit:" prefix since rentForUnit adds it
    const unitRef = subj.replace(/^unit:/, "");
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, as_of_date: new Date("2025-01-01"), org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.status === "single_active_claim", "status === single_active_claim (only B active)");
    ok(fact.value!.amount === 57500, "value.amount === 57500");
  });

  // =========================================================================
  // Scenario 3 — Hofmann (single claim, no superseding events)
  // =========================================================================
  console.log("\n--- Scenario 3: Hofmann (single claim, long-standing) ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s3");
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 90000, currency: "EUR" },
      valid_from: "2010-06-01",
      valid_to: null,
      confidence: "high",
    });

    const unitRef = subj.replace(/^unit:/, "");
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value!.amount === 90000, "value.amount === 90000");
    ok(fact.status === "single_active_claim", "status === single_active_claim");
  });

  // =========================================================================
  // Scenario 4 — Conflict case (multi-claim, overlapping, no closure)
  // =========================================================================
  console.log("\n--- Scenario 4: Conflict case (multi-claim, overlapping) ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s4");
    const claimAId = await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 60000, currency: "EUR" },
      valid_from: "2024-01-01",
      valid_to: null,
      confidence: "high",
    });

    const claimBId = await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 65000, currency: "EUR" },
      valid_from: "2024-06-01",
      valid_to: null,
      confidence: "high",
    });

    const unitRef = subj.replace(/^unit:/, "");
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.status === "latest_active_claim_with_conflicts", "status === latest_active_claim_with_conflicts");
    ok(fact.value!.amount === 65000, "winner is B (value.amount === 65000)");
    ok(fact.conflicts.length === 1, "conflicts.length === 1");
    ok(fact.conflicts[0].claim_id === claimAId, "conflicts[0].claim_id === A.id");
    ok(fact.conflicts[0].reason === "superseded_by_later_claim", "conflicts[0].reason === superseded_by_later_claim");
    ok(fact.confidence === "medium", "confidence downgraded: high → medium");
    ok(fact.source_claim_ids.length === 2, "source_claim_ids.length === 2");
    ok(fact.source_claim_ids[0] === claimBId, "source_claim_ids[0] === winner (B)");
  });

  // =========================================================================
  // Scenario 5 — No active claim (no kaltmiete ever)
  // =========================================================================
  console.log("\n--- Scenario 5: No active claim (zero claims) ---");
  await withRollback(async (tx) => {
    // No seed claims for this unique subject
    const unitRef = `test-${TEST_RUN}-NONEXISTENT`;
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value === null, "value === null");
    ok(fact.status === "no_active_claim", "status === no_active_claim");
    ok(fact.confidence === "low", "confidence === low");
    ok(fact.derivation_record_id !== null, "derivation_record_id !== null (still wrote DR)");
  });

  // =========================================================================
  // Scenario 6 — Claim exists but as_of_date before valid_from
  // =========================================================================
  console.log("\n--- Scenario 6: Claim exists but as_of_date too early ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s6");
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 65000, currency: "EUR" },
      valid_from: "2025-04-01",
      valid_to: null,
      confidence: "high",
    });

    const unitRef = subj.replace(/^unit:/, "");
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, as_of_date: new Date("2020-01-01"), org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact.value === null, "value === null");
    ok(fact.status === "no_claim_for_date", "status === no_claim_for_date (distinct from no_active_claim)");
  });

  // =========================================================================
  // Scenario 7 — Org isolation
  // =========================================================================
  console.log("\n--- Scenario 7: Org isolation ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s7");
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 65000, currency: "EUR" },
      valid_from: "2025-04-01",
      valid_to: null,
      confidence: "high",
    });

    // Call with a different org_id — should get no results
    const fakeOrgId = randomUUID();
    const unitRef = subj.replace(/^unit:/, "");
    const fact = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: fakeOrgId },
      { tx }
    );

    ok(fact.value === null, "value === null (cross-org filtered out)");
    ok(fact.status === "no_active_claim", "status === no_active_claim (org isolation)");
  });

  // =========================================================================
  // Scenario 8 — unit: prefix idempotency
  // =========================================================================
  console.log("\n--- Scenario 8: unit: prefix idempotency ---");
  await withRollback(async (tx) => {
    const subj = testSubject("s8");
    await insertSeedClaim(tx, {
      property_id: propertyId,
      subject: subj,
      value: { amount: 65000, currency: "EUR" },
      valid_from: "2025-04-01",
      valid_to: null,
      confidence: "high",
    });

    const unitRef = subj.replace(/^unit:/, "");
    const fact1 = await rentForUnit(
      { property_id: propertyId, unit_ref: unitRef, org_id: TEST_ORG_ID },
      { tx }
    );

    // Pass with "unit:" prefix — should produce same result
    const fact2 = await rentForUnit(
      { property_id: propertyId, unit_ref: subj, org_id: TEST_ORG_ID },
      { tx }
    );

    ok(fact1.value!.amount === fact2.value!.amount, "both calls return same amount");
    ok(fact1.status === fact2.status, "both calls return same status");
  });

  console.log(`\n=== rent-for-unit: ${passed} assertions — ALL OK ===\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
