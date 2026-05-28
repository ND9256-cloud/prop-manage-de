// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>
//
// composePropertySnapshot integration tests. ≥18 assertions across 6 scenarios.
// Each scenario that mutates state wraps in a Prisma transaction that always
// rolls back (mirror of src/tests/resolvers/rent-for-unit.test.ts).

import assert from "node:assert/strict";
import { prisma } from "../../lib/db";
import {
  COMPOSER_VERSION,
  composePropertySnapshot,
} from "../../lib/composer/property-snapshot";
import { hashClaimIds } from "../../lib/composer/property-snapshot";

let passed = 0;

const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";
const KO132_ID = "f37448e4-11ae-453c-ac3c-850385039c0b";
const HHS55_ID = "d2e8e9c7-957a-4e0f-8150-452c21bcae56";

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

// Wraps a test in a transaction that always rolls back
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRollback(fn: (tx: any) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(async (tx) => {
      await fn(tx);
      throw new Error("rollback");
    })
    .catch((e) => {
      if (e.message !== "rollback") throw e;
    });
}

async function main() {
  // =========================================================================
  // Scenario 1 — CorePropertySnapshot from real data (KO132)
  // =========================================================================
  console.log("\n--- Scenario 1: CorePropertySnapshot from real data (KO132) ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: [],
    });

    ok(snap.core.property_id === KO132_ID, "core.property_id === KO132");
    ok(snap.core.org_id === TEST_ORG_ID, "core.org_id === TEST_ORG_ID");
    ok(snap.core.short_code === "KO132", "core.short_code === KO132");
    ok(snap.core.address === "Korbacher Straße 132", "core.address matches");
    ok(snap.core.total_sqm === 280, "core.total_sqm === 280 (parsed from Decimal)");
    ok(snap.core.unit_count === 3, "core.unit_count === 3 (computed from Unit table)");
    ok(Array.isArray(snap.core.unit_refs) && snap.core.unit_refs.length === 3, "unit_refs has 3 entries");

    ok(typeof snap.metadata.composed_at === "string" && !isNaN(Date.parse(snap.metadata.composed_at)), "metadata.composed_at parseable");
    ok(Object.keys(snap.metadata.completeness).length === 0, "metadata.completeness empty (no modules requested)");
    ok(snap.metadata.warnings.length === 0, "metadata.warnings empty");
  }

  // =========================================================================
  // Scenario 2 — Unknown module → unavailable
  // =========================================================================
  console.log("\n--- Scenario 2: Unknown module → unavailable ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["nonexistent_module"],
    });
    const m = snap.modules.nonexistent_module;
    ok(m !== undefined, "modules.nonexistent_module exists");
    ok(m!.completeness === "unavailable", "completeness === unavailable");
    ok(m!.warnings.some((w) => w.code === "unknown_module"), "warning with code 'unknown_module'");
    ok(snap.metadata.completeness.nonexistent_module === "unavailable", "metadata.completeness.nonexistent_module === unavailable");
  }

  // =========================================================================
  // Scenario 3 — rent_roll stub returns unavailable (until Task 3.2)
  // =========================================================================
  console.log("\n--- Scenario 3: rent_roll stub (flips to 'complete' when 3.2 lands) ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const m = snap.modules.rent_roll;
    ok(m !== undefined, "modules.rent_roll exists");
    ok(m!.completeness === "unavailable", "rent_roll completeness === unavailable (3.1 stub)");
    ok(m!.warnings.some((w) => w.code === "not_implemented"), "rent_roll warning code === not_implemented");
  }

  // =========================================================================
  // Scenario 4 — claim_snapshot_version is deterministic + stable
  // =========================================================================
  console.log("\n--- Scenario 4: claim_snapshot_version stable + deterministic ---");
  {
    const a = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: [],
    });
    const b = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: [],
    });
    ok(typeof a.metadata.claim_snapshot_version === "string" && a.metadata.claim_snapshot_version.length > 0, "claim_snapshot_version is non-empty string");
    ok(a.metadata.claim_snapshot_version === b.metadata.claim_snapshot_version, "claim_snapshot_version identical across calls (deterministic)");

    // Unit-test the hash directly: order independence.
    const h1 = hashClaimIds(["a", "b", "c"]);
    const h2 = hashClaimIds(["c", "a", "b"]);
    ok(h1 === h2, "hashClaimIds is order-independent (sorts before hashing)");

    const h3 = hashClaimIds([]);
    ok(typeof h3 === "string" && h3.length === 64, "hashClaimIds([]) returns a 64-hex-char SHA-256 digest");
  }

  // =========================================================================
  // Scenario 5 — DerivationRecord written
  // =========================================================================
  console.log("\n--- Scenario 5: DerivationRecord written with output_type='property_snapshot' ---");
  await withRollback(async (tx) => {
    await composePropertySnapshot(
      { property_id: KO132_ID, org_id: TEST_ORG_ID, modules: ["rent_roll"] },
      { tx }
    );
    // @tenant-isolation-disable-next-line -- reason: test verifies derivation_records insert; property already org-scoped by composer call above
    const rows = await tx.$queryRaw<{
      composer_version: string | null;
      input_claim_ids: string[];
      output_type: string;
      property_id: string;
    }[]>`
      SELECT composer_version, input_claim_ids, output_type, property_id
      FROM warehouse.derivation_records
      WHERE property_id = ${KO132_ID}::uuid
        AND output_type = 'property_snapshot'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    ok(rows.length === 1, "derivation_records: exactly one property_snapshot row found");
    ok(rows[0].output_type === "property_snapshot", "output_type === property_snapshot");
    ok(rows[0].composer_version === COMPOSER_VERSION, `composer_version === ${COMPOSER_VERSION}`);
    ok(Array.isArray(rows[0].input_claim_ids), "input_claim_ids is an array (empty is fine for 3.1)");
  });

  // =========================================================================
  // Scenario 6 — HHS55 core
  // =========================================================================
  console.log("\n--- Scenario 6: HHS55 core ---");
  {
    const snap = await composePropertySnapshot({
      property_id: HHS55_ID,
      org_id: TEST_ORG_ID,
      modules: [],
    });
    ok(snap.core.short_code === "HHS55", "core.short_code === HHS55");
    ok(snap.core.unit_count === 0, "core.unit_count === 0 (no Unit rows)");
    ok(snap.core.unit_refs.length === 0, "core.unit_refs is empty array");
    ok(snap.core.total_sqm === null, "core.total_sqm === null (HHS55 has no total_sqm)");
  }

  // =========================================================================
  // Scenario 7 — Cross-org access denied
  // =========================================================================
  console.log("\n--- Scenario 7: Cross-org access denied ---");
  {
    let threw = false;
    try {
      await composePropertySnapshot({
        property_id: KO132_ID,
        org_id: "00000000-0000-0000-0000-000000000000",
        modules: [],
      });
    } catch (e) {
      threw = true;
      ok(/not found in org/.test((e as Error).message), "error message mentions org scoping");
    }
    ok(threw, "composePropertySnapshot throws when property is in a different org");
  }

  console.log(`\n=== composer/property-snapshot: ${passed} assertions — ALL OK ===\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
