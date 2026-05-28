// src/lib/composer/modules/rent-roll.ts
//
// rent_roll composer module. Architecture §5.4.3.
//
// First real composer module: enumerates every unit from the authoritative Unit
// inventory (Task 3.1b) and resolves each via rentForUnit (Task 1.10) to build
// a RentRollSnapshot — one row per unit, occupied or vacant.
//
// Vacancy is a first-class signal. The resolver's status vocabulary is mapped
// into an occupancy_status + vacancy_reason so the dashboard can distinguish:
//   - occupied                     — single_active_claim
//   - vacant + tenancy_ended       — no_claim_for_date (closed claim in history)
//   - vacant + no_data             — no_active_claim   (no lease on file)
//   - needs_review                 — latest_active_claim_with_conflicts
//
// Pure with respect to LLMs / HTTP: composer-purity.test.ts gates this. The
// only imports are sibling composer types, the rent_for_unit resolver, and the
// resolver type module.

import { rentForUnit, RESOLVER_NAME, RESOLVER_VERSION } from "../../resolvers/rent-for-unit";
import type { Money, ResolvedFact } from "../../resolvers/types";
import type { ModuleContext, ModuleResult, Warning } from "../types";

export type OccupancyStatus = "occupied" | "vacant" | "needs_review";
export type VacancyReason = "tenancy_ended" | "no_data" | null;

/**
 * Tenant column on the rent roll. A tenant resolver does not yet exist
 * (separate follow-up task). The field is typed so 3.3 can render it once
 * available; for now it is populated with a ResolvedFact-shaped sentinel
 * carrying status="unavailable" so callers don't accidentally treat the
 * absence as a real "no tenant" signal.
 *
 * NOTE: "unavailable" is NOT one of the resolver-layer ResolutionStatus values
 * (those describe live resolution outcomes). It is module-local and only
 * appears in this surrogate; the real tenant resolver, when shipped, will
 * return a normal ResolvedFact<Tenant> here.
 */
export interface TenantUnavailableFact {
  status: "unavailable";
  reason: "no_tenant_resolver";
  resolver: { name: string; version: string };
}

export interface RentRollRow {
  unit_ref: string;
  occupancy_status: OccupancyStatus;
  vacancy_reason: VacancyReason;
  current_kaltmiete: ResolvedFact<Money>;
  tenant_active: TenantUnavailableFact;
  size_sqm: number | null;
  floor: number | null;
  rooms: number | null;
  target_cold_rent: number | null;
}

export interface RentRollSummary {
  total_units: number;
  occupied_units: number;
  vacant_units: number;
  needs_review_units: number;
  resolved_kaltmiete_total: Money | null;
  vermietungsquote: number;
}

export interface RentRollSnapshot {
  rows: RentRollRow[];
  summary: RentRollSummary;
}

export const RENT_ROLL_MODULE_NAME = "rent_roll";
export const RENT_ROLL_MODULE_VERSION = "1.0.0";

interface UnitRow {
  unit_number: string;
  floor: number | null;
  size_sqm: number | null;
  rooms: number | null;
  target_cold_rent: number | null;
}

