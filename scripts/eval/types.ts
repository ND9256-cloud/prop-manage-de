// Eval harness types (architecture §3.1 envelope, §13.2 metrics).
//
// These types mirror the runtime envelope shape produced by Step 8b
// (supabase/functions/process-document/index.ts generateV2Envelope).
// The eval harness is pure Node and does not import from the Deno
// edge-function tree.

export type AbsenceState =
  | "present"
  | "absent"
  | "illegible"
  | "ambiguous"
  | "contradicted"
  | "not_applicable"
  | "inferred"
  | "requires_human_review";

export type Severity = "critical" | "important" | "nice_to_have";

export type Confidence = "high" | "medium" | "low";

export interface EvidenceQuote {
  quote: string;
  page?: number | null;
  bbox?: unknown;
}

export interface FieldEnvelope {
  raw_value: unknown;
  normalized_value: unknown;
  evidence?: EvidenceQuote[];
  confidence?: Confidence | null;
  absence_state: AbsenceState;
  validation_status?: string;
  severity?: Severity;
  [extra: string]: unknown;
}

export interface ExtractionEnvelope {
  doc_type: string;
  schema_version?: string;
  prompt_version?: string;
  model?: string;
  fields: Record<string, FieldEnvelope>;
  lifecycle?: Record<string, unknown>;
}

// Schema field definition as loaded from schemas/<doc_type>/schema.yaml
export interface SchemaFieldDef {
  id: string;
  severity: Severity;
  type?: string;
  [key: string]: unknown;
}

// Per-field metric result. All flags are booleans, never null —
// score() always produces a verdict per field even for absent gold values.
export interface FieldMetricResult {
  field_id: string;
  severity: Severity;
  // Gold + candidate absence_state, kept for diffing.
  gold_absence_state: AbsenceState;
  candidate_absence_state: AbsenceState | "missing";
  exact_match: boolean;
  normalized_match: boolean;
  evidence_grounded: boolean;
  absence_state_correct: boolean;
  // 1 if any of the four binary metrics is wrong, else 0.
  // Severity-weighted error rate is computed by summing
  // (severity_weight * has_error) and dividing by sum of weights.
  has_error: boolean;
}

export interface DocTypeMetricSummary {
  doc_type: string;
  fixture_id: string;
  // Per-field detail.
  fields: FieldMetricResult[];
  // Aggregates (per fixture/doc_type combo).
  exact_match_rate: number;
  normalized_match_rate: number;
  evidence_grounded_rate: number;
  absence_state_correct_rate: number;
  severity_weighted_error_rate: number;
}

export interface RunMetadata {
  mode: "score" | "extract";
  model: string;
  ran_at: string; // ISO timestamp
  split: string;
  fixture_count: number;
}

export interface EvalRunResult {
  meta: RunMetadata;
  per_fixture: DocTypeMetricSummary[];
  // Fixtures that had no candidate envelope and were SKIPPED (not scored).
  // These are excluded from per_fixture and from every aggregate below so a
  // missing candidate cannot be miscounted as a total failure. Empty in
  // gold self-score mode (gold is always its own candidate).
  skipped_no_candidate: string[];
  // Roll-up: per doc_type aggregate across all fixtures of that doc_type.
  per_doc_type: Record<string, {
    fixture_count: number;
    exact_match_rate: number;
    normalized_match_rate: number;
    evidence_grounded_rate: number;
    absence_state_correct_rate: number;
    severity_weighted_error_rate: number;
  }>;
}
