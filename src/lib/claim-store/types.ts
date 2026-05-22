// Shared types for the claim-store transaction applier.

import type { ClaimClosure } from "../emitters/types.ts";

/**
 * Inputs the applier needs that aren't on the EmissionResult itself.
 *
 * - property_id: the property the emission is about; checked against org_id
 * - org_id: the organization the property belongs to; used as a tenant-isolation
 *   guard. The applier verifies property_id is in this org before any write.
 * - extraction_run_id: links the inserts to their source extraction. Null only
 *   when the EmissionResult comes from a human adjudication path (where claims
 *   have source_type="human_adjudication" and human_actor_id is set instead).
 * - emitter_version: written to DerivationRecord.emitter_version. Pass the
 *   `EMITTER_VERSION` constant exported by the emitter that produced the
 *   EmissionResult. Null for human adjudication.
 */
export interface ApplyContext {
  property_id: string;
  org_id: string;
  extraction_run_id: string | null;
  emitter_version: string | null;
}

/**
 * What the applier returns after committing.
 *
 * - inserted_claim_ids: ids of newly-inserted rows in warehouse.claims (skipped
 *   duplicates do NOT appear here; only fresh inserts).
 * - skipped_duplicate_claim_ids: ids of existing rows that the idempotency
 *   check matched (useful for logging "re-run was a no-op for these").
 * - applied_closure_ids: ids of newly-inserted rows in warehouse.claim_closures.
 * - blocked_closure_intents: closure intents that did not apply because a
 *   blocker check set requires_review or the emitter pre-set requires_review.
 *   The applier returns them so the caller can surface them in triage.
 * - derivation_record_ids: ids of newly-inserted rows in warehouse.derivation_records.
 */
export interface ApplyResult {
  inserted_claim_ids: string[];
  skipped_duplicate_claim_ids: string[];
  applied_closure_ids: string[];
  blocked_closure_intents: BlockedClosureIntent[];
  derivation_record_ids: string[];
}

/**
 * A closure intent that was not applied, with reason. The new event claim
 * is still inserted; only the closure is suspended.
 */
export interface BlockedClosureIntent {
  intent: ClaimClosure;
  reason: BlockerReason;
  detail: string;
}

export type BlockerReason =
  | "emitter_set_requires_review"
  | "multi_tenant_partial"
  | "vacant_possession_warning"
  | "staffelmiete_conflict"
  | "tenant_match_failed"
  | "predicate_not_in_allowlist";

export const APPLIER_VERSION = "1.0.0";
