// Shared types for emitters. Mirrors warehouse.claims / warehouse.claim_closures schema.
// Emitters return plain objects; applier (Task 1.8) maps them to DB rows.

export type ClaimKind = "assertion" | "snapshot" | "event" | "reference";

export type SourceType = "document_extraction" | "human_adjudication" | "system_derivation";

export type Confidence = "high" | "medium" | "low";

/**
 * A claim to be inserted by the applier.
 *
 * Note: id, created_at, superseded_at, superseded_by_claim_id are
 * applier-assigned. Emitters never set them.
 */
export interface Claim {
  property_id: string;
  subject: string;              // e.g., "unit:1.OG", "property"
  predicate: string;            // e.g., "kaltmiete", "tenant_active", "kaution"
  value: Record<string, unknown>; // jsonb payload
  claim_kind: ClaimKind;
  valid_from: string;           // ISO date
  valid_to: string | null;
  source_document_id: string;
  source_extraction_run_id: string;
  source_field_path: string;    // e.g., "fields.kaltmiete"
  confidence: Confidence;
  evidence_id: string | null;
  source_type: SourceType;
  human_actor_id: string | null;
}

/**
 * Closure intent — emitted by Mieterhoehung, Kuendigung, Uebergabeprotokoll
 * (not by Mietvertrag). Included here for shared type surface.
 */
export interface ClaimClosure {
  target_subject: string;
  target_predicates: string[];
  close_at: string;             // ISO date driving valid_to
  close_mode: "close_overlapping_only" | "close_overlapping_and_future" | "close_overlapping_and_supersede_future";
  match: {
    tenant_identity?: string;
    policy_id?: string;
    lease_id?: string;
  };
  match_strictness: "required" | "optional" | "absent";
  blocker_status: "none" | "requires_review";
}

export interface EmissionResult {
  claims_to_insert: Claim[];
  closure_intents: ClaimClosure[];
}

/**
 * Context the emitter needs that isn't on the envelope itself.
 *
 * property_id and source_document_id come from warehouse.documents (the
 * pipeline that calls the emitter already has these). source_extraction_run_id
 * comes from the extraction run record. evidence_id is set if evidence rows
 * exist (envelope evidence anchors map to warehouse.evidence rows, which
 * Phase 0 ships).
 *
 * Emitter does not query for any of these — the caller provides them.
 */
export interface EmitterContext {
  property_id: string;
  source_document_id: string;
  source_extraction_run_id: string;
  evidence_id_for_field: (field_path: string) => string | null;
}
