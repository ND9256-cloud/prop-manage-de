// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>
//
// rent_roll composer module integration tests. ≥20 assertions across scenarios.
// Uses the live demo org (KO132 and HHS55) as the primary fixture: KO132 EG is
// the canonical "phantom vacancy" (no claim ever emitted) and KO132 1.OG is
// Lena's €650, the end-to-end proof of the full chain.

import { prisma } from "../../lib/db";
import { composePropertySnapshot } from "../../lib/composer/property-snapshot";
import {
  mapOccupancy,
  RENT_ROLL_MODULE_NAME,
  type RentRollSnapshot,
} from "../../lib/composer/modules/rent-roll";

let passed = 0;

const TEST_ORG_ID = process.env.TEST_ORG_ID || "310131df-d6ed-4007-83c2-ac69a7e9df42";
const KO132_ID = "f37448e4-11ae-453c-ac3c-850385039c0b";
const HHS55_ID = "d2e8e9c7-957a-4e0f-8150-452c21bcae56";

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

function getSnapshot(modules: { rent_roll?: { data: unknown } }): RentRollSnapshot {
  const m = modules.rent_roll;
  if (!m) throw new Error("rent_roll module missing from snapshot");
  return m.data as RentRollSnapshot;
}

async function main() {
  // =========================================================================
  // Scenario 1 — KO132 full rent roll (3 rows)
  // =========================================================================
  console.log("\n--- Scenario 1: KO132 full rent roll (3 rows) ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const m = snap.modules.rent_roll!;
    ok(m.completeness === "complete" || m.completeness === "partial", "rent_roll completeness is complete or partial");
    const data = getSnapshot(snap.modules);
    ok(Array.isArray(data.rows), "snapshot.data.rows is an array");
    ok(data.rows.length === 3, "KO132 yields 3 rows (EG, 1.OG, DG)");

    const byUnit: Record<string, (typeof data.rows)[number]> = {};
    for (const r of data.rows) byUnit[r.unit_ref] = r;
    ok(byUnit["EG"] !== undefined, "row for EG present");
    ok(byUnit["1.OG"] !== undefined, "row for 1.OG present");
    ok(byUnit["DG"] !== undefined, "row for DG present");

    // 1.OG = Lena €650 (65000 cents). Live data currently has multiple active
    // claims for this subject, so the resolver returns the winner +
    // conflicts (latest_active_claim_with_conflicts → needs_review). The
    // END-TO-END proof is that Lena's value flows through unchanged regardless
    // of how many duplicates exist.
    const lena = byUnit["1.OG"];
    ok(
      lena.occupancy_status === "occupied" || lena.occupancy_status === "needs_review",
      "1.OG (Lena) is occupied or needs_review (live data may have duplicate claims)"
    );
    ok(
      lena.current_kaltmiete.status === "single_active_claim" ||
        lena.current_kaltmiete.status === "latest_active_claim_with_conflicts",
      "1.OG resolver status is single or with-conflicts (depending on live duplicate count)"
    );
    ok(lena.current_kaltmiete.value?.amount === 65000, "1.OG kaltmiete.amount === 65000 (€650 in cents) — the end-to-end proof");
    ok(lena.current_kaltmiete.value?.currency === "EUR", "1.OG currency === EUR");
    ok(lena.current_kaltmiete.source_claim_ids.length > 0, "1.OG source_claim_ids non-empty (provenance for 3.3 modal)");
    ok(lena.current_kaltmiete.source_document_ids.length > 0, "1.OG source_document_ids non-empty (provenance for 3.3 modal)");

    // EG = phantom vacancy (no claim ever)
    const eg = byUnit["EG"];
    ok(eg.occupancy_status === "vacant", "EG is vacant");
    ok(eg.vacancy_reason === "no_data", "EG vacancy_reason === 'no_data' (phantom vacancy — no lease on file)");
    ok(eg.current_kaltmiete.status === "no_active_claim", "EG resolver status === no_active_claim");
    ok(eg.current_kaltmiete.value === null, "EG kaltmiete.value === null (no claim)");

    // DG: depending on live data Kuru's claim may or may not be present.
    // Either way the row resolves cleanly into one of the three valid states.
    const dg = byUnit["DG"];
    ok(
      dg.occupancy_status === "occupied" ||
        dg.occupancy_status === "vacant" ||
        dg.occupancy_status === "needs_review",
      "DG resolves to a valid occupancy_status"
    );
    if (dg.occupancy_status === "occupied") {
      ok(typeof dg.current_kaltmiete.value?.amount === "number" && dg.current_kaltmiete.value!.amount > 0, "DG kaltmiete.amount is a positive number");
    }

    // Summary
    ok(data.summary.total_units === 3, "summary.total_units === 3");
    ok(data.summary.occupied_units + data.summary.vacant_units + data.summary.needs_review_units === 3, "occupied + vacant + needs_review === total_units");
    ok(data.summary.vacant_units >= 1, "summary.vacant_units >= 1 (EG)");
    ok(
      Math.abs(data.summary.vermietungsquote - data.summary.occupied_units / 3) < 1e-9,
      "vermietungsquote === occupied / total"
    );

    // Structural passthrough from Unit table
    ok(
      typeof lena.size_sqm === "number" || lena.size_sqm === null,
      "1.OG.size_sqm is number or null (Unit passthrough)"
    );
    ok(
      typeof lena.floor === "number" || lena.floor === null,
      "1.OG.floor is number or null (Unit passthrough)"
    );

    // tenant_active: typed-but-unavailable
    ok(lena.tenant_active.status === "unavailable", "tenant_active.status === 'unavailable' (no tenant resolver shipped)");
    ok(lena.tenant_active.reason === "no_tenant_resolver", "tenant_active.reason === 'no_tenant_resolver'");
    ok(
      m.warnings.some((w) => w.module === RENT_ROLL_MODULE_NAME && w.code === "tenant_resolver_unavailable"),
      "module warning flags tenant_resolver_unavailable follow-up"
    );

    // Module-level provenance aggregation
    ok(Array.isArray(m.input_claim_ids), "module input_claim_ids is an array");
    ok(m.input_claim_ids.length >= lena.current_kaltmiete.source_claim_ids.length, "module input_claim_ids includes Lena's claim ids");
    ok(typeof m.resolver_versions["rent_for_unit"] === "string" && m.resolver_versions["rent_for_unit"].length > 0, "resolver_versions records rent_for_unit version");
  }

  // =========================================================================
  // Scenario 2 — HHS55 rent roll (2 rows)
  // =========================================================================
  console.log("\n--- Scenario 2: HHS55 rent roll (2 rows) ---");
  {
    const snap = await composePropertySnapshot({
      property_id: HHS55_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const data = getSnapshot(snap.modules);
    ok(data.rows.length === 2, "HHS55 yields 2 rows");
    ok(data.summary.total_units === 2, "summary.total_units === 2");
    const units = data.rows.map((r) => r.unit_ref).sort();
    ok(units.join(",") === "1.OG,DG", "HHS55 units === {1.OG, DG}");
  }

  // =========================================================================
  // Scenario 3 — Provenance present on every row with a resolved value
  // =========================================================================
  console.log("\n--- Scenario 3: provenance on rows with a resolved value ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const data = getSnapshot(snap.modules);
    // A row carries provenance whenever the resolver returned a value (occupied
    // OR needs_review when duplicate claims exist). Vacant rows correctly have
    // empty source arrays.
    const withValue = data.rows.filter((r) => r.current_kaltmiete.value !== null);
    ok(withValue.length >= 1, "at least one row carries a resolved kaltmiete value");
    for (const r of withValue) {
      ok(r.current_kaltmiete.source_claim_ids.length > 0, `${r.unit_ref}: source_claim_ids non-empty`);
      ok(r.current_kaltmiete.source_document_ids.length > 0, `${r.unit_ref}: source_document_ids non-empty (3.3 click-through)`);
      ok(r.current_kaltmiete.resolver.name === "rent_for_unit", `${r.unit_ref}: resolver.name === rent_for_unit`);
    }
  }

  // =========================================================================
  // Scenario 4 — mapOccupancy covers every resolver status (unit-level)
  // =========================================================================
  console.log("\n--- Scenario 4: mapOccupancy mapping ---");
  {
    const a = mapOccupancy("single_active_claim");
    ok(a.occupancy_status === "occupied" && a.vacancy_reason === null, "single_active_claim → occupied + null");

    const b = mapOccupancy("no_claim_for_date");
    ok(b.occupancy_status === "vacant" && b.vacancy_reason === "tenancy_ended", "no_claim_for_date → vacant + tenancy_ended");

    const c = mapOccupancy("no_active_claim");
    ok(c.occupancy_status === "vacant" && c.vacancy_reason === "no_data", "no_active_claim → vacant + no_data (phantom vacancy)");

    const d = mapOccupancy("latest_active_claim_with_conflicts");
    ok(d.occupancy_status === "needs_review" && d.vacancy_reason === null, "latest_active_claim_with_conflicts → needs_review + null");

    const e = mapOccupancy("some_unknown_future_status");
    ok(e.occupancy_status === "needs_review" && e.vacancy_reason === null, "unknown status falls back to needs_review (defensive)");
  }

  // =========================================================================
  // Scenario 5 — Summary math
  // =========================================================================
  console.log("\n--- Scenario 5: summary math ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const data = getSnapshot(snap.modules);
    const occupiedRows = data.rows.filter((r) => r.occupancy_status === "occupied");
    const expectedTotal = occupiedRows.reduce(
      (sum, r) => sum + (r.current_kaltmiete.value?.amount ?? 0),
      0
    );
    ok(
      (data.summary.resolved_kaltmiete_total?.amount ?? 0) === expectedTotal,
      "resolved_kaltmiete_total.amount === sum of occupied rows' kaltmiete amounts"
    );
    if (occupiedRows.length > 0) {
      ok(
        data.summary.resolved_kaltmiete_total?.currency === "EUR",
        "resolved_kaltmiete_total.currency === EUR"
      );
    }
    const vqExpected = data.summary.occupied_units / data.summary.total_units;
    ok(Math.abs(data.summary.vermietungsquote - vqExpected) < 1e-9, "vermietungsquote === occupied_units / total_units");
    ok(data.summary.vermietungsquote >= 0 && data.summary.vermietungsquote <= 1, "vermietungsquote is in [0, 1]");
  }

  // =========================================================================
  // Scenario 6 — Replaces the 3.1 stub in the composer registry
  // =========================================================================
  console.log("\n--- Scenario 6: registry replacement (no stub warning) ---");
  {
    const snap = await composePropertySnapshot({
      property_id: KO132_ID,
      org_id: TEST_ORG_ID,
      modules: ["rent_roll"],
    });
    const m = snap.modules.rent_roll!;
    ok(
      m.warnings.every((w) => w.code !== "not_implemented"),
      "no 'not_implemented' warning (3.1 stub replaced)"
    );
    ok(m.completeness !== "unavailable", "completeness is not 'unavailable' (real module shipped)");
  }

  console.log(`\n=== composer/rent-roll: ${passed} assertions — ALL OK ===\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