export async function composeRentRoll(ctx: ModuleContext): Promise<ModuleResult> {
  const warnings: Warning[] = [];

  // Enumerate units from the authoritative Unit inventory (Task 3.1b).
  // The composer core has already verified that ctx.property_id belongs to
  // ctx.org_id (buildCore in property-snapshot.ts throws on cross-org access),
  // so unit enumeration inherits that guarantee. Order by floor for stable
  // display in the dashboard (Task 3.3).
  const db = ctx.tx;
  if (!db) {
    throw new Error(
      "rent_roll module requires ctx.tx (PrismaTransactionClient); composer core must pass it through"
    );
  }

  // @tenant-isolation-disable-next-line -- reason: composer rent_roll module reads Unit rows scoped to property_id which was already org-verified by buildCore() in property-snapshot.ts before module dispatch
  const units = await db.$queryRaw<UnitRow[]>`
    SELECT
      "unitNumber"     AS unit_number,
      "floor"          AS floor,
      "sizeSqm"        AS size_sqm,
      "rooms"          AS rooms,
      "targetColdRent" AS target_cold_rent
    FROM "Unit"
    WHERE "propertyId" = ${ctx.property_id}::uuid
    ORDER BY "floor" NULLS LAST, "unitNumber"
  `;

  const rows: RentRollRow[] = [];
  const allClaimIds = new Set<string>();
  const resolverVersions: Record<string, string> = {};

  for (const u of units) {
    const rent = await rentForUnit(
      {
        property_id: ctx.property_id,
        unit_ref: u.unit_number,
        org_id: ctx.org_id,
      },
      { tx: ctx.tx }
    );

    resolverVersions[rent.resolver.name] = rent.resolver.version;
    for (const id of rent.source_claim_ids) allClaimIds.add(id);

    const { occupancy_status, vacancy_reason } = mapOccupancy(rent.status);

    rows.push({
      unit_ref: u.unit_number,
      occupancy_status,
      vacancy_reason,
      current_kaltmiete: rent,
      tenant_active: makeTenantUnavailable(),
      size_sqm: u.size_sqm,
      floor: u.floor,
      rooms: u.rooms,
      target_cold_rent: u.target_cold_rent,
    });
  }

  const summary = buildSummary(rows);

  // tenant_active is unavailable for every row — emit one module-level warning
  // (not one per row) so the dashboard / callers see the follow-up clearly.
  warnings.push({
    module: RENT_ROLL_MODULE_NAME,
    code: "tenant_resolver_unavailable",
    message:
      "tenant_active column is populated as 'unavailable' because no tenantForUnit resolver has shipped yet (follow-up task)",
  });

  const completeness: ModuleResult["completeness"] =
    summary.needs_review_units > 0 ? "partial" : "complete";

  return {
    completeness,
    data: snapshotEnvelope(summary, rows),
    resolver_versions: resolverVersions,
    input_claim_ids: [...allClaimIds],
    warnings,
  };
}

function snapshotEnvelope(summary: RentRollSummary, rows: RentRollRow[]): RentRollSnapshot {
  return { rows, summary };
}

export function mapOccupancy(status: string): {
  occupancy_status: OccupancyStatus;
  vacancy_reason: VacancyReason;
} {
  switch (status) {
    case "single_active_claim":
      return { occupancy_status: "occupied", vacancy_reason: null };
    case "no_claim_for_date":
      return { occupancy_status: "vacant", vacancy_reason: "tenancy_ended" };
    case "no_active_claim":
      return { occupancy_status: "vacant", vacancy_reason: "no_data" };
    case "latest_active_claim_with_conflicts":
      return { occupancy_status: "needs_review", vacancy_reason: null };
    default:
      return { occupancy_status: "needs_review", vacancy_reason: null };
  }
}

function buildSummary(rows: RentRollRow[]): RentRollSummary {
  const total_units = rows.length;
  let occupied_units = 0;
  let vacant_units = 0;
  let needs_review_units = 0;
  let total_amount = 0;
  let currency: string | null = null;
  let any_occupied_value = false;

  for (const r of rows) {
    switch (r.occupancy_status) {
      case "occupied":
        occupied_units++;
        break;
      case "vacant":
        vacant_units++;
        break;
      case "needs_review":
        needs_review_units++;
        break;
    }
    // Sum kaltmiete only across occupied rows. needs_review rows carry the
    // latest winner's value but are excluded from the total — operator must
    // resolve the conflict first, otherwise the headline number silently
    // includes ambiguous data.
    if (r.occupancy_status === "occupied") {
      const v = r.current_kaltmiete.value;
      if (v) {
        if (currency === null) currency = v.currency;
        total_amount += v.amount;
        any_occupied_value = true;
      }
    }
  }

  const resolved_kaltmiete_total: Money | null =
    any_occupied_value && currency !== null
      ? { amount: total_amount, currency }
      : null;

  const vermietungsquote =
    total_units === 0 ? 0 : occupied_units / total_units;

  return {
    total_units,
    occupied_units,
    vacant_units,
    needs_review_units,
    resolved_kaltmiete_total,
    vermietungsquote,
  };
}

function makeTenantUnavailable(): TenantUnavailableFact {
  return {
    status: "unavailable",
    reason: "no_tenant_resolver",
    resolver: { name: "tenant_for_unit", version: "unshipped" },
  };
}

// Re-export so the registry knows which resolver this module depends on if it
// ever wants to introspect dependencies. Not currently used by the core.
export { RESOLVER_NAME as RENT_RESOLVER_NAME, RESOLVER_VERSION as RENT_RESOLVER_VERSION };
