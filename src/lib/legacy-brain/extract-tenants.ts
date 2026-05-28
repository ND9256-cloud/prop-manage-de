// src/lib/legacy-brain/extract-tenants.ts
//
// Shared parser for the legacy brain rent roll. Pure: no I/O, no env, no
// "use server". Lives outside src/lib/dashboard-actions.ts so the shadow-mode
// comparison job (scripts/brain-shadow-comparison.ts) can reuse it without
// dragging in a server-action surface.
//
// Shape of the analysis JSON (from warehouse.property_intelligence.analysis):
//   {
//     rent_roll: {
//       current_tenants: Tenant[] | number,
//       tenants:         Tenant[]
//     }
//   }
// where Tenant = { name, unit_ref, monthly_rent }. Both top-level arrays
// appear in the wild (different brain prompt versions); we prefer
// current_tenants when it is an array, otherwise fall back to tenants.

export interface LegacyRentRollRow {
  unit_ref: string;
  tenant_name: string | null;
  monthly_rent: number | null;
}

interface LegacyBrainAnalysis {
  rent_roll?: {
    current_tenants?: unknown;
    tenants?: unknown;
  };
}

interface LegacyTenantEntry {
  name?: unknown;
  unit_ref?: unknown;
  monthly_rent?: unknown;
}

export function extractLegacyTenants(analysis: Record<string, unknown>): LegacyRentRollRow[] {
  const rent = (analysis as LegacyBrainAnalysis).rent_roll;
  if (!rent) return [];
  const list = Array.isArray(rent.current_tenants)
    ? (rent.current_tenants as LegacyTenantEntry[])
    : Array.isArray(rent.tenants)
      ? (rent.tenants as LegacyTenantEntry[])
      : [];
  return list
    .map<LegacyRentRollRow | null>(t => {
      const unit = typeof t.unit_ref === 'string' ? t.unit_ref : null;
      if (!unit) return null;
      return {
        unit_ref: unit,
        tenant_name: typeof t.name === 'string' ? t.name : null,
        monthly_rent: typeof t.monthly_rent === 'number' ? t.monthly_rent : null,
      };
    })
    .filter((r): r is LegacyRentRollRow => r !== null);
}
