// DO NOT EDIT — generated from schemas/wohnungsuebergabeprotokoll/schema.yaml
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
  "uebergabe_typ": { id: "uebergabe_typ", type: "enum", enum_values: ["Einzug","Auszug","Eigentümerwechsel","unklar"], severity: "critical" },
  "unit_ref": { id: "unit_ref", type: "enum", enum_values: ["EG","1.OG","2.OG","3.OG","4.OG","DG","Keller","Souterrain"], severity: "critical" },
  "uebergabe_datum": { id: "uebergabe_datum", type: "date", severity: "critical" },
  "kaeufer": { id: "kaeufer", type: "structured", severity: "critical" },
  "verkaeufer": { id: "verkaeufer", type: "structured", severity: "critical" },
  "mieter_in": { id: "mieter_in", type: "structured", severity: "critical" },
  "mieter_out": { id: "mieter_out", type: "structured", severity: "critical" },
  "vacant_possession_language_present": { id: "vacant_possession_language_present", type: "boolean", severity: "important" },
  "vacant_possession_language_excerpts": { id: "vacant_possession_language_excerpts", type: "structured_array", severity: "nice_to_have" },
  "meter_readings": { id: "meter_readings", type: "structured", severity: "important" },
  "damages_noted": { id: "damages_noted", type: "structured", severity: "nice_to_have" },
  "signatures": { id: "signatures", type: "structured", severity: "important" },
};

export const VERIFIER_REFS: Record<string, string[]> = {
  "uebergabe_typ": ["enum"],
  "unit_ref": ["enum"],
  "uebergabe_datum": ["date-format"],
};

export const SCHEMA_VERSION = "2026-05-27-v1";
export const DOC_TYPE = "wohnungsuebergabeprotokoll";
