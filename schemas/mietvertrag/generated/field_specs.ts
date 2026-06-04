// DO NOT EDIT — generated from schemas/mietvertrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-21-v1
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
  "kaltmiete": { id: "kaltmiete", type: "money", severity: "critical" },
  "unit_ref": { id: "unit_ref", type: "enum", enum_values: ["EG","1.OG","2.OG","3.OG","4.OG","DG","Keller","Souterrain"], severity: "critical" },
  "tenant_identity": { id: "tenant_identity", type: "structured", severity: "critical" },
  "mietbeginn": { id: "mietbeginn", type: "date", severity: "critical" },
  "mietende": { id: "mietende", type: "date", severity: "important" },
  "nebenkostenvorauszahlung": { id: "nebenkostenvorauszahlung", type: "money", severity: "important" },
  "kaution": { id: "kaution", type: "money", severity: "important" },
  "landlord_identity": { id: "landlord_identity", type: "structured", severity: "critical" },
};

export const VERIFIER_REFS: Record<string, string[]> = {
  "kaltmiete": ["monetary-verbatim"],
  "unit_ref": ["enum"],
  "mietbeginn": ["date-format"],
  "mietende": ["date-format"],
  "nebenkostenvorauszahlung": ["monetary-verbatim"],
  "kaution": ["monetary-verbatim"],
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
  "kaltmiete": { id: "kaltmiete", severity: "critical", type: "money", scalar: true, derived: false, labels: ["Kaltmiete","Grundmiete","Nettokaltmiete","Nettomiete"] },
  "unit_ref": { id: "unit_ref", severity: "critical", type: "enum", scalar: true, derived: true, labels: ["Einheit"] },
  "tenant_identity": { id: "tenant_identity", severity: "critical", type: "structured", scalar: false, derived: false, labels: ["Mieter"] },
  "mietbeginn": { id: "mietbeginn", severity: "critical", type: "date", scalar: true, derived: false, labels: ["Mietbeginn","Mietzeit"] },
  "mietende": { id: "mietende", severity: "important", type: "date", scalar: true, derived: false, labels: ["Mietende"] },
  "nebenkostenvorauszahlung": { id: "nebenkostenvorauszahlung", severity: "important", type: "money", scalar: true, derived: false, labels: ["Nebenkostenvorauszahlung","Betriebskostenvorauszahlung","NK-Vorauszahlung"] },
  "kaution": { id: "kaution", severity: "important", type: "money", scalar: true, derived: false, labels: ["Kaution","Mietsicherheit","Barkaution","Sicherheitsleistung"] },
  "landlord_identity": { id: "landlord_identity", severity: "critical", type: "structured", scalar: false, derived: false, labels: ["Vermieter"] },
};

export const SCHEMA_VERSION = "2026-05-21-v1";
export const DOC_TYPE = "mietvertrag";
