// scripts/brain-shadow-comparison.ts — Task 3.4.
//
// Parallel-run safety net. For every property in every org:
//   1. compose RentRollSnapshot (composer-first, the v2 source of truth)
//   2. read the legacy brain's rent-roll per (property, unit_ref) from
//      warehouse.property_intelligence (the legacy nightly writer)
//   3. classify every per-unit + per-property divergence into a known class
//   4. write all divergences (informational + alert) to
//      warehouse.brain_shadow_comparison stamped with one run_at timestamp
//   5. if any divergence is in ALERT_CLASSES, post a single Discord summary
//
// The framing — shadow mode is NOT "wait for identical output." Composer and
// legacy SHOULD diverge in known ways (composer surfaces ingestion gaps,
// legacy hallucinates from stale data). Stable = every divergence fits a
// known class. Unknown classes alert.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/brain-shadow-comparison.ts
//
// Optional env:
//   SHADOW_ORG_ID     limit to one org (useful for local runs)
//   SHADOW_PROPERTY_ID  limit to one property
//   SHADOW_DRY_RUN=1  classify + log only, no DB writes, no Discord
//
// The migration that ships the destination table:
//   supabase/migrations/20260528201627_brain_shadow_comparison.sql

import { createClient } from "@supabase/supabase-js";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { composePropertySnapshot } from "../src/lib/composer/property-snapshot";
import type {
  RentRollRow,
  RentRollSnapshot,
} from "../src/lib/composer/modules/rent-roll";
import {
  extractLegacyTenants,
  type LegacyRentRollRow,
} from "../src/lib/legacy-brain/extract-tenants";
import {
  ALERT_CLASSES,
  classifyAggregate,
  classifyUnitPair,
  type Divergence,
  type DivergenceClass,
} from "./lib/brain-shadow-classify";
import { postDiscord } from "./lib/discord-notify";

// ---------------------------------------------------------------------------
// Env + clients
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.SHADOW_DRY_RUN === "1";
const ORG_FILTER = process.env.SHADOW_ORG_ID ?? null;
const PROPERTY_FILTER = process.env.SHADOW_PROPERTY_ID ?? null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !DATABASE_URL) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL",
  );
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const warehouse = supabaseAdmin.schema("warehouse");

const pool = new Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Property enumeration
// ---------------------------------------------------------------------------

interface PropertyRow {
  id: string;
  org_id: string;
  short_code: string | null;
  name: string;
}

