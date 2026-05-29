// Shared types for resolvers. Architecture §5.1.
//
// A resolver is a pure function that answers exactly one question by querying
// the claim store. It returns a ResolvedFact with full provenance so the
// caller (UI, agent, downstream resolver) can trust or audit the answer.

export type ResolverConfidence = "high" | "medium" | "low";

/**
 * Status of a resolution call. Maps directly to the resolution_rule_applied
 * field from architecture §5.2.
 *
 * - single_active_claim: exactly one claim matched the query (the simple case)
 * - latest_active_claim_with_conflicts: multiple claims matched; we picked the
 *   latest by (valid_from desc, created_at desc); others are in `conflicts`
 * - no_active_claim: zero claims matched; value is null
 * - no_claim_for_date: zero claims matched because as_of_date was before any
 *   claim's valid_from (distinct from no_active_claim for diagnostic clarity)
 */
export type ResolutionStatus =
  | "single_active_claim"
  | "latest_active_claim_with_conflicts"
  | "no_active_claim"
  | "no_claim_for_date";

export interface Money {
  amount: number; // minor units (cents for EUR)
  currency: string; // ISO 4217, e.g. "EUR"
}

/**
 * Minimal tenant shape built from a tenant_active claim's value JSONB.
 * Mirrors the tenant_identity normalized_value fields the Mietvertrag schema
 * emits (schemas/mietvertrag/schema.yaml): name + is_legal_entity + optional
 * legal_form. The resolver returns the first tenant from value.tenants[]
 * (single-tenant per claim today; multi-tenant Mietgemeinschaft handling is
 * a Phase 2 schema change, not a resolver concern).
 */
export interface Tenant {
  name: string;
  is_legal_entity: boolean;
  legal_form?: string;
}

export interface Conflict {
  claim_id: string;
  reason: "superseded_by_later_claim";
  value: unknown;
  valid_from: string; // ISO date
}

/**
 * The return shape of every resolver. Architecture §5.1.
 *
 * Generic over the value type so different resolvers return typed values
 * (Money for rent, string for tenant name, etc.).
 *
 * - query: the inputs that produced this result, for caching and audit
 * - value: the resolved value, or null if no claim matched
 * - confidence: derived from the winning claim's confidence, downgraded one
 *   step if any conflicts were present
 * - status: see ResolutionStatus
 * - source_claim_ids: the claim(s) that contributed to this result. For
 *   single_active_claim, exactly one id. For conflicts case, the winner first.
 * - source_document_ids: the documents those claims came from
 * - conflicts: empty array unless status = latest_active_claim_with_conflicts
 * - derivation_record_id: the DR row this call wrote, for audit linking
 * - resolver: name + version of the resolver that produced this fact
 * - generated_at: timestamp at end of resolution
 */
export interface ResolvedFact<TValue> {
  query: Record<string, unknown>;
  value: TValue | null;
  confidence: ResolverConfidence;
  status: ResolutionStatus;
  source_claim_ids: string[];
  source_document_ids: string[];
  conflicts: Conflict[];
  derivation_record_id: string | null;
  resolver: { name: string; version: string };
  generated_at: string;
}

/**
 * Downgrade confidence by one step. high → medium → low → low (floor).
 * Used when conflicts are present per §5.2 step 5.
 */
export function downgradeConfidence(c: ResolverConfidence): ResolverConfidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}
