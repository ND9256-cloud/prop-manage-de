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

// ── Evidence (discriminated on OPTIONAL evidence_type) ────────────────────────
// Backward compatible: when evidence_type is absent the entry IS a direct_quote,
// so every existing { quote, page, bbox } fixture is unchanged and still valid.
// Task 4.3c-b-1a adds the EVAL-only table_cell variant (the proving ground for
// table-cell grounding); promoting it to the production envelope + teaching the
// extractor to emit it is the separate next task (4.3c-b-1b).
import type { DerivationRule } from "./derivation-rules.ts";

export interface EvidenceQuote {
  evidence_type?: "direct_quote";
  quote: string;
  page?: number | null;
  bbox?: unknown;
}

// Row/column anchors carry the model's CITED header/row text plus an optional
// model-declared canonical; the scorer grounds the quote and validates the
// canonical against OCR — it never trusts the canonical on its own.
export interface RowAnchor {
  quote: string;
  anchor_type: string;
  canonical?: string;
}

export interface ColumnAnchor {
  quote: string;
  canonical?: string;
}

// A proposed table cell. cell_value_raw is the RAW OCR token (e.g. "1"), stored
// SEPARATELY from the field's normalized value; the scorer grounds the raw token
// and reproduces the normalized value via derivation_rule. A model-declared
// normalized cell value (if any extra key is present) is ignored + recomputed.
export interface TableCell {
  row_anchor: RowAnchor;
  column_anchor: ColumnAnchor;
  cell_value_raw: string;
  derivation_rule: DerivationRule;
}

export interface TableCellEvidence {
  evidence_type: "table_cell";
  page?: number | null;
  table_cell: TableCell;
}

export type Evidence = EvidenceQuote | TableCellEvidence;

export interface FieldEnvelope {
  raw_value: unknown;
  normalized_value: unknown;
  evidence?: Evidence[];
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

// ── Evidence-grounding grade (Task 4.3a) ──────────────────────────────────
// A field-aware, same-page, local-window grounding GRADE (0–3) for direct
// scalar fields. Distinct from normalized_match (value-correctness): this
// measures whether the claimed value is grounded in the OCR near a
// field-specific label. The two are never collapsed.
export type GroundingGrade = 0 | 1 | 2 | 3;

// Why a field was NOT assigned a numeric grade (excluded from the aggregate):
//   derived_pending — composite/derived field (e.g. unit_ref); deferred to 4.3c
//   non_scalar      — structured/structured_array field; out of scope for v1
//   absent          — candidate did not assert a value (nothing to ground)
//   no_ocr          — no source OCR text available to verify against
export type GroundingExclusion = "derived_pending" | "non_scalar" | "absent" | "no_ocr";

export interface FieldGroundingResult {
  field_id: string;
  severity: Severity;
  // True iff a numeric grade was assigned (present scalar non-derived field
  // with OCR). When false, `grade` is null and `excluded` says why.
  graded: boolean;
  grade: GroundingGrade | null;
  excluded: GroundingExclusion | null;
  // The field-specific label that anchored a grade-3, if any (else null).
  matched_label: string | null;
  // The page the value was located on (1-based), if found in scope.
  value_page: number | null;
  // Whether the candidate evidence carried a page number at all.
  evidence_page_present: boolean;
}

export interface GroundingSummary {
  fields: FieldGroundingResult[];
  // Number of fields that received a numeric grade.
  graded_count: number;
  // Mean grade over graded fields (0–3), and that mean as a 0–1 rate (mean/3).
  grade_mean: number;
  grade_rate: number;
  // Fraction of graded fields that reached the top grade (3).
  grade3_rate: number;
  // Field ids excluded as derived (derived_pending) — surfaced for visibility.
  derived_pending: string[];
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
  // Evidence-grounding grade (Task 4.3a). Optional: only populated when
  // grounding specs are supplied to scoreFixture (the run.ts score path).
  // Kept separate from the metrics above — value-correctness vs grounding are
  // never collapsed.
  grounding?: GroundingSummary;
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
    // Task 4.3a grounding-grade roll-up. Optional (only when grounding specs
    // were supplied). Mean grade across graded fields of all fixtures, the
    // matching 0–1 rate, top-grade fraction, and total graded field count.
    grounding_grade_mean?: number;
    grounding_grade_rate?: number;
    grounding_grade3_rate?: number;
    grounding_graded_count?: number;
  }>;
}

// Grounding spec consumed by metrics.groundingGrade. Structurally matches the
// generated GROUNDING_SPECS in schemas/<doc_type>/generated/field_specs.ts.
export interface GroundingSpec {
  id: string;
  severity: Severity;
  type: string;
  scalar: boolean;
  derived: boolean;
  labels: string[];
  // Task 4.3c-a derived-grounding metadata (scoring-only). Present only on
  // derived fields. derived_kind === "single_source" marks a derived field
  // whose value is reproducible from ONE cited source phrase via a declared
  // deterministic normalization_rule (e.g. unit_ref / floor_synonym_normalization);
  // such fields get a 0/1/3 derived grade. Derived fields WITHOUT a single_source
  // rule (composite/multi-component, e.g. addresses) stay derived_pending (4.3c-b).
  derived_kind?: string;
  normalization_rule?: string;
}
