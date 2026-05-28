// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>
//
// Happy-path + acceptance tests for the Presenter. Architecture §5.4.6.
//
// Includes the Lena Everding acceptance criterion: the canonical end-to-end
// fact from the v2 plan (KO132 1.OG, €650, Mietvertrag, valid from 2025-04-01)
// must be rendered as German prose that mentions €650, the source document
// type, and the effective date.
//
// Non-determinism: positive assertions are case-insensitive substring; we
// list multiple acceptable phrasings ("must_contain_any") where appropriate.

import { renderPropertySnapshot, renderResolvedFact, PRESENTER_VERSION } from "../../lib/presenter/render";
import type { ResolvedFact, Money } from "../../lib/resolvers/types";
import type { PropertySnapshot } from "../../lib/composer/types";

let passed = 0;

function ok(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${passed}. ${msg}`);
}

function containsAny(prose: string, options: string[]): boolean {
  const lp = prose.toLowerCase();
  return options.some((o) => lp.includes(o.toLowerCase()));
}

function contains(prose: string, s: string): boolean {
  return prose.toLowerCase().includes(s.toLowerCase());
}

// Build a ResolvedFact<Money> for Lena's rent. The shipped ResolvedFact type
// doesn't carry validity windows directly (per src/lib/resolvers/types.ts);
// valid_from lives on conflict entries and the query's as_of_date. We pass
// the canonical Lena valid_from in via the `query` object (which is typed
// Record<string, unknown> and can carry arbitrary descriptive keys) so the
// LLM sees the effective date in its JSON input. This is the spec's
// acceptance criterion (the date must appear in the prose).
function lenaFact(): ResolvedFact<Money> {
  return {
    query: {
      property_id: "f37448e4-11ae-453c-ac3c-850385039c0b",
      unit_ref: "1.OG",
      org_id: "310131df-d6ed-4007-83c2-ac69a7e9df42",
      as_of_date: "2025-04-01",
      valid_from: "2025-04-01",
    },
    value: { amount: 65000, currency: "EUR" },
    confidence: "high",
    status: "single_active_claim",
    source_claim_ids: ["claim-lena-fixture-id"],
    source_document_ids: ["doc-lena-mietvertrag-id"],
    conflicts: [],
    derivation_record_id: null,
    resolver: { name: "rent_for_unit", version: "1.0.0" },
    generated_at: "2026-05-28T10:00:00Z",
  };
}

function ko132Snapshot(): PropertySnapshot {
  return {
    core: {
      property_id: "f37448e4-11ae-453c-ac3c-850385039c0b",
      org_id: "310131df-d6ed-4007-83c2-ac69a7e9df42",
      short_code: "KO132",
      address: "Korbacher Straße 132, 34132 Kassel",
      total_sqm: null,
      unit_count: 3,
      unit_refs: ["EG", "1.OG", "DG"],
    },
    modules: {
      rent_roll: {
        completeness: "complete",
        data: {
          rows: [
            {
              unit_ref: "EG",
              occupancy_status: "vacant",
              vacancy_reason: "no_data",
              current_kaltmiete: {
                query: {},
                value: null,
                confidence: "low",
                status: "no_active_claim",
                source_claim_ids: [],
                source_document_ids: [],
                conflicts: [],
                derivation_record_id: null,
                resolver: { name: "rent_for_unit", version: "1.0.0" },
                generated_at: "2026-05-28T10:00:00Z",
              },
              tenant_active: {
                status: "unavailable",
                reason: "no_tenant_resolver",
                resolver: { name: "tenant_for_unit", version: "unshipped" },
              },
              size_sqm: null,
              floor: 0,
              rooms: null,
              target_cold_rent: null,
            },
            {
              unit_ref: "1.OG",
              occupancy_status: "occupied",
              vacancy_reason: null,
              current_kaltmiete: {
                query: { valid_from: "2025-04-01" },
                value: { amount: 65000, currency: "EUR" },
                confidence: "high",
                status: "single_active_claim",
                source_claim_ids: ["claim-lena"],
                source_document_ids: ["doc-lena-mv"],
                conflicts: [],
                derivation_record_id: null,
                resolver: { name: "rent_for_unit", version: "1.0.0" },
                generated_at: "2026-05-28T10:00:00Z",
              },
              tenant_active: {
                status: "unavailable",
                reason: "no_tenant_resolver",
                resolver: { name: "tenant_for_unit", version: "unshipped" },
              },
              size_sqm: null,
              floor: 1,
              rooms: null,
              target_cold_rent: null,
            },
            {
              unit_ref: "DG",
              occupancy_status: "vacant",
              vacancy_reason: "no_data",
              current_kaltmiete: {
                query: {},
                value: null,
                confidence: "low",
                status: "no_active_claim",
                source_claim_ids: [],
                source_document_ids: [],
                conflicts: [],
                derivation_record_id: null,
                resolver: { name: "rent_for_unit", version: "1.0.0" },
                generated_at: "2026-05-28T10:00:00Z",
              },
              tenant_active: {
                status: "unavailable",
                reason: "no_tenant_resolver",
                resolver: { name: "tenant_for_unit", version: "unshipped" },
              },
              size_sqm: null,
              floor: 2,
              rooms: null,
              target_cold_rent: null,
            },
          ],
          summary: {
            total_units: 3,
            occupied_units: 1,
            vacant_units: 2,
            needs_review_units: 0,
            resolved_kaltmiete_total: { amount: 65000, currency: "EUR" },
            vermietungsquote: 1 / 3,
          },
        },
        resolver_versions: { rent_for_unit: "1.0.0" },
        input_claim_ids: ["claim-lena"],
        warnings: [],
      },
    },
    metadata: {
      composed_at: "2026-05-28T10:00:00Z",
      claim_snapshot_version: "test-fixture-ko132",
      resolver_versions: { rent_for_unit: "1.0.0" },
      completeness: { rent_roll: "complete" },
      warnings: [],
    },
  };
}

function hhs55Snapshot(): PropertySnapshot {
  return {
    core: {
      property_id: "d2e8e9c7-957a-4e0f-8150-452c21bcae56",
      org_id: "310131df-d6ed-4007-83c2-ac69a7e9df42",
      short_code: "HHS55",
      address: "Holzhäuser Straße 55, 04299 Leipzig",
      total_sqm: 160,
      unit_count: 2,
      unit_refs: ["EG", "1.OG"],
    },
    modules: {
      rent_roll: {
        completeness: "complete",
        data: {
          rows: [
            {
              unit_ref: "EG",
              occupancy_status: "vacant",
              vacancy_reason: "no_data",
              current_kaltmiete: {
                query: {},
                value: null,
                confidence: "low",
                status: "no_active_claim",
                source_claim_ids: [],
                source_document_ids: [],
                conflicts: [],
                derivation_record_id: null,
                resolver: { name: "rent_for_unit", version: "1.0.0" },
                generated_at: "2026-05-28T10:00:00Z",
              },
              tenant_active: {
                status: "unavailable",
                reason: "no_tenant_resolver",
                resolver: { name: "tenant_for_unit", version: "unshipped" },
              },
              size_sqm: 80,
              floor: 0,
              rooms: 3,
              target_cold_rent: null,
            },
            {
              unit_ref: "1.OG",
              occupancy_status: "vacant",
              vacancy_reason: "no_data",
              current_kaltmiete: {
                query: {},
                value: null,
                confidence: "low",
                status: "no_active_claim",
                source_claim_ids: [],
                source_document_ids: [],
                conflicts: [],
                derivation_record_id: null,
                resolver: { name: "rent_for_unit", version: "1.0.0" },
                generated_at: "2026-05-28T10:00:00Z",
              },
              tenant_active: {
                status: "unavailable",
                reason: "no_tenant_resolver",
                resolver: { name: "tenant_for_unit", version: "unshipped" },
              },
              size_sqm: 80,
              floor: 1,
              rooms: 3,
              target_cold_rent: null,
            },
          ],
          summary: {
            total_units: 2,
            occupied_units: 0,
            vacant_units: 2,
            needs_review_units: 0,
            resolved_kaltmiete_total: null,
            vermietungsquote: 0,
          },
        },
        resolver_versions: { rent_for_unit: "1.0.0" },
        input_claim_ids: [],
        warnings: [],
      },
    },
    metadata: {
      composed_at: "2026-05-28T10:00:00Z",
      claim_snapshot_version: "test-fixture-hhs55",
      resolver_versions: { rent_for_unit: "1.0.0" },
      completeness: { rent_roll: "complete" },
      warnings: [],
    },
  };
}

function emptySnapshot(): PropertySnapshot {
  return {
    core: {
      property_id: "00000000-0000-0000-0000-000000000005",
      org_id: "310131df-d6ed-4007-83c2-ac69a7e9df42",
      short_code: "EMPTY1",
      address: "Leerweg 1, 10115 Berlin",
      total_sqm: null,
      unit_count: 0,
      unit_refs: [],
    },
    modules: {},
    metadata: {
      composed_at: "2026-05-28T10:00:00Z",
      claim_snapshot_version: "test-fixture-empty",
      resolver_versions: {},
      completeness: {},
      warnings: [],
    },
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set; the presenter tests require live LLM calls.",
    );
    process.exit(2);
  }

  ok(PRESENTER_VERSION === "1.0.0", "PRESENTER_VERSION is exported as 1.0.0");

  // ---------------------------------------------------------------------
  // Scenario 1 — Lena Everding acceptance criterion
  // ---------------------------------------------------------------------
  console.log("\n--- Scenario 1: Lena Everding fact (acceptance criterion) ---");
  {
    const fact = lenaFact();
    const hints = {
      documents: [
        { id: "doc-lena-mietvertrag-id", doc_type: "mietvertrag" },
      ],
    };
    const prose = await renderResolvedFact<Money>(fact, hints);
    console.log(`  prose: ${prose}`);
    ok(contains(prose, "650"), "Lena prose mentions 650");
    ok(contains(prose, "mietvertrag"), "Lena prose mentions Mietvertrag (case-insensitive)");
    ok(
      contains(prose, "01.04.2025") ||
        contains(prose, "1. April 2025") ||
        contains(prose, "1.4.2025") ||
        contains(prose, "April 2025"),
      "Lena prose mentions effective date (01.04.2025 or 1. April 2025)",
    );
    // No invented tenant name should leak.
    ok(
      !contains(prose, "Julija") && !contains(prose, "Paul"),
      "Lena prose does NOT invent a tenant name (no Julija/Paul leak — none in input)",
    );
  }

  // ---------------------------------------------------------------------
  // Scenario 2 — KO132 full snapshot
  // ---------------------------------------------------------------------
  console.log("\n--- Scenario 2: KO132 full snapshot (3 units) ---");
  {
    const snap = ko132Snapshot();
    const hints = {
      documents: [{ id: "doc-lena-mv", doc_type: "mietvertrag" }],
    };
    const prose = await renderPropertySnapshot(snap, hints);
    console.log(`  prose: ${prose}`);
    ok(contains(prose, "KO132") || contains(prose, "Korbacher"), "KO132 prose names the property");
    ok(contains(prose, "EG"), "KO132 prose mentions EG");
    ok(contains(prose, "1.og") || contains(prose, "1. og") || contains(prose, "1.OG"), "KO132 prose mentions 1.OG");
    ok(contains(prose, "DG"), "KO132 prose mentions DG");
    ok(
      containsAny(prose, ["33", "drittel", "1/3"]),
      "KO132 prose surfaces the 33% vermietungsquote (or 'ein Drittel')",
    );
    ok(
      containsAny(prose, [
        "kein mietvertrag",
        "kein gültiger mietvertrag",
        "keine mietangabe",
        "leerstehend",
        "leerstand",
        "nicht vermietet",
      ]),
      "KO132 prose flags the vacant EG/DG as having no contract on file",
    );
    ok(contains(prose, "650"), "KO132 prose mentions Lena's €650 for 1.OG");
  }

  // ---------------------------------------------------------------------
  // Scenario 3 — HHS55 minimal
  // ---------------------------------------------------------------------
  console.log("\n--- Scenario 3: HHS55 minimal (2 units, both vacant) ---");
  {
    const snap = hhs55Snapshot();
    const prose = await renderPropertySnapshot(snap);
    console.log(`  prose: ${prose}`);
    ok(contains(prose, "HHS55") || contains(prose, "Holzhäuser"), "HHS55 prose names the property");
    ok(
      contains(prose, "2") || contains(prose, "zwei"),
      "HHS55 prose mentions the two units",
    );
    ok(
      containsAny(prose, ["leer", "vakant", "kein mietvertrag", "vacant"]),
      "HHS55 prose surfaces the vacancy of both units",
    );
  }

  // ---------------------------------------------------------------------
  // Scenario 4 — empty modules
  // ---------------------------------------------------------------------
  console.log("\n--- Scenario 4: empty modules (no module data) ---");
  {
    const snap = emptySnapshot();
    const prose = await renderPropertySnapshot(snap);
    console.log(`  prose: ${prose}`);
    ok(
      containsAny(prose, [
        "keine moduldaten",
        "keine daten",
        "keine angaben",
        "nicht verfügbar",
        "noch keine",
      ]),
      "empty-modules prose acknowledges absence of module data",
    );
    // Must NOT invent anything.
    ok(
      !contains(prose, "vermietet") && !contains(prose, "mieter"),
      "empty-modules prose invents nothing about occupancy or tenants",
    );
  }

  console.log(`\nrender: ${passed} assertions OK`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
