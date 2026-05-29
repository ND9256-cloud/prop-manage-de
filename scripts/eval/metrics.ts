// Deterministic, no-LLM metrics module for the eval harness (architecture §13.2).
//
// Every function in this file is pure: identical inputs produce identical outputs.
// No I/O, no model calls. Tested in src/tests/eval/metrics.test.ts.

import type {
  AbsenceState,
  DocTypeMetricSummary,
  ExtractionEnvelope,
  FieldEnvelope,
  FieldMetricResult,
  SchemaFieldDef,
  Severity,
} from "./types.ts";

// Severity weights for the severity-weighted error rate.
// Critical errors count 5x a nice-to-have error. The choice of weights
// is documented; the exact ratio is not load-bearing.
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 5,
  important: 2,
  nice_to_have: 1,
};

function severityWeight(s: Severity): number {
  return SEVERITY_WEIGHT[s];
}

// ── exact_match ──────────────────────────────────────────────────────────
// raw_value string equality. Both null/undefined counts as a match
// (used when gold is absent and candidate correctly omits the value).
export function exactMatch(gold: FieldEnvelope, candidate: FieldEnvelope | undefined): boolean {
  if (!candidate) return gold.raw_value == null;
  if (gold.raw_value == null && candidate.raw_value == null) return true;
  if (gold.raw_value == null || candidate.raw_value == null) return false;
  return String(gold.raw_value) === String(candidate.raw_value);
}

// ── normalized_match ─────────────────────────────────────────────────────
// Canonical deep-equal of normalized_value. Object keys are sorted before
// comparison so { a: 1, b: 2 } == { b: 2, a: 1 }. Numbers compared by
// value, NOT by string representation (so 65000 != "65000" — that's a
// schema-type bug, not a normalization equivalence).
export function normalizedMatch(gold: FieldEnvelope, candidate: FieldEnvelope | undefined): boolean {
  if (!candidate) return gold.normalized_value == null;
  return deepEqual(gold.normalized_value, candidate.normalized_value);
}

// Internal: deterministic deep-equal. Arrays compared positionally.
// Objects compared by sorted keys. Primitives compared with ===.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) return false;
  }
  return true;
}

// ── evidence_grounded ────────────────────────────────────────────────────
// True iff candidate evidence array contains at least one entry whose
// quote appears verbatim in the source OCR text. Whitespace is normalized
// before substring search (runs of whitespace -> single space) so that
// PDF-extracted quotes with newlines still match the OCR text.
//
// Architecture: the 4.5 critic handles semantic "does this quote justify
// the value?" — this metric only checks that the candidate didn't
// hallucinate the quote.
//
// Special cases:
// - If gold absence_state != "present", evidence is not required. Return
//   true iff candidate evidence is also absent.
// - If candidate has no evidence array or it is empty when present is
//   claimed, return false.
export function evidenceGrounded(
  gold: FieldEnvelope,
  candidate: FieldEnvelope | undefined,
  ocrText: string | undefined
): boolean {
  if (!candidate) {
    // No candidate; valid only if gold was also absent.
    return gold.absence_state !== "present";
  }
  if (candidate.absence_state !== "present") {
    // Candidate is not asserting a value — vacuously grounded.
    return true;
  }
  const evidence = candidate.evidence ?? [];
  if (evidence.length === 0) return false;
  // Without source text we cannot verify groundedness. Be conservative
  // and treat missing source as "not grounded" so the harness can flag
  // the gap. Score mode passes ocrText=undefined when fixtures lack
  // source documents — see scripts/eval/loader.ts.
  if (!ocrText) return false;
  const normalizedSource = normalizeWhitespace(ocrText);
  return evidence.some((e) => {
    if (!e || typeof e.quote !== "string" || e.quote.trim() === "") return false;
    const normalizedQuote = normalizeWhitespace(e.quote);
    return normalizedSource.includes(normalizedQuote);
  });
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── absence_state_correct ────────────────────────────────────────────────
// Gold-present requires candidate-present; gold-absent (any absence
// state) requires candidate to also report absence with NO value.
// We do not require gold and candidate absence_state to match exactly
// across absence flavors (e.g., gold "absent" vs candidate "not_applicable"
// is OK for this metric) — the four absence flavors are model-judgment
// calls. The hard rule is: did the candidate hallucinate a value where
// gold says absent? That's what this metric catches.
export function absenceStateCorrect(
  gold: FieldEnvelope,
  candidate: FieldEnvelope | undefined
): boolean {
  const goldPresent = gold.absence_state === "present";
  if (!candidate) return !goldPresent;
  const candPresent = candidate.absence_state === "present";
  if (goldPresent !== candPresent) return false;
  // Both present OR both absent.
  if (!goldPresent) {
    // Candidate must not have populated a value.
    return candidate.raw_value == null && candidate.normalized_value == null;
  }
  return true;
}

// ── severity_weighted_error_rate ─────────────────────────────────────────
// sum over fields of (weight * has_error) / sum over fields of weight.
// has_error == ANY of (exact, normalized, evidence_grounded,
// absence_state_correct) is wrong.
export function severityWeightedErrorRate(fields: FieldMetricResult[]): number {
  if (fields.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const f of fields) {
    const w = severityWeight(f.severity);
    totalWeight += w;
    if (f.has_error) weighted += w;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

// ── score: scores a single (candidate, gold) envelope pair ───────────────
// Iterates every field declared by the schema's field defs. A field
// absent from the candidate is treated as candidate undefined; the
// metric functions handle that case.
export function scoreFixture(
  fixtureId: string,
  docType: string,
  gold: ExtractionEnvelope,
  candidate: ExtractionEnvelope | undefined,
  schemaFields: SchemaFieldDef[],
  ocrText: string | undefined
): DocTypeMetricSummary {
  const candidateFields = candidate?.fields ?? {};
  const results: FieldMetricResult[] = [];

  for (const def of schemaFields) {
    const goldField = gold.fields[def.id];
    if (!goldField) {
      // Gold envelope does not declare this field. Skip it from the
      // summary; the fixture loader is the place to flag schema/gold
      // drift, not metrics.
      continue;
    }
    const candField = candidateFields[def.id];
    const exact = exactMatch(goldField, candField);
    const normalized = normalizedMatch(goldField, candField);
    const grounded = evidenceGrounded(goldField, candField, ocrText);
    const absenceOk = absenceStateCorrect(goldField, candField);
    const hasError = !(exact && normalized && grounded && absenceOk);
    results.push({
      field_id: def.id,
      severity: def.severity,
      gold_absence_state: goldField.absence_state,
      candidate_absence_state: (candField?.absence_state ?? "missing") as AbsenceState | "missing",
      exact_match: exact,
      normalized_match: normalized,
      evidence_grounded: grounded,
      absence_state_correct: absenceOk,
      has_error: hasError,
    });
  }

  const n = results.length;
  const rate = (count: number) => (n === 0 ? 0 : count / n);
  return {
    doc_type: docType,
    fixture_id: fixtureId,
    fields: results,
    exact_match_rate: rate(results.filter((r) => r.exact_match).length),
    normalized_match_rate: rate(results.filter((r) => r.normalized_match).length),
    evidence_grounded_rate: rate(results.filter((r) => r.evidence_grounded).length),
    absence_state_correct_rate: rate(results.filter((r) => r.absence_state_correct).length),
    severity_weighted_error_rate: severityWeightedErrorRate(results),
  };
}

export const __TEST_ONLY__ = { severityWeight };
