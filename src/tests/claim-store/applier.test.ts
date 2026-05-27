// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>
// -r dotenv/config preloads env before any module, so db.ts sees DATABASE_URL.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/db";
import { applyEmission } from "../../lib/claim-store/applier";
import type { EmissionResult, Claim, ClaimClosure } from "../../lib/emitters/types.ts";
import type { ApplyContext } from "../../lib/claim-store/types.ts";

let passed = 0;
const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

// --- Helpers ----------------------------------------------------------------

let testPropertyId: string | null = null;

async function getTestPropertyId(): Promise<string> {
  if (testPropertyId) return testPropertyId;
  // @tenant-isolation-disable-next-line -- reason: test helper fetching property id for claim-store integration tests, org scoped by TEST_ORG_ID constant
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Property" WHERE "organizationId" = ${TEST_ORG_ID}::uuid LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No property found for org ${TEST_ORG_ID}`);
  testPropertyId = rows[0].id;
  return testPropertyId;
}

function makeClaim(overrides: Partial<Claim> & { property_id: string }): Claim {
  return {
    subject: "unit:1.OG",
    predicate: "kaltmiete",
    value: { amount: 650, currency: "EUR" },
    claim_kind: "assertion",
    valid_from: "2025-04-01",
    valid_to: null,
    source_document_id: randomUUID(),
    source_extraction_run_id: randomUUID(),
    source_field_path: "fields.kaltmiete",
    confidence: "high",
    evidence_id: null,
    source_type: "document_extraction",
    human_actor_id: null,
    ...overrides,
  };
}

function makeContext(propertyId: string, overrides?: Partial<ApplyContext>): ApplyContext {
  return {
    property_id: propertyId,
    org_id: TEST_ORG_ID,
    extraction_run_id: randomUUID(),
    emitter_version: "1.0.0",
    ...overrides,
  };
}

