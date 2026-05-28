// src/lib/composer/types.ts
//
// PropertySnapshot type definitions for the deterministic composer.
// Architecture §5.4.3 (composer) + §5.4.4 (ResolvedFact).
//
// The composer consumes the SHIPPED ResolvedFact<T> from src/lib/resolvers/types.ts.
// It does NOT redefine ResolvedFact or remap the resolver's ResolutionStatus
// vocabulary; resolver output passes through unchanged.

import type { ResolvedFact } from "../resolvers/types";

// Re-export so module composers (3.2+) can import a single types module.
export type { ResolvedFact };

/**
 * Always-composed core facts about a property, read directly from the
 * Property + Unit Prisma tables. No claims/resolvers involved.
 */
export interface CorePropertySnapshot {
  property_id: string;
  org_id: string;
  short_code: string | null;
  address: string | null;
  total_sqm: number | null;
  unit_count: number;
  unit_refs: string[];
}

/**
 * Result of one module composer (rent_roll, ownership, insurance, …).
 *
 * - completeness: how complete the module data is.
 *   - "complete": all required facts resolved
 *   - "partial": some facts resolved, some missing/unsupported
 *   - "unavailable": handler not registered, or module yielded no data
 * - data: the module's own snapshot shape (e.g. RentRollSnapshot from 3.2);
 *   opaque to the composer core.
 * - resolver_versions: name → version for every resolver the module called
 * - input_claim_ids: claim IDs that fed this module's resolved facts
 * - warnings: structured diagnostics surfaced to callers
 */
export interface ModuleResult {
  completeness: "complete" | "partial" | "unavailable";
  data: unknown;
  resolver_versions: Record<string, string>;
  input_claim_ids: string[];
  warnings: Warning[];
}

export interface Warning {
  module: string | null;
  code: string;
  message: string;
}

export interface SnapshotMetadata {
  composed_at: string;
  claim_snapshot_version: string;
  resolver_versions: Record<string, string>;
  completeness: Record<string, "complete" | "partial" | "unavailable">;
  warnings: Warning[];
}

export interface PropertySnapshot {
  core: CorePropertySnapshot;
  modules: {
    rent_roll?: ModuleResult;
    ownership?: ModuleResult;
    insurance?: ModuleResult;
    costs?: ModuleResult;
    handover?: ModuleResult;
    [key: string]: ModuleResult | undefined;
  };
  metadata: SnapshotMetadata;
}

export interface ComposeRequest {
  property_id: string;
  org_id: string;
  modules: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrismaTransactionClient = any;

export interface ModuleContext {
  property_id: string;
  org_id: string;
  core: CorePropertySnapshot;
  tx?: PrismaTransactionClient;
}

export type ModuleComposer = (ctx: ModuleContext) => Promise<ModuleResult>;

export const COMPOSER_VERSION = "1.0.0";
