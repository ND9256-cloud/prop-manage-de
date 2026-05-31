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

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "kuendigung";
