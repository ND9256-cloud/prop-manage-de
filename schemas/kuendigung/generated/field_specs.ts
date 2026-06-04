// DO NOT EDIT — generated from schemas/kuendigung/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-08-v1
// Run `npm run gen:schemas` to regenerate.

// Field specs + verifier refs for the eval extractor's V2 config, driven from
// schema.yaml so scripts/eval/extractor.ts cannot drift from the schema source
// of truth. The FieldSpec shape mirrors the verifier contract in
// supabase/functions/process-document/verifiers/types.ts.

export interface FieldSpec {
  id: string;
  type: string;
  severity: string;
  enum_values?: string[];
  // Index signature mirrors the verifier contract (verifiers/types.ts) so a
  // FieldSpec from here is directly assignable where a verifier FieldSpec is
  // expected.
  [key: string]: unknown;
}

export const FIELD_SPECS: Record<string, FieldSpec> = {
  "doc_type_marker": { id: "doc_type_marker", type: "string", severity: "nice_to_have" },
};

export const VERIFIER_REFS: Record<string, string[]> = {};

// Grounding scorer metadata (Task 4.3a). Consumed by scripts/eval/metrics.ts
// (groundingGrade) via scripts/eval/loader.ts (loadGroundingSpecs). Scoring
// only — no effect on extraction. labels are field-specific anchors, NOT broad
// synonyms; derived fields are excluded from grading (derived_pending).
export interface GroundingSpec {
  id: string;
  severity: string;
  type: string;
  scalar: boolean;
  derived: boolean;
  labels: string[];
}

export const GROUNDING_SPECS: Record<string, GroundingSpec> = {
  "doc_type_marker": { id: "doc_type_marker", severity: "nice_to_have", type: "string", scalar: true, derived: false, labels: ["Dokumenttyp-Marker (Stub)"] },
};

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "kuendigung";