async function enumerateProperties(): Promise<PropertyRow[]> {
  const filters: Prisma.Sql[] = [];
  if (PROPERTY_FILTER) filters.push(Prisma.sql`id = ${PROPERTY_FILTER}::uuid`);
  if (ORG_FILTER) filters.push(Prisma.sql`"organizationId" = ${ORG_FILTER}::uuid`);
  const whereClause =
    filters.length === 0
      ? Prisma.empty
      : Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`;
  // @tenant-isolation-disable-next-line -- reason: cross-org enumeration job (Task 3.4 shadow-mode). Runs only as the GH-Actions service-role identity; optional SHADOW_ORG_ID env narrows scope for local runs. Customer surfaces unaffected.
  return prisma.$queryRaw<PropertyRow[]>`
    SELECT id, "organizationId" AS org_id, short_code, name
    FROM "Property"
    ${whereClause}
    ORDER BY "organizationId", short_code NULLS LAST, name
  `;
}

// ---------------------------------------------------------------------------
// Legacy brain read
// ---------------------------------------------------------------------------

interface LegacyBrainRow {
  property_id: string;
  analysis: Record<string, unknown>;
}

async function loadLegacyBrainByProperty(
  orgId: string,
): Promise<Map<string, LegacyRentRollRow[]>> {
  const { data, error } = await warehouse
    .from("property_intelligence")
    .select("property_id, analysis")
    .eq("org_id", orgId)
    .eq("is_current", true);
  if (error) {
    console.warn(`[shadow] property_intelligence read failed for org ${orgId}: ${error.message}`);
    return new Map();
  }
  const out = new Map<string, LegacyRentRollRow[]>();
  for (const row of (data ?? []) as LegacyBrainRow[]) {
    out.set(row.property_id, extractLegacyTenants(row.analysis ?? {}));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-property comparison
// ---------------------------------------------------------------------------

interface CompareInput {
  property: PropertyRow;
  composer: RentRollSnapshot;
  legacyTenants: LegacyRentRollRow[];
}

function comparePropertySnapshot(input: CompareInput): Divergence[] {
  const { composer, legacyTenants } = input;
  const legacyByUnit = new Map<string, LegacyRentRollRow>();
  for (const t of legacyTenants) legacyByUnit.set(t.unit_ref, t);

  const composerByUnit = new Map<string, RentRollRow>();
  for (const r of composer.rows) composerByUnit.set(r.unit_ref, r);

  const allUnits = new Set<string>([
    ...composerByUnit.keys(),
    ...legacyByUnit.keys(),
  ]);

  const divergences: Divergence[] = [];

  for (const unit of allUnits) {
    const c = composerByUnit.get(unit) ?? null;
    const l = legacyByUnit.get(unit) ?? null;
    divergences.push(...classifyUnitPair(unit, mapComposer(c), mapLegacy(l)));
  }

  // Aggregate diffs.
  const composerVerm = composer.summary.vermietungsquote;
  const composerTotalEuros =
    composer.summary.resolved_kaltmiete_total === null
      ? null
      : composer.summary.resolved_kaltmiete_total.amount / 100;

  // Legacy doesn't carry vermietungsquote directly (no inventory truth) — pass
  // null to record the informational divergence. monthly_gross_cold is read
  // straight off the analysis object; null when unparseable.
  divergences.push(
    ...classifyAggregate(
      { vermietungsquote: composerVerm, total_kaltmiete: composerTotalEuros },
      {
        vermietungsquote: null,
        total_kaltmiete: aggregateLegacyTotal(legacyTenants),
      },
    ),
  );

  return divergences;
}

function aggregateLegacyTotal(legacy: LegacyRentRollRow[]): number | null {
  let total = 0;
  let anyKnown = false;
  for (const t of legacy) {
    if (typeof t.monthly_rent === "number") {
      total += t.monthly_rent;
      anyKnown = true;
    }
  }
  return anyKnown ? total : null;
}

function mapComposer(row: RentRollRow | null) {
  if (!row) return null;
  const value = row.current_kaltmiete.value;
  return {
    occupancy_status: row.occupancy_status,
    kaltmiete_amount: value ? value.amount / 100 : null, // composer minor units → euros
    tenant_name: null, // tenant resolver is unshipped — composer has no tenant name yet
  };
}

function mapLegacy(t: LegacyRentRollRow | null) {
  if (!t) return null;
  return {
    tenant_name: t.tenant_name,
    kaltmiete_amount: t.monthly_rent,
  };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

interface PersistRow {
  run_at: string;
  org_id: string;
  property_id: string;
  unit_ref: string | null;
  divergent_field: string;
  composer_value: unknown;
  legacy_value: unknown;
  divergence_class: DivergenceClass;
}

async function persist(rows: PersistRow[]) {
  if (rows.length === 0) return;
  if (DRY_RUN) {
    console.log(`[shadow][dry-run] would insert ${rows.length} divergence rows`);
    return;
  }
  // Chunk inserts so a property with hundreds of divergences doesn't hit a payload limit.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await warehouse
      .from("brain_shadow_comparison")
      .insert(slice);
    if (error) {
      console.error(`[shadow] insert failed (chunk @${i}): ${error.message}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Discord summary
// ---------------------------------------------------------------------------

interface RunStats {
  run_at: string;
  properties_scanned: number;
  by_class: Map<DivergenceClass, number>;
}

function formatAlert(stats: RunStats): string {
  const total = sumValues(stats.by_class);
  let alerts = 0;
  for (const [k, v] of stats.by_class) if (ALERT_CLASSES.has(k)) alerts += v;

  const lines: string[] = [];
  lines.push(`🔍 Shadow comparison — ${stats.run_at}`);
  lines.push(`Properties scanned: ${stats.properties_scanned}`);
  lines.push(`Divergences total: ${total}  (alert: ${alerts})`);
  lines.push("By class:");

  // Sort: alert classes first (so attention items are at top), then informational.
  const ordered = [...stats.by_class.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a, na], [b, nb]) => {
      const aAlert = ALERT_CLASSES.has(a);
      const bAlert = ALERT_CLASSES.has(b);
      if (aAlert !== bAlert) return aAlert ? -1 : 1;
      return nb - na;
    });

  for (const [klass, n] of ordered) {
    const tag = ALERT_CLASSES.has(klass) ? "  ← needs attention" : "  (informational)";
    lines.push(`  ${klass}: ${n}${tag}`);
  }
  lines.push(
    `SQL: SELECT * FROM warehouse.brain_shadow_comparison WHERE run_at = '${stats.run_at}';`,
  );
  return lines.join("\n");
}

