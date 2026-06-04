// Derived-grounding tests (Task 4.3c-a) — scorer-only derived grade for
// single-source derived fields (unit_ref via floor_synonym_normalization).
// Pure, deterministic, DB-free, API-free: synthetic OCR + hand-built specs.
//
// Covers:
//   - floor_synonym_normalization as a pure closed-map function (the rule),
//   - the derived 0/1/3 grade (quote-grounds + rule-reproduces),
//   - composite derived fields (no single_source rule) stay derived_pending,
//   - the generated mietvertrag GROUNDING_SPECS carry the derived metadata.

import assert from "node:assert/strict";

import { floor_synonym_normalization, groundingGrade } from "../../../scripts/eval/metrics.ts";
import { GROUNDING_SPECS } from "../../../schemas/mietvertrag/generated/field_specs.ts";
import type { FieldEnvelope, GroundingSpec } from "../../../scripts/eval/types.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

// The single-source derived spec for unit_ref (mirrors the generated spec).
function unitRefSpec(over: Partial<GroundingSpec> = {}): GroundingSpec {
  return {
    id: "unit_ref",
    severity: "critical",
    type: "enum",
    scalar: true,
    derived: true,
    labels: ["Einheit"],
    derived_kind: "single_source",
    normalization_rule: "floor_synonym_normalization",
    ...over,
  };
}

// A present derived candidate: normalized_value `value`, cited `quote` on `page`.
function derived(value: unknown, quote: string, page: number | null): FieldEnvelope {
  return {
    raw_value: quote,
    normalized_value: value,
    absence_state: "present",
    evidence: [page != null ? { quote, page, bbox: null } : { quote }],
  };
}

// Wraps body text as single-page synthetic OCR (the fixture "--- Seite N ---"
// convention parsed by metrics.parseOcrPages).
function page1(body: string): string {
  return `--- Seite 1 ---\n${body}`;
}

// ══ floor_synonym_normalization: the pure closed-map rule ══════════════════
{
  eq(floor_synonym_normalization("Wohnung im 1. Obergeschoss"), "1.OG", "rule: '1. Obergeschoss' → 1.OG");
  eq(floor_synonym_normalization("Dachgeschoss"), "DG", "rule: Dachgeschoss → DG");
  eq(floor_synonym_normalization("1. Obergeschoss links"), "1.OG links", "rule: position suffix preserved");
  eq(floor_synonym_normalization("Erdgeschoss"), "EG", "rule: Erdgeschoss → EG");
  eq(floor_synonym_normalization("EG rechts"), "EG rechts", "rule: EG abbreviation + position");
  eq(floor_synonym_normalization("2. OG"), "2.OG", "rule: '2. OG' abbreviation → 2.OG");
  eq(floor_synonym_normalization("3.OG"), "3.OG", "rule: '3.OG' (no space) → 3.OG");
  eq(floor_synonym_normalization("zweite Etage"), "2.OG", "rule: ordinal word 'zweite Etage' → 2.OG");
  eq(floor_synonym_normalization("Kellergeschoss"), "UG", "rule: Kellergeschoss → UG");
  eq(floor_synonym_normalization("Untergeschoss"), "UG", "rule: Untergeschoss → UG");

  // Honest non-match: unknown/unmappable input → null, NEVER a guess.
  eq(floor_synonym_normalization("Hochparterre"), null, "rule: unmapped floor phrase → null");
  eq(floor_synonym_normalization("Geschoss 1"), null, "rule: bare table cell 'Geschoss 1' → null");
  eq(floor_synonym_normalization("Keller"), null, "rule: bare 'Keller' (not Kellergeschoss) → null");
  eq(floor_synonym_normalization("Mitte"), null, "rule: a position alone (no floor) → null");
  eq(floor_synonym_normalization(""), null, "rule: empty input → null");
}

// ══ derived grade: quote-grounds + rule-reproduces (0/1/3) ═════════════════

