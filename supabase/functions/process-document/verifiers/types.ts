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

export interface FieldEnvelope {
  raw_value: unknown;
  normalized_value: unknown;
  evidence?: { quote: string; page?: number; bbox?: unknown };
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
