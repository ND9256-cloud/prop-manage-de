// src/lib/composer/property-snapshot.ts
//
// The deterministic composer. Architecture §5.4.3.
//
// composePropertySnapshot assembles a PropertySnapshot { core, modules, metadata }
// by:
//   1. building CorePropertySnapshot from Property + Unit tables
//   2. dispatching each requested module to a registered handler
//   3. computing a stable claim_snapshot_version over the collected claim IDs
//   4. writing one DerivationRecord with output_type='property_snapshot'
//
// Pure with respect to LLMs: no Anthropic SDK, no prompt module, no extraction
// imports, no HTTP. The CI gate (composer-purity.test.ts) enforces this. DB
// reads/writes via Prisma are allowed (resolvers do the same).

import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type {
  ComposeRequest,
  CorePropertySnapshot,
  ModuleComposer,
  ModuleContext,
  ModuleResult,
  PrismaTransactionClient,
  PropertySnapshot,
  SnapshotMetadata,
  Warning,
} from "./types";
import { COMPOSER_VERSION } from "./types";

export { COMPOSER_VERSION } from "./types";
export type { PropertySnapshot, ComposeRequest } from "./types";

// ---------------------------------------------------------------------------
// Module registry
// ---------------------------------------------------------------------------
//
// Module composers live as functions keyed by module name. Task 3.2 replaces
// the rent_roll entry below with the real implementation (likely by importing
// from ./modules/rent-roll.ts). Until then, every module returns "unavailable".

const MODULE_REGISTRY: Record<string, ModuleComposer> = {
  rent_roll: stubModule("rent_roll", "Task 3.2 implements rent_roll"),
  ownership: stubModule("ownership", "ownership module not yet implemented"),
  insurance: stubModule("insurance", "insurance module not yet implemented"),
  costs: stubModule("costs", "costs module not yet implemented"),
  handover: stubModule("handover", "handover module not yet implemented"),
};