// ── Grade 3: 1. Obergeschoss grounds and reproduces 1.OG ───────────────────
{
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "Wohnung im 1. Obergeschoss", 1), page1("Wohnung im 1. Obergeschoss"));
  eq(r.grade, 3, "grade 3: '1. Obergeschoss' grounds AND reproduces 1.OG");
  eq(r.value_page, 1, "grade 3: value located on page 1");
  ok(r.graded && r.excluded === null, "grade 3: field is graded");
}

// ── Grade 3: Dachgeschoss → DG ─────────────────────────────────────────────
{
  const r = groundingGrade(unitRefSpec(), derived("DG", "Dachgeschoss", 1), page1("Lage: Dachgeschoss"));
  eq(r.grade, 3, "grade 3: Dachgeschoss grounds and reproduces DG");
}

// ── Grade 3: position suffix preserved ('1. Obergeschoss links' → 1.OG links) ─
{
  const r = groundingGrade(unitRefSpec(), derived("1.OG links", "1. Obergeschoss links", 1), page1("Einheit: 1. Obergeschoss links"));
  eq(r.grade, 3, "grade 3: '1. Obergeschoss links' grounds and reproduces 1.OG links");
}

// ── Grade 1: quote grounds but the rule does NOT reproduce the value ───────
{
  // 'Erdgeschoss' is in OCR (grounds) but the claimed value is 1.OG → rule
  // produces EG ≠ 1.OG → derivation unverified.
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "Erdgeschoss", 1), page1("Lage: Erdgeschoss"));
  eq(r.grade, 1, "grade 1: source present but rule (EG) does not reproduce claimed 1.OG");
}

// ── Grade 1: quote grounds but is an unmapped floor phrase (rule → null) ───
{
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "Hochparterre", 1), page1("Lage: Hochparterre"));
  eq(r.grade, 1, "grade 1: unmapped floor phrase grounds but yields no derivation");
}

// ── Grade 0: quote does not ground (cited source absent from OCR) ──────────
{
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "1. Obergeschoss", 1), page1("Kein Geschoss vermerkt"));
  eq(r.grade, 0, "grade 0: cited quote absent from OCR");
  eq(r.value_page, null, "grade 0: no value page when ungrounded");
}

// ── Same-page constraint: quote on the wrong page does not ground ──────────
{
  const ocr = "--- Seite 1 ---\nWohnung im 1. Obergeschoss\n--- Seite 2 ---\nFülltext";
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "Wohnung im 1. Obergeschoss", 2), ocr);
  eq(r.grade, 0, "same-page: quote on page 1 cited as page 2 does not ground");
}

// ══ Exclusions and absence handling ═══════════════════════════════════════

// ── Composite derived (no single_source rule) stays derived_pending ───────
{
  const composite = unitRefSpec({ id: "property_address", derived_kind: undefined, normalization_rule: undefined });
  const r = groundingGrade(composite, derived("1.OG", "Erdgeschoss", 1), page1("Erdgeschoss"));
  eq(r.graded, false, "composite derived: not graded");
  eq(r.excluded, "derived_pending", "composite derived: excluded as derived_pending");
}

// ── Absent candidate on a single-source derived field → excluded absent ────
{
  const absent: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const r = groundingGrade(unitRefSpec(), absent, page1("Erdgeschoss"));
  eq(r.excluded, "absent", "absent derived candidate: excluded as absent");
}

// ── No OCR → excluded no_ocr ───────────────────────────────────────────────
{
  const r = groundingGrade(unitRefSpec(), derived("1.OG", "Erdgeschoss", 1), undefined);
  eq(r.excluded, "no_ocr", "no OCR: excluded as no_ocr");
}

// ══ Generated GROUNDING_SPECS carry the derived metadata (non-hardcoded) ═══
{
  eq(GROUNDING_SPECS.unit_ref.derived, true, "specs: unit_ref is derived");
  eq(GROUNDING_SPECS.unit_ref.derived_kind, "single_source", "specs: unit_ref derived_kind is single_source");
  eq(
    GROUNDING_SPECS.unit_ref.normalization_rule,
    "floor_synonym_normalization",
    "specs: unit_ref normalization_rule is floor_synonym_normalization",
  );
}

console.log(`✓ derived-grounding.test.ts: ${assertions} assertions passed`);
