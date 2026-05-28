// scripts/lib/brain-shadow-classify.ts
//
// Pure classification of composer-vs-legacy divergences. No I/O.
//
// The whole point: a known-class divergence is INFORMATIONAL (the system
// working as designed — legacy and composer have different correctness
// properties). Only `unknown` class divergences alert; the two real
// signal-of-bug classes (`kaltmiete_amount_mismatch`, `composer_missing_unit`)
// alert because they suggest concrete pipeline/inventory issues.
//
// The classifier is the single source of truth for "what triggers Discord"
// via the exported ALERT_CLASSES set.

export type DivergenceClass =
  | "composer_vacant_legacy_occupied"
  | "composer_occupied_legacy_vacant"
  | "kaltmiete_amount_mismatch"
  | "legacy_missing_unit"
  | "composer_missing_unit"
  | "vermietungsquote_mismatch"
  | "total_kaltmiete_mismatch"
  | "unknown";

export const ALERT_CLASSES: ReadonlySet<DivergenceClass> = new Set<DivergenceClass>([
  "kaltmiete_amount_mismatch",
  "composer_missing_unit",
  "unknown",
]);

export function isAlertClass(c: DivergenceClass): boolean {
  return ALERT_CLASSES.has(c);
}

export interface ComposerUnitInput {
  occupancy_status: "occupied" | "vacant" | "needs_review";
  kaltmiete_amount: number | null;
  tenant_name: string | null;
}

export interface LegacyUnitInput {
  tenant_name: string | null;
  kaltmiete_amount: number | null;
}

export interface Divergence {
  unit_ref: string | null;
  divergent_field: string;
  composer_value: unknown;
  legacy_value: unknown;
  divergence_class: DivergenceClass;
  alert: boolean;
}

// Per-unit pair classification. Empty array means agreement; no row written.
export function classifyUnitPair(
  unit_ref: string,
  composer: ComposerUnitInput | null,
  legacy: LegacyUnitInput | null,
): Divergence[] {
  // Inputs malformed (neither side present) → unknown so it surfaces.
  if (composer === null && legacy === null) {
    return [
      divergence(unit_ref, "presence", null, null, "unknown"),
    ];
  }

  // Composer has row, legacy doesn't.
  if (composer !== null && legacy === null) {
    return [
      divergence(unit_ref, "presence", composerSummary(composer), null, "legacy_missing_unit"),
    ];
  }

  // Composer missing the unit legacy knew about → Unit-inventory gap.
  if (composer === null && legacy !== null) {
    return [
      divergence(unit_ref, "presence", null, legacySummary(legacy), "composer_missing_unit"),
    ];
  }

  // Both sides have a row.
  const c = composer!;
  const l = legacy!;

  const legacyOccupied = isLegacyOccupied(l);

  // Composer says vacant where legacy shows tenant → ingestion gap (KO132 EG/DG case).
  if (c.occupancy_status === "vacant" && legacyOccupied) {
    return [
      divergence(
        unit_ref,
        "occupancy_status",
        composerSummary(c),
        legacySummary(l),
        "composer_vacant_legacy_occupied",
      ),
    ];
  }

  // Composer occupied, legacy vacant/empty → legacy stale.
  if (c.occupancy_status === "occupied" && !legacyOccupied) {
    return [
      divergence(
        unit_ref,
        "occupancy_status",
        composerSummary(c),
        legacySummary(l),
        "composer_occupied_legacy_vacant",
      ),
    ];
  }

  // Both occupied — compare kaltmiete (exact match required).
  if (c.occupancy_status === "occupied" && legacyOccupied) {
    if (c.kaltmiete_amount === l.kaltmiete_amount) {
      return []; // agreement
    }
    return [
      divergence(
        unit_ref,
        "kaltmiete",
        c.kaltmiete_amount,
        l.kaltmiete_amount,
        "kaltmiete_amount_mismatch",
      ),
    ];
  }

  // Both vacant — agreement on occupancy. No row written.
  if (c.occupancy_status === "vacant" && !legacyOccupied) {
    return [];
  }

  // Composer needs_review with legacy occupied or vacant — not a known class.
  // (needs_review is a composer signal the operator must resolve; either
  //  outcome could land. We surface as unknown so it's investigated.)
  return [
    divergence(
      unit_ref,
      "occupancy_status",
      composerSummary(c),
      legacySummary(l),
      "unknown",
    ),
  ];
}

export interface ComposerAggregateInput {
  vermietungsquote: number;
  total_kaltmiete: number | null;
}

export interface LegacyAggregateInput {
  // The legacy brain rent_roll section: monthly_gross_cold and current_tenants.
  // We only need monthly_gross_cold for total_kaltmiete diff. Vermietungsquote
  // is composer-only — legacy never had inventory-as-truth — but we expose a
  // legacy hook for forward compatibility (null today).
  vermietungsquote: number | null;
  total_kaltmiete: number | null;
}

export function classifyAggregate(
  composer: ComposerAggregateInput,
  legacy: LegacyAggregateInput,
): Divergence[] {
  const out: Divergence[] = [];

  // Vermietungsquote: legacy never had inventory truth, so a null-legacy is
  // expected and recorded as an informational divergence to keep the comparison
  // honest (the 100%-vs-33% case from 3.3). Non-null legacy that disagrees: same class.
  if (legacy.vermietungsquote === null
      || Math.abs((legacy.vermietungsquote ?? 0) - composer.vermietungsquote) > 1e-9) {
    out.push(divergence(
      null,
      "vermietungsquote",
      composer.vermietungsquote,
      legacy.vermietungsquote,
      "vermietungsquote_mismatch",
    ));
  }

  // total_kaltmiete: usually redundant given per-unit diffs but recorded so
  // aggregates and rows can be reconciled. Treat null on either side as "no data".
  const cTotal = composer.total_kaltmiete;
  const lTotal = legacy.total_kaltmiete;
  if (cTotal !== null && lTotal !== null && cTotal !== lTotal) {
    out.push(divergence(
      null,
      "total_kaltmiete",
      cTotal,
      lTotal,
      "total_kaltmiete_mismatch",
    ));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function divergence(
  unit_ref: string | null,
  divergent_field: string,
  composer_value: unknown,
  legacy_value: unknown,
  divergence_class: DivergenceClass,
): Divergence {
  return {
    unit_ref,
    divergent_field,
    composer_value,
    legacy_value,
    divergence_class,
    alert: ALERT_CLASSES.has(divergence_class),
  };
}

function composerSummary(c: ComposerUnitInput) {
  return {
    occupancy_status: c.occupancy_status,
    kaltmiete_amount: c.kaltmiete_amount,
    tenant_name: c.tenant_name,
  };
}

function legacySummary(l: LegacyUnitInput) {
  return {
    kaltmiete_amount: l.kaltmiete_amount,
    tenant_name: l.tenant_name,
  };
}

function isLegacyOccupied(l: LegacyUnitInput): boolean {
  // Legacy considers a unit occupied if it produced a non-empty tenant_name.
  // monthly_rent alone (e.g. legacy stored old rent for an empty unit) is not
  // sufficient — the comparator hinges on "did legacy declare a tenant here."
  return typeof l.tenant_name === "string" && l.tenant_name.trim().length > 0;
}
