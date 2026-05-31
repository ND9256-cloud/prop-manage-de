// DO NOT EDIT — generated from schemas/mietvertragsnachtrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-28-v1
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
  "nachtrag_scope": { id: "nachtrag_scope", type: "enum", enum_values: ["rent_change","tenant_identity_change","deposit_change","ancillary_cost_change","term_change","usage_right_change","other"], severity: "critical" },
  "unit_ref": { id: "unit_ref", type: "enum", enum_values: ["EG","1.OG","2.OG","3.OG","4.OG","DG","Keller","Souterrain"], severity: "critical" },
  "effective_date": { id: "effective_date", type: "date", severity: "critical" },
  "tenant_identity": { id: "tenant_identity", type: "structured", severity: "important" },
  "landlord_signature_present": { id: "landlord_signature_present", type: "boolean", severity: "critical" },
  "tenant_signature_present": { id: "tenant_signature_present", type: "boolean", severity: "critical" },
  "document_status": { id: "document_status", type: "enum", enum_values: ["draft","unsigned","signed","executed"], severity: "critical" },
  "rent_change_payload": { id: "rent_change_payload", type: "structured", severity: "critical" },
  "tenant_identity_change_payload": { id: "tenant_identity_change_payload", type: "structured", severity: "important" },
  "deposit_change_payload": { id: "deposit_change_payload", type: "structured", severity: "important" },
  "ancillary_cost_change_payload": { id: "ancillary_cost_change_payload", type: "structured", severity: "important" },
  "term_change_payload": { id: "term_change_payload", type: "structured", severity: "important" },
  "usage_right_change_payload": { id: "usage_right_change_payload", type: "structured", severity: "important" },
  "other_change_descriptor": { id: "other_change_descriptor", type: "string", severity: "important" },
};

export const VERIFIER_REFS: Record<string, string[]> = {
  "nachtrag_scope": ["enum"],
  "unit_ref": ["enum"],
  "effective_date": ["date-format"],
  "document_status": ["enum"],
};

export const SCHEMA_VERSION = "2026-05-28-v1";
export const DOC_TYPE = "mietvertragsnachtrag";