async function insertSeedClaim(tx: any, claim: Claim): Promise<string> {
  // @tenant-isolation-disable-next-line -- reason: test helper inserting seed claim for claim-store integration tests
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.claims (
      property_id, subject, predicate, value, claim_kind, source_type,
      valid_from, valid_to,
      source_document_id, source_extraction_run_id, source_field_path,
      human_actor_id, confidence, evidence_id
    ) VALUES (
      ${claim.property_id}::uuid, ${claim.subject}, ${claim.predicate},
      ${JSON.stringify(claim.value)}::jsonb, ${claim.claim_kind}, ${claim.source_type},
      ${claim.valid_from}::date, ${claim.valid_to ?? null}::date,
      ${claim.source_document_id}::uuid,
      ${claim.source_extraction_run_id ? claim.source_extraction_run_id : null}::uuid,
      ${claim.source_field_path},
      ${claim.human_actor_id ? claim.human_actor_id : null}::uuid, ${claim.confidence},
      ${claim.evidence_id ? claim.evidence_id : null}::uuid
    ) RETURNING id
  `;
  return rows[0].id;
}

async function getClaimById(tx: any, id: string) {
  // @tenant-isolation-disable-next-line -- reason: test helper reading claim state for assertion in claim-store integration tests
  const rows = await tx.$queryRaw<any[]>`
    SELECT * FROM warehouse.claims WHERE id = ${id}::uuid
  `;
  return rows[0] ?? null;
}

/**
 * Run a test inside a Prisma transaction, then rollback.
 * This avoids GoBD-blocked DELETEs.
 */
async function withRollback(fn: (tx: any) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Error("rollback");
    });
  } catch (e: any) {
    if (e.message !== "rollback") throw e;
  }
}

// --- Scenarios ---------------------------------------------------------------

async function scenario1_mietvertragHappyPath() {
  console.log("\nScenario 1 — Mietvertrag happy path");
  const propertyId = await getTestPropertyId();
  const extractionRunId = randomUUID();
  const docId = randomUUID();

  await withRollback(async (tx) => {
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          predicate: "kaltmiete",
          value: { amount: 650, currency: "EUR" },
          source_document_id: docId,
          source_extraction_run_id: extractionRunId,
          source_field_path: "fields.kaltmiete",
        }),
        makeClaim({
          property_id: propertyId,
          predicate: "tenant_active",
          value: { tenants: [{ name: "Everding, Lena" }] },
          source_document_id: docId,
          source_extraction_run_id: extractionRunId,
          source_field_path: "fields.tenant_identity",
        }),
      ],
      closure_intents: [],
    };
    const ctx = makeContext(propertyId, { extraction_run_id: extractionRunId });

    const result = await applyEmission(emission, ctx, { tx });

    // 1. 2 claims inserted, 0 closures, 2 DerivationRecords
    ok(result.inserted_claim_ids.length === 2, "2 claims inserted");
    ok(result.applied_closure_ids.length === 0, "0 closures applied");
    ok(result.derivation_record_ids.length === 2, "2 DerivationRecords written");

    // 2. Verify kaltmiete claim in DB
    const kaltmiete = await getClaimById(tx, result.inserted_claim_ids[0]);
    ok(kaltmiete.predicate === "kaltmiete", "kaltmiete claim has correct predicate");
    ok(kaltmiete.subject === "unit:1.OG", "kaltmiete claim has correct subject");

    // 3. Verify tenant_active claim
    const tenant = await getClaimById(tx, result.inserted_claim_ids[1]);
    ok(tenant.predicate === "tenant_active", "tenant_active claim has correct predicate");
    const tenantValue = typeof tenant.value === "string" ? JSON.parse(tenant.value) : tenant.value;
    ok(tenantValue.tenants[0].name === "Everding, Lena", 'tenant_active has tenants[0].name = "Everding, Lena"');

    // 4. Verify DerivationRecord
    // @tenant-isolation-disable-next-line -- reason: test helper reading derivation record for assertion in claim-store integration tests
    const dr = await tx.$queryRaw<any[]>`
      SELECT * FROM warehouse.derivation_records WHERE id = ${result.derivation_record_ids[0]}::uuid
    `;
    ok(dr[0].output_type === "claim", 'DerivationRecord output_type = "claim"');
    ok(dr[0].emitter_version === "1.0.0", 'DerivationRecord emitter_version = "1.0.0"');

    // 5. Idempotency: re-run same emission
    const result2 = await applyEmission(emission, ctx, { tx });
    ok(result2.inserted_claim_ids.length === 0, "Re-run: 0 new claims inserted");
    ok(result2.skipped_duplicate_claim_ids.length === 2, "Re-run: 2 duplicates skipped");
  });
}

async function scenario2_crossPropertyRejection() {
  console.log("\nScenario 2 — Cross-property rejection");
  const propertyId = await getTestPropertyId();
  const wrongPropertyId = randomUUID();

  // 6. Claim property_id ≠ context property_id
  const emission: EmissionResult = {
    claims_to_insert: [
      makeClaim({ property_id: wrongPropertyId }),
    ],
    closure_intents: [],
  };
  const ctx = makeContext(propertyId);

  let threw = false;
  try {
    await applyEmission(emission, ctx);
  } catch (e: any) {
    threw = true;
    ok(e.message.includes("does not match"), "Cross-property claim throws with correct message");
  }
  ok(threw, "Cross-property claim throws before any insert");

  // 7. Property not in org
  await withRollback(async (tx) => {
    const wrongOrgCtx = makeContext(propertyId, { org_id: randomUUID() });
    const validEmission: EmissionResult = {
      claims_to_insert: [makeClaim({ property_id: propertyId })],
      closure_intents: [],
    };
    let orgThrew = false;
    try {
      await applyEmission(validEmission, wrongOrgCtx, { tx });
    } catch (e: any) {
      orgThrew = true;
      ok(e.message.includes("does not belong to org"), "Wrong org throws with correct message");
    }
    ok(orgThrew, "Wrong org throws before any write");
  });
}

async function scenario3_mieterhoeungCloseOverlappingOnly() {
  console.log("\nScenario 3 — Mieterhöhung close_overlapping_only");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 8. Setup: insert base kaltmiete
    const baseKaltmiete = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 600, currency: "EUR" },
      valid_from: "2024-01-01",
    });
    const baseId = await insertSeedClaim(tx, baseKaltmiete);

    // 9. Apply synthetic Mieterhöhung
    const eventClaim = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete_amended",
      claim_kind: "event",
      value: { new_amount: 700, currency: "EUR" },
      valid_from: "2026-01-01",
    });
    const newKaltmiete = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 700, currency: "EUR" },
      valid_from: "2026-01-01",
    });

    const emission: EmissionResult = {
      claims_to_insert: [eventClaim, newKaltmiete],
      closure_intents: [{
        target_subject: "unit:1.OG",
        target_predicates: ["kaltmiete"],
        close_at: "2026-01-01",
        close_mode: "close_overlapping_only",
        match: {},
        match_strictness: "absent",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 10. Previous kaltmiete closed
    const closed = await getClaimById(tx, baseId);
    const closedValidTo = closed.valid_to instanceof Date
      ? closed.valid_to.toISOString().slice(0, 10)
      : String(closed.valid_to);
    ok(closedValidTo === "2026-01-01", "Base kaltmiete valid_to set to 2026-01-01");
    ok(closed.superseded_by_claim_id === null, "Base kaltmiete superseded_by_claim_id NOT set (close_overlapping_only per §5.5.3)");

    // 11. 1 closure row
    ok(result.applied_closure_ids.length === 1, "1 claim_closure inserted");

    // 12. DerivationRecord for closure
    // @tenant-isolation-disable-next-line -- reason: test helper reading derivation record for closure assertion in claim-store integration tests
    const closureDrs = await tx.$queryRaw<any[]>`
      SELECT * FROM warehouse.derivation_records
      WHERE output_type = 'closure' AND output_id = ${result.applied_closure_ids[0]}::uuid
    `;
    ok(closureDrs.length === 1, "DerivationRecord for closure exists");
    ok(closureDrs[0].output_type === "closure", 'Closure DR has output_type = "closure"');
  });
}

async function scenario4_staffelmieteConflict() {
  console.log("\nScenario 4 — Staffelmiete conflict blocker");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 13. Setup: base + future kaltmiete
    const baseKaltmiete = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 600, currency: "EUR" },
      valid_from: "2024-01-01",
    });
    await insertSeedClaim(tx, baseKaltmiete);

    const futureKaltmiete = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 650, currency: "EUR" },
      valid_from: "2026-07-01",
    });
    await insertSeedClaim(tx, futureKaltmiete);

    // 14. Apply Mieterhöhung with close_at before the future claim
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          predicate: "kaltmiete_amended",
          claim_kind: "event",
          value: { new_amount: 700, currency: "EUR" },
          valid_from: "2026-01-01",
        }),
      ],
      closure_intents: [{
        target_subject: "unit:1.OG",
        target_predicates: ["kaltmiete"],
        close_at: "2026-01-01",
        close_mode: "close_overlapping_only",
        match: {},
        match_strictness: "absent",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 15. Blocked: event claim inserted, no closures
    ok(result.inserted_claim_ids.length === 1, "Event claim still inserted");
    ok(result.applied_closure_ids.length === 0, "No closures applied (blocked)");
    ok(result.blocked_closure_intents.length === 1, "1 blocked closure intent");
    ok(
      result.blocked_closure_intents[0].reason === "staffelmiete_conflict",
      'Blocker reason is "staffelmiete_conflict"'
    );
  });
}

async function scenario5_kuendigungCloseOverlappingAndFuture() {
  console.log("\nScenario 5 — Kündigung close_overlapping_and_future");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 16. Setup: base kaltmiete + future kaltmiete + tenant_active
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 600, currency: "EUR", tenants: [{ name: "Everding, Lena" }] },
      valid_from: "2024-01-01",
    }));
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 700, currency: "EUR", tenants: [{ name: "Everding, Lena" }] },
      valid_from: "2026-08-01",
      source_extraction_run_id: randomUUID(),
    }));
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      predicate: "tenant_active",
      value: { tenants: [{ name: "Everding, Lena" }] },
      valid_from: "2024-01-01",
    }));

    // 17. Apply Kündigung
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          predicate: "lease_terminated",
          claim_kind: "event",
          value: { terminating_parties: [{ name: "Everding, Lena" }] },
          valid_from: "2026-06-30",
        }),
      ],
      closure_intents: [{
        target_subject: "unit:1.OG",
        target_predicates: ["kaltmiete", "tenant_active"],
        close_at: "2026-06-30",
        close_mode: "close_overlapping_and_future",
        match: { tenant_identity: "Everding, Lena" },
        match_strictness: "required",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 18. All three claims closed
    ok(result.applied_closure_ids.length === 3, "3 claim_closures (base kaltmiete + future kaltmiete + tenant_active)");
  });
}

async function scenario6_multiTenantPartial() {
  console.log("\nScenario 6 — Multi-tenant partial Kündigung blocker");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 19. Setup: two tenant_active claims for same unit
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      predicate: "tenant_active",
      value: { tenants: [{ name: "Müller, Max" }] },
      valid_from: "2024-01-01",
      source_extraction_run_id: randomUUID(),
    }));
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      predicate: "tenant_active",
      value: { tenants: [{ name: "Schmidt, Anna" }] },
      valid_from: "2024-01-01",
      source_extraction_run_id: randomUUID(),
    }));

    // 20. Kündigung with only one tenant terminating
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          predicate: "lease_terminated",
          claim_kind: "event",
          value: { terminating_parties: [{ name: "Max Müller" }] },
          valid_from: "2026-06-30",
        }),
      ],
      closure_intents: [{
        target_subject: "unit:1.OG",
        target_predicates: ["tenant_active"],
        close_at: "2026-06-30",
        close_mode: "close_overlapping_and_future",
        match: { tenant_identity: "Max Müller" },
        match_strictness: "required",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 21. Blocked: event claim inserted, no closures
    ok(result.inserted_claim_ids.length === 1, "Event claim inserted");
    ok(result.applied_closure_ids.length === 0, "No closures (multi-tenant partial)");
    ok(result.blocked_closure_intents.length === 1, "1 blocked intent");
    ok(
      result.blocked_closure_intents[0].reason === "multi_tenant_partial",
      'Blocker reason is "multi_tenant_partial"'
    );
    ok(
      result.blocked_closure_intents[0].detail.includes("Schmidt, Anna"),
      "Detail mentions unmatched tenant"
    );
  });
}

async function scenario7_hofmannSafeguard() {
  console.log("\nScenario 7 — Eigentümerwechsel Hofmann safeguard");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 22. Setup: kaltmiete + tenant_active
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      subject: "unit:EG",
      predicate: "kaltmiete",
      value: { amount: 500, currency: "EUR" },
      valid_from: "2024-01-01",
    }));
    await insertSeedClaim(tx, makeClaim({
      property_id: propertyId,
      subject: "unit:EG",
      predicate: "tenant_active",
      value: { tenants: [{ name: "Paul, Julija" }] },
      valid_from: "2024-01-01",
      source_extraction_run_id: randomUUID(),
    }));

    // 23. Eigentümerwechsel trying to close tenant claims (malicious)
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          subject: "property",
          predicate: "ownership_transferred",
          claim_kind: "event",
          value: { new_owner: "New Owner GmbH" },
          valid_from: "2026-01-01",
        }),
      ],
      closure_intents: [{
        target_subject: "unit:EG",
        target_predicates: ["tenant_active", "kaltmiete"],
        close_at: "2026-01-01",
        close_mode: "close_overlapping_and_supersede_future",
        match: {},
        match_strictness: "absent",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 24. Blocked by Hofmann safeguard
    ok(result.blocked_closure_intents.length === 1, "1 blocked intent (Hofmann)");
    ok(
      result.blocked_closure_intents[0].reason === "vacant_possession_warning",
      'Blocker reason is "vacant_possession_warning"'
    );
    ok(result.applied_closure_ids.length === 0, "No closures applied (tenant-claims protected)");
  });
}

async function scenario8_humanAdjudication() {
  console.log("\nScenario 8 — Human adjudication path");
  const propertyId = await getTestPropertyId();
  const humanActorId = randomUUID();

  await withRollback(async (tx) => {
    // 25. Human adjudication claim
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          source_type: "human_adjudication",
          human_actor_id: humanActorId,
          source_extraction_run_id: null as any,
        }),
      ],
      closure_intents: [],
    };
    const ctx = makeContext(propertyId, {
      extraction_run_id: null,
      emitter_version: null,
    });
    const result = await applyEmission(emission, ctx, { tx });

    // 26. Claim inserted with correct source_type
    ok(result.inserted_claim_ids.length === 1, "Human adjudication claim inserted");
    const claim = await getClaimById(tx, result.inserted_claim_ids[0]);
    ok(claim.source_type === "human_adjudication", 'source_type = "human_adjudication"');
    ok(claim.human_actor_id === humanActorId, "human_actor_id matches");

    // DerivationRecord
    // @tenant-isolation-disable-next-line -- reason: test helper reading derivation record for human adjudication assertion
    const dr = await tx.$queryRaw<any[]>`
      SELECT * FROM warehouse.derivation_records WHERE id = ${result.derivation_record_ids[0]}::uuid
    `;
    ok(dr[0].emitter_version === null, "DerivationRecord emitter_version is null");
  });
}

async function scenario9_alreadySupersededNotReclosed() {
  console.log("\nScenario 9 — Already-superseded claim not re-closed");
  const propertyId = await getTestPropertyId();

  await withRollback(async (tx) => {
    // 27. Setup: insert and manually supersede a kaltmiete claim
    const baseClaim = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 500, currency: "EUR" },
      valid_from: "2024-01-01",
    });
    const baseId = await insertSeedClaim(tx, baseClaim);

    // Insert a reason claim to supersede with
    const reasonClaim = makeClaim({
      property_id: propertyId,
      predicate: "kaltmiete",
      value: { amount: 550, currency: "EUR" },
      valid_from: "2025-01-01",
      source_extraction_run_id: randomUUID(),
    });
    const reasonId = await insertSeedClaim(tx, reasonClaim);

    // Manually supersede the base claim
    // @tenant-isolation-disable-next-line -- reason: test helper manually superseding claim for already-superseded test scenario
    await tx.$executeRaw`
      UPDATE warehouse.claims
      SET valid_to = '2025-01-01'::date,
          superseded_at = now(),
          superseded_by_claim_id = ${reasonId}::uuid
      WHERE id = ${baseId}::uuid
    `;

    // 28. Apply Mieterhöhung targeting the same subject
    const emission: EmissionResult = {
      claims_to_insert: [
        makeClaim({
          property_id: propertyId,
          predicate: "kaltmiete_amended",
          claim_kind: "event",
          value: { new_amount: 700, currency: "EUR" },
          valid_from: "2026-01-01",
          source_extraction_run_id: randomUUID(),
        }),
      ],
      closure_intents: [{
        target_subject: "unit:1.OG",
        target_predicates: ["kaltmiete"],
        close_at: "2026-01-01",
        close_mode: "close_overlapping_only",
        match: {},
        match_strictness: "absent",
        blocker_status: "none",
      }],
    };
    const ctx = makeContext(propertyId);
    const result = await applyEmission(emission, ctx, { tx });

    // 29. The already-superseded claim should not be re-closed.
    // Only the non-superseded reasonClaim (valid_from 2025-01-01, still open) should be closed.
    ok(result.applied_closure_ids.length === 1, "Only 1 closure (non-superseded claim)");

    // Verify the superseded base claim was NOT touched again
    const base = await getClaimById(tx, baseId);
    const baseValidTo = base.valid_to instanceof Date
      ? base.valid_to.toISOString().slice(0, 10)
      : String(base.valid_to);
    ok(baseValidTo === "2025-01-01", "Already-superseded claim valid_to unchanged");
  });
}

// --- Main -------------------------------------------------------------------

async function run() {
  console.log("claim-store applier tests\n");

  await scenario1_mietvertragHappyPath();
  await scenario2_crossPropertyRejection();
  await scenario3_mieterhoeungCloseOverlappingOnly();
  await scenario4_staffelmieteConflict();
  await scenario5_kuendigungCloseOverlappingAndFuture();
  await scenario6_multiTenantPartial();
  await scenario7_hofmannSafeguard();
  await scenario8_humanAdjudication();
  await scenario9_alreadySupersededNotReclosed();

  console.log(`\n✓ ${passed} claim-store applier assertions passed across 9 scenarios`);
  if (passed < 30) {
    throw new Error(`Expected ≥30 assertions but only ${passed} passed`);
  }
}

run()
  .catch((err) => {
    console.error(`\nFAILED after ${passed} assertions:`, err.message);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
