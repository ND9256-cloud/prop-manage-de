// DO NOT EDIT — generated from schemas/mieterhoehung/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-27-v1
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
  "nachtrag_typ": { id: "nachtrag_typ", type: "enum", enum_values: ["mieterhoehung","mietvertragsnachtrag_rent_change","mietvertragsnachtrag_other"], severity: "critical" },
  "rechtsgrundlage": { id: "rechtsgrundlage", type: "enum", enum_values: ["§558","§559","indexmiete","staffelmiete","bilateral","unspecified"], severity: "important" },
  "new_kaltmiete": { id: "new_kaltmiete", type: "money", severity: "critical" },
  "previous_kaltmiete": { id: "previous_kaltmiete", type: "money", severity: "important" },
  "effective_date": { id: "effective_date", type: "date", severity: "critical" },
  "notice_date": { id: "notice_date", type: "date", severity: "nice_to_have" },
  "unit_ref": { id: "unit_ref", type: "enum", enum_values: ["EG","1.OG","2.OG","3.OG","4.OG","DG","Keller","Souterrain"], severity: "critical" },
  "tenant_identity": { id: "tenant_identity", type: "structured", severity: "important" },
  "landlord_signature_present": { id: "landlord_signature_present", type: "boolean", severity: "critical" },
  "tenant_signature_present": { id: "tenant_signature_present", type: "boolean", severity: "important" },
  "document_status": { id: "document_status", type: "enum", enum_values: ["draft","unsigned","signed","executed"], severity: "critical" },
  "staffelmiete_context": { id: "staffelmiete_context", type: "boolean", severity: "important" },
  "paragraph_558_basis": { id: "paragraph_558_basis", type: "structured", severity: "nice_to_have" },
  "paragraph_559_basis": { id: "paragraph_559_basis", type: "structured", severity: "nice_to_have" },
  "indexmiete_basis": { id: "indexmiete_basis", type: "structured", severity: "nice_to_have" },
};

export const VERIFIER_REFS: Record<string, string[]> = {
  "nachtrag_typ": ["enum"],
  "rechtsgrundlage": ["enum"],
  "new_kaltmiete": ["monetary-verbatim"],
  "previous_kaltmiete": ["monetary-verbatim"],
  "effective_date": ["date-format"],
  "notice_date": ["date-format"],
  "unit_ref": ["enum"],
  "document_status": ["enum"],
};

export const SCHEMA_VERSION = "2026-05-27-v1";
export const DOC_TYPE = "mieterhoehung";