function stubModule(name: string, msg: string): ModuleComposer {
  return async (): Promise<ModuleResult> => ({
    completeness: "unavailable",
    data: null,
    resolver_versions: {},
    input_claim_ids: [],
    warnings: [{ module: name, code: "not_implemented", message: msg }],
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function composePropertySnapshot(
  req: ComposeRequest,
  opts: { tx?: PrismaTransactionClient } = {}
): Promise<PropertySnapshot> {
  const db = opts.tx ?? prisma;

  // 1. CorePropertySnapshot — always composed from Property + Unit.
  const core = await buildCore(db, req.property_id, req.org_id);

  // 2. Module dispatch.
  const modules: PropertySnapshot["modules"] = {};
  const completeness: SnapshotMetadata["completeness"] = {};
  const resolver_versions: Record<string, string> = {};
  const warnings: Warning[] = [];
  const allInputClaimIds = new Set<string>();

  for (const name of req.modules) {
    const handler = MODULE_REGISTRY[name];
    const ctx: ModuleContext = {
      property_id: req.property_id,
      org_id: req.org_id,
      core,
      tx: opts.tx,
    };

    let result: ModuleResult;
    if (!handler) {
      result = {
        completeness: "unavailable",
        data: null,
        resolver_versions: {},
        input_claim_ids: [],
        warnings: [
          {
            module: name,
            code: "unknown_module",
            message: `No composer registered for module '${name}'`,
          },
        ],
      };
    } else {
      result = await handler(ctx);
    }

    modules[name] = result;
    completeness[name] = result.completeness;
    Object.assign(resolver_versions, result.resolver_versions);
    for (const id of result.input_claim_ids) allInputClaimIds.add(id);
    warnings.push(...result.warnings);
  }

  // 3. Stable hash over sorted claim IDs (cache-invalidation key, §5.4 line 353).
  const claim_snapshot_version = hashClaimIds([...allInputClaimIds]);

  const metadata: SnapshotMetadata = {
    composed_at: new Date().toISOString(),
    claim_snapshot_version,
    resolver_versions,
    completeness,
    warnings,
  };

  // 4. DerivationRecord audit row.
  await writeSnapshotDerivationRecord(db, {
    property_id: req.property_id,
    input_claim_ids: [...allInputClaimIds],
    resolver_versions,
  });

  return { core, modules, metadata };
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

interface CoreRow {
  id: string;
  org_id: string;
  short_code: string | null;
  address: string | null;
  total_sqm: string | number | null;
}

async function buildCore(
  db: PrismaTransactionClient,
  property_id: string,
  org_id: string
): Promise<CorePropertySnapshot> {
  // @tenant-isolation-disable-next-line -- reason: composer reads Property row with explicit org_id parameter in WHERE clause; cross-org access yields no row
  const propertyRows = await db.$queryRaw<CoreRow[]>`
    SELECT
      id,
      "organizationId" AS org_id,
      short_code,
      address,
      total_sqm
    FROM "Property"
    WHERE id = ${property_id}::uuid
      AND "organizationId" = ${org_id}::uuid
    LIMIT 1
  `;
  if (propertyRows.length === 0) {
    throw new Error(
      `composePropertySnapshot: property ${property_id} not found in org ${org_id}`
    );
  }
  const p = propertyRows[0];

  // @tenant-isolation-disable-next-line -- reason: composer reads Unit rows scoped to property which was already org-verified above
  const unitRows = await db.$queryRaw<{ unit_number: string }[]>`
    SELECT "unitNumber" AS unit_number
    FROM "Unit"
    WHERE "propertyId" = ${property_id}::uuid
    ORDER BY "unitNumber"
  `;
  const unit_refs = unitRows.map((r: { unit_number: string }) => r.unit_number);

  return {
    property_id: p.id,
    org_id: p.org_id,
    short_code: p.short_code,
    address: p.address,
    total_sqm: parseTotalSqm(p.total_sqm),
    unit_count: unit_refs.length,
    unit_refs,
  };
}

function parseTotalSqm(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// claim_snapshot_version
// ---------------------------------------------------------------------------

/**
 * Stable SHA-256 over the sorted, joined claim IDs. Determinism is mandatory:
 * the same claim set must always yield the same hash so caching (§5.4) does
 * not silently break. Returns hex digest.
 */
export function hashClaimIds(claim_ids: string[]): string {
  const sorted = [...claim_ids].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

// ---------------------------------------------------------------------------
// DerivationRecord writer
// ---------------------------------------------------------------------------

/**
 * Write a derivation_records row for this snapshot.
 * Mirrors the applier's pattern: best-effort, logs but does not throw on failure
 * so a transient audit-table issue cannot break composition for callers.
 */
async function writeSnapshotDerivationRecord(
  db: PrismaTransactionClient,
  args: {
    property_id: string;
    input_claim_ids: string[];
    resolver_versions: Record<string, string>;
  }
): Promise<string | null> {
  try {
    const output_id = randomUUID();
    // Per-module resolver versions live in the snapshot metadata. The DB
    // resolver_version column accepts a single value; store a deterministic
    // joined representation so the audit row records which resolver versions
    // were active. NULL when no resolvers ran.
    const versionPairs = Object.entries(args.resolver_versions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => `${name}@${v}`);
    const resolver_version = versionPairs.length > 0 ? versionPairs.join(",") : null;

    // @tenant-isolation-disable-next-line -- reason: composer audit-row insert; property_id verified as belonging to org_id by buildCore() before reaching this point
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO warehouse.derivation_records (
        property_id, output_type, output_id,
        input_claim_ids, input_extraction_run_ids, rule_refs,
        composer_version, resolver_version
      ) VALUES (
        ${args.property_id}::uuid, 'property_snapshot', ${output_id}::uuid,
        ${args.input_claim_ids}::uuid[], '{}'::uuid[], ${["§5.4.3"]}::text[],
        ${COMPOSER_VERSION}, ${resolver_version}
      ) RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn("[composer] derivation_record write failed", err);
    return null;
  }
}
