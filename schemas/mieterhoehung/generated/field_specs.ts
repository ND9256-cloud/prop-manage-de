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
  "nachtrag_typ": { id: "nachtrag_typ", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Dokumenttyp"] },
  "rechtsgrundlage": { id: "rechtsgrundlage", severity: "important", type: "enum", scalar: true, derived: false, labels: ["Rechtsgrundlage"] },
  "new_kaltmiete": { id: "new_kaltmiete", severity: "critical", type: "money", scalar: true, derived: false, labels: ["Neue Kaltmiete"] },
  "previous_kaltmiete": { id: "previous_kaltmiete", severity: "important", type: "money", scalar: true, derived: false, labels: ["Bisherige Kaltmiete"] },
  "effective_date": { id: "effective_date", severity: "critical", type: "date", scalar: true, derived: false, labels: ["Wirksam ab"] },
  "notice_date": { id: "notice_date", severity: "nice_to_have", type: "date", scalar: true, derived: false, labels: ["Datum des Erhöhungsschreibens"] },
  "unit_ref": { id: "unit_ref", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Einheit"] },
  "tenant_identity": { id: "tenant_identity", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Mieter"] },
  "landlord_signature_present": { id: "landlord_signature_present", severity: "critical", type: "boolean", scalar: true, derived: false, labels: ["Vermieter-Unterschrift vorhanden"] },
  "tenant_signature_present": { id: "tenant_signature_present", severity: "important", type: "boolean", scalar: true, derived: false, labels: ["Mieter-Unterschrift vorhanden"] },
  "document_status": { id: "document_status", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Dokumentstatus"] },
  "staffelmiete_context": { id: "staffelmiete_context", severity: "important", type: "boolean", scalar: true, derived: false, labels: ["Staffelmiete-Kontext erkannt"] },
  "paragraph_558_basis": { id: "paragraph_558_basis", severity: "nice_to_have", type: "structured", scalar: false, derived: false, labels: ["§558 Vergleichsmieten-Begründung"] },
  "paragraph_559_basis": { id: "paragraph_559_basis", severity: "nice_to_have", type: "structured", scalar: false, derived: false, labels: ["§559 Modernisierungs-Begründung"] },
  "indexmiete_basis": { id: "indexmiete_basis", severity: "nice_to_have", type: "structured", scalar: false, derived: false, labels: ["Indexmiete-Begründung"] },
};

export const SCHEMA_VERSION = "2026-05-27-v1";
export const DOC_TYPE = "mieterhoehung";
