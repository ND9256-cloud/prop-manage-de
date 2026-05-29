// src/lib/resolvers/tenant-for-unit.ts
//
// tenant_for_unit resolver. Architecture §5.1 + §5.2.
//
// Parallel resolver to rent_for_unit: identical structure, identical status
// vocabulary, identical org-isolation pattern, identical DR audit-trail
// semantics. Only the predicate ('tenant_active' vs 'kaltmiete') and the
// value extractor differ.
//
// Pure with respect to extraction: no LLM client, no prompt module, no emitter,
// no extraction module imports. CI gate (resolver-purity.test.ts) enforces this.
//
// Pure with respect to state: reads warehouse.claims (filtered by org_id),
// optionally writes one warehouse.derivation_records row for audit. No other
// side effects.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type {
  ResolvedFact,
  ResolverConfidence,
  Conflict,
  Tenant,
  ResolutionStatus,
} from "./types";
import { downgradeConfidence } from "./types";

interface ClaimRow {
  id: string;
  value: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  confidence: ResolverConfidence | null;
  source_document_id: string;
  valid_from: Date;
  created_at: Date;
}

export const RESOLVER_NAME = "tenant_for_unit";
export const RESOLVER_VERSION = "1.0.0";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTransactionClient = any;

export interface TenantForUnitArgs {
  property_id: string;
  unit_ref: string;
  as_of_date?: Date;
  org_id: string;
}