function sumValues(m: Map<unknown, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const run_at = new Date().toISOString();
  console.log(`[shadow] run_at=${run_at}${DRY_RUN ? " (DRY RUN)" : ""}`);

  const properties = await enumerateProperties();
  console.log(`[shadow] scanning ${properties.length} properties`);

  const legacyByOrg = new Map<string, Map<string, LegacyRentRollRow[]>>();
  const byClass = new Map<DivergenceClass, number>();
  const persistRows: PersistRow[] = [];

  for (const p of properties) {
    if (!legacyByOrg.has(p.org_id)) {
      legacyByOrg.set(p.org_id, await loadLegacyBrainByProperty(p.org_id));
    }
    const legacyMap = legacyByOrg.get(p.org_id)!;
    const legacyTenants = legacyMap.get(p.id) ?? [];

    let composer: RentRollSnapshot;
    try {
      const snap = await composePropertySnapshot({
        property_id: p.id,
        org_id: p.org_id,
        modules: ["rent_roll"],
      });
      const module = snap.modules.rent_roll;
      if (!module || !module.data) {
        console.log(
          `[shadow] ${shortLabel(p)}: composer rent_roll unavailable (${module?.completeness}); skipping`,
        );
        continue;
      }
      composer = module.data as RentRollSnapshot;
    } catch (err) {
      console.warn(`[shadow] ${shortLabel(p)}: composer failed: ${(err as Error).message}`);
      continue;
    }

    const divergences = comparePropertySnapshot({
      property: p,
      composer,
      legacyTenants,
    });

    for (const d of divergences) {
      byClass.set(
        d.divergence_class,
        (byClass.get(d.divergence_class) ?? 0) + 1,
      );
      persistRows.push({
        run_at,
        org_id: p.org_id,
        property_id: p.id,
        unit_ref: d.unit_ref,
        divergent_field: d.divergent_field,
        composer_value: d.composer_value as object,
        legacy_value: d.legacy_value as object,
        divergence_class: d.divergence_class,
      });
    }

    console.log(
      `[shadow] ${shortLabel(p)}: ${divergences.length} divergences (` +
        summariseByClass(divergences) +
        ")",
    );
  }

  await persist(persistRows);

  const stats: RunStats = {
    run_at,
    properties_scanned: properties.length,
    by_class: byClass,
  };

  let alertTotal = 0;
  for (const [k, v] of byClass) if (ALERT_CLASSES.has(k)) alertTotal += v;

  console.log(
    `[shadow] complete — ${persistRows.length} rows, alert-class total ${alertTotal}`,
  );

  if (alertTotal > 0 && !DRY_RUN) {
    await postDiscord(formatAlert(stats));
  } else if (alertTotal > 0) {
    console.log("[shadow][dry-run] would post Discord:");
    console.log(formatAlert(stats));
  }

  await prisma.$disconnect();
}

function shortLabel(p: PropertyRow): string {
  return p.short_code ? `${p.short_code} (${p.id.slice(0, 8)})` : `${p.name} (${p.id.slice(0, 8)})`;
}

function summariseByClass(ds: Divergence[]): string {
  const counts = new Map<DivergenceClass, number>();
  for (const d of ds) counts.set(d.divergence_class, (counts.get(d.divergence_class) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", ") || "agreement";
}

main().catch(err => {
  console.error("[shadow] fatal", err);
  process.exit(1);
});
