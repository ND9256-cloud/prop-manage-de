// Verifier contract (architecture §10).
// All verifiers are pure functions. No LLM calls. No model identifiers.
// They validate extracted field values against semantic rules.

export interface VerifierContext {
  // The OCR text of the source document — passed for verifiers that need
  // to confirm the extracted value appears verbatim in the source.
  ocr_text: string;

  // The schema field definition for which this verifier was invoked.
  // Contains: id, type, enum_values (if applicable), normalization_rule_ref, etc.
  field_spec: FieldSpec;

  // The extracted value envelope (per architecture §3.1).
  // Verifiers may read raw_value, normalized_value, evidence, etc.
  field_envelope: FieldEnvelope;
}

export interface FieldSpec {
  id: string;
  type: string;
  enum_values?: string[];
  // Other meta-schema fields included for completeness;
  // individual verifiers reference only what they need.
  [key: string]: unknown;
}

// ── Evidence union (Task 4.3c-b-ii-A) ─────────────────────────────────────────
// Backward-compatible discriminated union on an OPTIONAL evidence_type (absent ⇒
// direct_quote). Inlined here (the Deno Edge Function tree cannot import from
// src/lib) and kept value-identical to src/lib/evidence/types.ts and
// scripts/eval/types.ts. Verifiers run on money fields only and read nothing
// from evidence — this widening is compile-surface only; behavior is unchanged.
export interface EvidenceQuote {
  evidence_type?: "direct_quote";
  quote: string;
  page?: number | null;
  bbox?: unknown;
}

export interface TableCellEvidence {
  evidence_type: "table_cell";
  page?: number | null;
  table_cell: {
    row_anchor?: { quote: string; anchor_type: string; canonical?: string };
    column_anchor: { quote: string; canonical?: string };
    cell_value_raw: string;
    derivation_rule: string;
  };
}

export type Evidence = EvidenceQuote | TableCellEvidence;

export interface FieldEnvelope {
  raw_value: unknown;
  normalized_value: unknown;
  evidence?: Evidence[];
  confidence?: string;
  absence_state: string;
  validation_status?: string;
  [key: string]: unknown;
}

export interface VerifierResult {
  passes: boolean;
  reason?: string; // populated only when passes == false
}

export type Verifier = (ctx: VerifierContext) => VerifierResult;