export async function tenantForUnit(
  args: TenantForUnitArgs,
  opts?: { tx?: PrismaTransactionClient }
): Promise<ResolvedFact<Tenant>> {
  const db = opts?.tx ?? prisma;
  const as_of_date = args.as_of_date ?? new Date();
  const as_of_iso = as_of_date.toISOString().slice(0, 10); // YYYY-MM-DD
  const subject = args.unit_ref.startsWith("unit:")
    ? args.unit_ref
    : `unit:${args.unit_ref}`;

  const query = {
    property_id: args.property_id,
    unit_ref: args.unit_ref,
    as_of_date: as_of_iso,
  };

  // --- Read active claims ----------------------------------------------------
  // @tenant-isolation-disable-next-line -- reason: resolver enforces org isolation via JOIN to Property and explicit org_id parameter; warehouse.claims is org-scoped through this join
  const rows = await db.$queryRaw<ClaimRow[]>`
    SELECT c.id, c.value, c.confidence, c.source_document_id, c.valid_from, c.created_at
    FROM warehouse.claims c
    JOIN "Property" p ON p.id = c.property_id
    WHERE c.property_id = ${args.property_id}::uuid
      AND p."organizationId" = ${args.org_id}::uuid
      AND c.subject = ${subject}
      AND c.predicate = 'tenant_active'
      AND c.claim_kind = 'assertion'
      AND c.valid_from <= ${as_of_iso}::date
      AND (c.valid_to IS NULL OR c.valid_to > ${as_of_iso}::date)
      AND c.superseded_by_claim_id IS NULL
    ORDER BY c.valid_from DESC, c.created_at DESC
  `;

  const generated_at = new Date().toISOString();

  // --- Zero claims: distinguish "no_active_claim" vs "no_claim_for_date" ----
  if (rows.length === 0) {
    // @tenant-isolation-disable-next-line -- reason: diagnostic count query, same org scope as primary query above
    const existsAtAll = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM warehouse.claims c
      JOIN "Property" p ON p.id = c.property_id
      WHERE c.property_id = ${args.property_id}::uuid
        AND p."organizationId" = ${args.org_id}::uuid
        AND c.subject = ${subject}
        AND c.predicate = 'tenant_active'
        AND c.claim_kind = 'assertion'
    `;
    const anyClaims = Number(existsAtAll[0]?.count ?? BigInt(0)) > 0;
    const status: ResolutionStatus = anyClaims
      ? "no_claim_for_date"
      : "no_active_claim";

    const drId = await writeDerivationRecord(db, {
      property_id: args.property_id,
      input_claim_ids: [],
    });

    return {
      query,
      value: null,
      confidence: "low",
      status,
      source_claim_ids: [],
      source_document_ids: [],
      conflicts: [],
      derivation_record_id: drId,
      resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
      generated_at,
    };
  }

  // --- One claim: simple case (§5.2 step 3) --------------------------------
  if (rows.length === 1) {
    const c = rows[0];
    const drId = await writeDerivationRecord(db, {
      property_id: args.property_id,
      input_claim_ids: [c.id],
    });
    return {
      query,
      value: extractTenant(c.value),
      confidence: c.confidence ?? "low",
      status: "single_active_claim",
      source_claim_ids: [c.id],
      source_document_ids: [c.source_document_id],
      conflicts: [],
      derivation_record_id: drId,
      resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
      generated_at,
    };
  }

  // --- Multiple claims: latest wins, others become conflicts (§5.2 step 4) -
  const winner = rows[0];
  const losers = rows.slice(1);

  const conflicts: Conflict[] = losers.map((l: ClaimRow) => ({
    claim_id: l.id,
    reason: "superseded_by_later_claim" as const,
    value: extractTenant(l.value),
    valid_from: l.valid_from.toISOString().slice(0, 10),
  }));

  const drId = await writeDerivationRecord(db, {
    property_id: args.property_id,
    input_claim_ids: [winner.id, ...losers.map((l: ClaimRow) => l.id)],
  });

  return {
    query,
    value: extractTenant(winner.value),
    confidence: downgradeConfidence(winner.confidence ?? "low"), // §5.2 step 5
    status: "latest_active_claim_with_conflicts",
    source_claim_ids: [winner.id, ...losers.map((l: ClaimRow) => l.id)],
    source_document_ids: Array.from(
      new Set([winner.source_document_id, ...losers.map((l: ClaimRow) => l.source_document_id)])
    ),
    conflicts,
    derivation_record_id: drId,
    resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
    generated_at,
  };
}

// ---------------------------------------------------------------------------

/**
 * Extract the Tenant value from a tenant_active claim's value JSONB.
 * Claim value shape (per Task 1.7 Mietvertrag emitter):
 *   { tenants: [{ name, is_legal_entity, legal_form? }] }
 * The emitter only ever puts one tenant in the array; multi-tenant
 * Mietgemeinschaft handling is a Phase 2 schema concern, not the resolver's.
 * Returns the first tenant as a canonical Tenant. Throws if the shape is
 * unrecognizable so contract violations surface immediately rather than
 * silently mapping to null.
 */
function extractTenant(value: any): Tenant { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (
    value &&
    typeof value === "object" &&
    Array.isArray(value.tenants) &&
    value.tenants.length > 0
  ) {
    const t = value.tenants[0];
    if (t && typeof t.name === "string" && typeof t.is_legal_entity === "boolean") {
      const out: Tenant = {
        name: t.name,
        is_legal_entity: t.is_legal_entity,
      };
      if (typeof t.legal_form === "string" && t.legal_form.length > 0) {
        out.legal_form = t.legal_form;
      }
      return out;
    }
  }
  throw new Error(
    `tenant_for_unit: claim value missing required Tenant fields: ${JSON.stringify(value)}`
  );
}

/**
 * Write a DerivationRecord for this resolution call.
 * Best-effort: failures are logged but do not block the resolution result.
 * Returns the new DR id, or null if the write failed.
 */
async function writeDerivationRecord(
  db: PrismaTransactionClient,
  args: {
    property_id: string;
    input_claim_ids: string[];
  }
): Promise<string | null> {
  try {
    const output_id = randomUUID();
    // @tenant-isolation-disable-next-line -- reason: derivation_records insert for resolver audit trail; property_id is already verified as belonging to org_id by the read-path JOIN; output_id is freshly generated UUID
    const rows = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO warehouse.derivation_records (
        property_id, output_type, output_id,
        input_claim_ids, input_extraction_run_ids, rule_refs,
        resolver_version
      ) VALUES (
        ${args.property_id}::uuid, 'resolved_fact', ${output_id}::uuid,
        ${args.input_claim_ids}::uuid[], '{}'::uuid[], ${["§5.2"]}::text[],
        ${RESOLVER_VERSION}
      ) RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn("[tenant_for_unit] derivation_record write failed", err);
    return null;
  }
}
