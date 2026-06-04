// Deterministic, no-LLM metrics module for the eval harness (architecture §13.2).
//
// Every function in this file is pure: identical inputs produce identical outputs.
// No I/O, no model calls. Tested in src/tests/eval/metrics.test.ts.

import type {
  AbsenceState,
  DocTypeMetricSummary,
  ExtractionEnvelope,
  FieldEnvelope,
  FieldGroundingResult,
  FieldMetricResult,
  GroundingGrade,
  GroundingSpec,
  GroundingSummary,
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

// ── evidence-grounding GRADE (Task 4.3a) ─────────────────────────────────
// A field-aware, same-page, local-window grounding grade (0–3) for direct
// scalar fields. This REPLACES the verbatim-quote intuition of the legacy
// `evid` metric with one that asks "is the claimed value sitting in the OCR,
// on the right page, next to a field-specific label?" — without re-extraction
// and without an LLM. It is value-correctness-independent: a value can be
// wrong (normalized_match=false) yet well-grounded, or correct yet ungrounded.
//
// Grades (per scalar field):
//   3 — value in a same-page local window AND a field-specific label/anchor in
//       that window.
//   2 — value in same-page window, no field-specific label nearby (or
//       evidence.page missing on a CRITICAL field → capped at 2).
//   1 — value appears somewhere in OCR but not in the scoped page/window.
//   0 — value not in OCR at all.
//
// Windows are SAME PAGE ONLY (never cross pages):
//   - direct: ±5 OCR lines around the value occurrence,
//   - table-tolerant lookback: a field label/header in the previous 10 lines.
// If candidate evidence carries a page, the value search is restricted to it.
//
// Pure / deterministic / DB-free / API-free. Label sets come from the caller
// (schemas/<doc_type>/generated/field_specs.ts GROUNDING_SPECS), never hardcoded.

interface OcrPage {
  page: number; // 1-based page number from the "--- Seite N ---" marker.
  lines: string[];
}

// Splits OCR text into pages on "--- Seite N ---" markers (the fixture OCR
// convention). Text before the first marker is page 1. The marker line itself
// is not content. Whitespace-only trailing pages are kept (deterministic).
export function parseOcrPages(ocrText: string): OcrPage[] {
  const lines = ocrText.split("\n");
  const pages: OcrPage[] = [];
  let current: OcrPage = { page: 1, lines: [] };
  let sawMarker = false;
  for (const line of lines) {
    const m = line.match(/^---\s*Seite\s+(\d+)\s*---\s*$/i);
    if (m) {
      // Flush the current page if it already accumulated content, or if we've
      // seen a marker before (so empty pages between markers are preserved).
      if (current.lines.length > 0 || sawMarker) pages.push(current);
      current = { page: parseInt(m[1], 10), lines: [] };
      sawMarker = true;
      continue;
    }
    current.lines.push(line);
  }
  pages.push(current);
  return pages;
}

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Token boundary that treats letters/digits/decimal punctuation as "inside" a
// token, so "650,00" does not match inside "1.650,00" and the label "Miete"
// does not match inside "Grundmiete".
function valueOccurs(normLine: string, form: string): boolean {
  const f = normalizeForMatch(form);
  if (f === "") return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}.,])${escapeRegExp(f)}(?![\\p{L}\\p{N}.,])`, "u");
  return re.test(normLine);
}

// Field labels match on letter boundaries only (so "Mietzeit" matches but
// "Miete" does not match inside "Grundmiete").
function labelOccurs(normLine: string, label: string): boolean {
  const l = normalizeForMatch(label);
  if (l === "") return false;
  const re = new RegExp(`(?<!\\p{L})${escapeRegExp(l)}(?!\\p{L})`, "u");
  return re.test(normLine);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function groupThousands(intPart: string): string {
  // 1950 -> "1.950" (German grouping). Sign-free input expected.
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const GERMAN_MONTHS = [
  "januar", "februar", "märz", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
];

// Generates the accepted surface forms of a candidate value to search for in
// OCR. Money: "650,00" = "650.00" = "650" = "1.950,00". Dates: ISO ->
// "01.04.2025" / "1.4.2025" / "1. April 2025". Other scalars: raw + normalized.
export function valueSurfaceForms(candidate: FieldEnvelope, type: string): string[] {
  const forms = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s === "string" && s.trim() !== "") forms.add(s.trim());
    else if (typeof s === "number") forms.add(String(s));
  };

  if (typeof candidate.raw_value === "string") add(candidate.raw_value);

  const nv = candidate.normalized_value;

  if (type === "money" && nv && typeof nv === "object") {
    const amount = (nv as { amount?: unknown }).amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      const sign = amount < 0 ? "-" : "";
      const abs = Math.abs(amount);
      const intPart = Math.trunc(abs / 100);
      const cents = abs % 100;
      const intStr = String(intPart);
      const grouped = groupThousands(intStr);
      add(`${sign}${intStr},${pad2(cents)}`);
      add(`${sign}${intStr}.${pad2(cents)}`);
      add(`${sign}${grouped},${pad2(cents)}`);
      if (cents === 0) {
        add(`${sign}${intStr}`);
        add(`${sign}${grouped}`);
      }
    }
  } else if (type === "date" && typeof nv === "string") {
    const m = nv.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [, y, mo, d] = m;
      const dNum = parseInt(d, 10);
      const moNum = parseInt(mo, 10);
      add(`${d}.${mo}.${y}`);
      add(`${dNum}.${moNum}.${y}`);
      const month = GERMAN_MONTHS[moNum - 1];
      if (month) {
        add(`${dNum}. ${month} ${y}`);
        add(`${d}. ${month} ${y}`);
      }
    }
  } else if (nv != null && (typeof nv === "string" || typeof nv === "number")) {
    add(nv);
  }

  return [...forms];
}

// Searches a same-page label window around `idx`: ±5 lines (direct) plus the
// previous 10 lines (table-tolerant header lookback). Returns the matched
// label, or null. Never crosses the page boundary (operates on one page's lines).
function findLabelInWindow(lines: string[], idx: number, labels: string[]): string | null {
  const start = Math.max(0, idx - 10); // table-tolerant lookback (prev 10)
  const end = Math.min(lines.length - 1, idx + 5); // direct ±5 (downward)
  for (let i = start; i <= end; i++) {
    const norm = normalizeForMatch(lines[i]);
    for (const label of labels) {
      if (labelOccurs(norm, label)) return label;
    }
  }
  return null;
}

function firstEvidencePage(candidate: FieldEnvelope): number | null {
  const ev = candidate.evidence ?? [];
  for (const e of ev) {
    if (e && typeof e.page === "number" && Number.isFinite(e.page)) return e.page;
  }
  return null;
}

const NON_SCALAR_TYPES = new Set(["structured", "structured_array"]);

// Computes the grounding grade for a single field. Pure: (spec, candidate,
// ocrText) -> result. Returns an excluded (ungraded) result for derived,
// non-scalar, absent, or no-OCR cases.
export function groundingGrade(
  spec: GroundingSpec,
  candidate: FieldEnvelope | undefined,
  ocrText: string | undefined,
): FieldGroundingResult {
  const base = {
    field_id: spec.id,
    severity: spec.severity,
    matched_label: null as string | null,
    value_page: null as number | null,
    evidence_page_present: candidate ? firstEvidencePage(candidate) != null : false,
  };
  const excluded = (reason: FieldGroundingResult["excluded"]): FieldGroundingResult => ({
    ...base,
    graded: false,
    grade: null,
    excluded: reason,
  });

  // Derived/composite fields (e.g. unit_ref) are deferred to Task 4.3c.
  if (spec.derived) return excluded("derived_pending");
  // Only direct scalar fields are graded in v1.
  if (!spec.scalar || NON_SCALAR_TYPES.has(spec.type)) return excluded("non_scalar");
  // No asserted value -> nothing to ground.
  if (!candidate || candidate.absence_state !== "present") return excluded("absent");
  // No source text -> cannot verify (mirrors the conservative score path).
  if (!ocrText) return excluded("no_ocr");

  const forms = valueSurfaceForms(candidate, spec.type);
  if (forms.length === 0) {
    // Present but no usable value surface -> not grounded.
    return { ...base, graded: true, grade: 0, excluded: null };
  }

  const pages = parseOcrPages(ocrText);
  const evPage = firstEvidencePage(candidate);
  const evidencePagePresent = evPage != null;

  // "Value in OCR anywhere" (any page) — separates grade 1 from grade 0.
  const valueAnywhere = pages.some((p) =>
    p.lines.some((line) => {
      const norm = normalizeForMatch(line);
      return forms.some((f) => valueOccurs(norm, f));
    }),
  );

  // Scope: if evidence carries a page, restrict to it; else all pages. Windows
  // never cross pages either way.
  const scopePages = evidencePagePresent ? pages.filter((p) => p.page === evPage) : pages;

  let grade: GroundingGrade;
  let matchedLabel: string | null = null;
  let valuePage: number | null = null;

  // Find value occurrences within scope, then look for a field label nearby.
  let foundValue = false;
  for (const p of scopePages) {
    for (let i = 0; i < p.lines.length; i++) {
      const norm = normalizeForMatch(p.lines[i]);
      if (!forms.some((f) => valueOccurs(norm, f))) continue;
      foundValue = true;
      if (valuePage == null) valuePage = p.page;
      const label = findLabelInWindow(p.lines, i, spec.labels);
      if (label) {
        matchedLabel = label;
        valuePage = p.page;
        break;
      }
    }
    if (matchedLabel) break;
  }

  if (!foundValue) {
    grade = valueAnywhere ? 1 : 0;
  } else if (matchedLabel) {
    grade = 3;
  } else {
    grade = 2;
  }

  // evidence.page missing on a CRITICAL field caps the grade at 2.
  if (spec.severity === "critical" && !evidencePagePresent && grade > 2) {
    grade = 2;
    matchedLabel = null;
  }

  return { ...base, graded: true, grade, excluded: null, matched_label: matchedLabel, value_page: valuePage };
}

// Aggregates per-field grounding results into a fixture-level summary.
export function summarizeGrounding(fields: FieldGroundingResult[]): GroundingSummary {
  const graded = fields.filter((f) => f.graded && f.grade != null);
  const gradeSum = graded.reduce((acc, f) => acc + (f.grade ?? 0), 0);
  const grade_mean = graded.length === 0 ? 0 : gradeSum / graded.length;
  const grade3 = graded.filter((f) => f.grade === 3).length;
  return {
    fields,
    graded_count: graded.length,
    grade_mean,
    grade_rate: grade_mean / 3,
    grade3_rate: graded.length === 0 ? 0 : grade3 / graded.length,
    derived_pending: fields.filter((f) => f.excluded === "derived_pending").map((f) => f.field_id),
  };
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
  ocrText: string | undefined,
  // Task 4.3a: when provided, the grounding grade is computed per field and a
  // GroundingSummary is attached. Optional so the legacy four-metric callers
  // (and their tests) are byte-for-byte unchanged.
  groundingSpecs?: Record<string, GroundingSpec>
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

  // Evidence-grounding grade (Task 4.3a), computed separately from the four
  // value/absence metrics above and never collapsed into them.
  let grounding: GroundingSummary | undefined;
  if (groundingSpecs) {
    const groundingFields: FieldGroundingResult[] = [];
    for (const def of schemaFields) {
      const spec = groundingSpecs[def.id];
      if (!spec) continue; // no grounding spec for this field -> skip
      groundingFields.push(groundingGrade(spec, candidateFields[def.id], ocrText));
    }
    grounding = summarizeGrounding(groundingFields);
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
    ...(grounding ? { grounding } : {}),
  };
}

export const __TEST_ONLY__ = { severityWeight };
