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
  // Task 4.3c-a: present only on single-source derived fields (graded by
  // validating the derivation); composite derived fields omit them.
  derived_kind?: string;
  normalization_rule?: string;
}

export const GROUNDING_SPECS: Record<string, GroundingSpec> = {
  "nachtrag_scope": { id: "nachtrag_scope", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Änderungsumfang"] },
  "unit_ref": { id: "unit_ref", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Einheit"] },
  "effective_date": { id: "effective_date", severity: "critical", type: "date", scalar: true, derived: false, labels: ["Wirksam ab"] },
  "tenant_identity": { id: "tenant_identity", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Mieter"] },
  "landlord_signature_present": { id: "landlord_signature_present", severity: "critical", type: "boolean", scalar: true, derived: false, labels: ["Vermieter-Unterschrift vorhanden"] },
  "tenant_signature_present": { id: "tenant_signature_present", severity: "critical", type: "boolean", scalar: true, derived: false, labels: ["Mieter-Unterschrift vorhanden"] },
  "document_status": { id: "document_status", severity: "critical", type: "enum", scalar: true, derived: false, labels: ["Dokumentstatus"] },
  "rent_change_payload": { id: "rent_change_payload", severity: "critical", type: "structured", scalar: false, derived: false, labels: ["Mietänderungs-Details"] },
  "tenant_identity_change_payload": { id: "tenant_identity_change_payload", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Mieter-Identitäts-Änderung"] },
  "deposit_change_payload": { id: "deposit_change_payload", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Kautions-Änderung"] },
  "ancillary_cost_change_payload": { id: "ancillary_cost_change_payload", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Nebenkosten-Änderung"] },
  "term_change_payload": { id: "term_change_payload", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Vertragslaufzeit-Änderung"] },
  "usage_right_change_payload": { id: "usage_right_change_payload", severity: "important", type: "structured", scalar: false, derived: false, labels: ["Nutzungsrechts-Änderung"] },
  "other_change_descriptor": { id: "other_change_descriptor", severity: "important", type: "string", scalar: true, derived: false, labels: ["Andere Änderung (Beschreibung)"] },
};

export const SCHEMA_VERSION = "2026-05-28-v1";
export const DOC_TYPE = "mietvertragsnachtrag";
