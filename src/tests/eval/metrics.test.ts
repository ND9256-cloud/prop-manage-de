// Deterministic metrics tests for the eval harness.
// No LLM. Hand-built (gold, candidate) envelope pairs.

import assert from "node:assert/strict";

import {
  absenceStateCorrect,
  deepEqual,
  evidenceGrounded,
  exactMatch,
  normalizedMatch,
  scoreFixture,
  severityWeightedErrorRate,
} from "../../../scripts/eval/metrics.ts";
import type {
  ExtractionEnvelope,
  FieldEnvelope,
  FieldMetricResult,
  SchemaFieldDef,
} from "../../../scripts/eval/types.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

// ── exactMatch ──────────────────────────────────────────────────────────
{
  const gold: FieldEnvelope = { raw_value: "650,00 Euro", normalized_value: 65000, absence_state: "present" };
  const candHit: FieldEnvelope = { raw_value: "650,00 Euro", normalized_value: 65000, absence_state: "present" };
  const candMiss: FieldEnvelope = { raw_value: "650,01 Euro", normalized_value: 65001, absence_state: "present" };
  ok(exactMatch(gold, candHit), "exactMatch: equal raw_value strings");
  ok(!exactMatch(gold, candMiss), "exactMatch: different raw_value");
}
{
  // Both null raw_value counts as a match (gold absent, candidate absent).
  const gold: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const cand: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  ok(exactMatch(gold, cand), "exactMatch: both null");
}
{
  // Gold null, candidate populated -> not a match.
  const gold: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const cand: FieldEnvelope = { raw_value: "irrelevant", normalized_value: 1, absence_state: "present" };
  ok(!exactMatch(gold, cand), "exactMatch: gold null vs candidate populated");
}
{
  // Missing candidate field: matches iff gold raw_value is null.
  const goldNull: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const goldPop: FieldEnvelope = { raw_value: "v", normalized_value: 1, absence_state: "present" };
  ok(exactMatch(goldNull, undefined), "exactMatch: gold null, candidate undefined => match");
  ok(!exactMatch(goldPop, undefined), "exactMatch: gold populated, candidate undefined => miss");
}

// ── deepEqual / normalizedMatch ─────────────────────────────────────────
{
  // Key order should not matter.
  const a = { amount: 65000, currency: "EUR" };
  const b = { currency: "EUR", amount: 65000 };
  ok(deepEqual(a, b), "deepEqual: insensitive to key order");
}
{
  // Numbers vs strings: NOT equal. Tests "normalized hit/miss (incl.
  // numeric-vs-text)" from the task brief.
  ok(!deepEqual(65000, "65000"), "deepEqual: number vs string => not equal");
}
{
  // Nested objects.
  const a = { name: "Lena", legal_form: null, is_legal_entity: false };
  const b = { is_legal_entity: false, legal_form: null, name: "Lena" };
  ok(deepEqual(a, b), "deepEqual: nested objects, sorted keys");
}
{
  // Arrays positional.
  ok(deepEqual([1, 2, 3], [1, 2, 3]), "deepEqual: arrays equal");
  ok(!deepEqual([1, 2, 3], [3, 2, 1]), "deepEqual: arrays positional");
}
{
  const gold: FieldEnvelope = {
    raw_value: "650 Euro",
    normalized_value: { amount: 65000, currency: "EUR" },
    absence_state: "present",
  };
  const hit: FieldEnvelope = {
    raw_value: "ignored",
    normalized_value: { currency: "EUR", amount: 65000 }, // reordered
    absence_state: "present",
  };
  const miss: FieldEnvelope = {
    raw_value: "ignored",
    normalized_value: { amount: "65000", currency: "EUR" }, // numeric vs text
    absence_state: "present",
  };
  ok(normalizedMatch(gold, hit), "normalizedMatch: reordered keys match");
  ok(!normalizedMatch(gold, miss), "normalizedMatch: numeric vs string miss");
}

// ── evidenceGrounded ────────────────────────────────────────────────────
{
  const ocr = "Die Grundmiete beträgt monatlich 650,00 Euro\nNebenkostenvorauszahlung 180,00 Euro";
  const grounded: FieldEnvelope = {
    raw_value: "650,00 Euro",
    normalized_value: { amount: 65000, currency: "EUR" },
    absence_state: "present",
    evidence: [{ quote: "monatlich 650,00 Euro", page: 1, bbox: null }],
  };
  const hallucinated: FieldEnvelope = {
    raw_value: "999,00 Euro",
    normalized_value: { amount: 99900, currency: "EUR" },
    absence_state: "present",
    evidence: [{ quote: "monatlich 999,00 Euro", page: 1, bbox: null }],
  };
  ok(evidenceGrounded(grounded, grounded, ocr), "evidenceGrounded: quote in source");
  ok(!evidenceGrounded(grounded, hallucinated, ocr), "evidenceGrounded: hallucinated quote");
}
{
  // Whitespace normalization: quote uses newline; source has the same words.
  const ocr = "Vermieter: Denn & Denn Verwaltungs GbR\nVertreten durch ...";
  const cand: FieldEnvelope = {
    raw_value: "Denn & Denn Verwaltungs GbR",
    normalized_value: {},
    absence_state: "present",
    evidence: [{ quote: "Denn & Denn\nVerwaltungs GbR", page: 1, bbox: null }],
  };
  ok(evidenceGrounded(cand, cand, ocr), "evidenceGrounded: whitespace normalized");
}
{
  // Candidate present with empty evidence array -> not grounded.
  const cand: FieldEnvelope = {
    raw_value: "x",
    normalized_value: "x",
    absence_state: "present",
    evidence: [],
  };
  ok(!evidenceGrounded(cand, cand, "x"), "evidenceGrounded: empty evidence array fails");
}
{
  // Absent gold + absent candidate => vacuously grounded.
  const gold: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const cand: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  ok(evidenceGrounded(gold, cand, undefined), "evidenceGrounded: both absent => true");
}
{
  // Candidate present but OCR text missing => not grounded (conservative).
  const cand: FieldEnvelope = {
    raw_value: "x",
    normalized_value: "x",
    absence_state: "present",
    evidence: [{ quote: "x", page: 1, bbox: null }],
  };
  ok(!evidenceGrounded(cand, cand, undefined), "evidenceGrounded: no OCR text -> false");
}

// ── absenceStateCorrect ─────────────────────────────────────────────────
{
  const goldPresent: FieldEnvelope = { raw_value: "x", normalized_value: "x", absence_state: "present" };
  const candPresent: FieldEnvelope = { raw_value: "y", normalized_value: "y", absence_state: "present" };
  ok(absenceStateCorrect(goldPresent, candPresent), "absenceStateCorrect: both present");

  const goldAbsent: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const candAbsent: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  ok(absenceStateCorrect(goldAbsent, candAbsent), "absenceStateCorrect: both absent (matching flavor)");

  // Different absence flavors still OK as long as both are non-present
  // AND candidate has no populated value.
  const candNotApplicable: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "not_applicable" };
  ok(absenceStateCorrect(goldAbsent, candNotApplicable), "absenceStateCorrect: absent vs not_applicable still OK");

  // Hallucinated value with absence_state mismatched -> wrong.
  const hallucinated: FieldEnvelope = { raw_value: "value", normalized_value: 1, absence_state: "present" };
  ok(!absenceStateCorrect(goldAbsent, hallucinated), "absenceStateCorrect: gold absent, candidate present (hallucination)");

  // Candidate claims absent but populated raw_value anyway -> still wrong.
  const inconsistent: FieldEnvelope = { raw_value: "leaked", normalized_value: 1, absence_state: "absent" };
  ok(!absenceStateCorrect(goldAbsent, inconsistent), "absenceStateCorrect: candidate claims absent but has value");

  ok(!absenceStateCorrect(goldPresent, candAbsent), "absenceStateCorrect: gold present, candidate absent");
}

// ── severityWeightedErrorRate ───────────────────────────────────────────
{
  const fields: FieldMetricResult[] = [
    fieldErr("critical", true),
    fieldErr("critical", false),
    fieldErr("nice_to_have", true),
  ];
  // weights: 5 + 5 + 1 = 11; errors: 5 + 0 + 1 = 6 -> 6/11
  const rate = severityWeightedErrorRate(fields);
  eq(Math.round(rate * 1000) / 1000, Math.round((6 / 11) * 1000) / 1000, "severity-weighted rate");
}
{
  // All correct => 0.
  const fields: FieldMetricResult[] = [fieldErr("critical", false), fieldErr("important", false)];
  eq(severityWeightedErrorRate(fields), 0, "severity-weighted: zero errors");
}
{
  // All wrong => 1.
  const fields: FieldMetricResult[] = [fieldErr("critical", true), fieldErr("important", true)];
  eq(severityWeightedErrorRate(fields), 1, "severity-weighted: all errors");
}

// ── scoreFixture (gold-vs-gold smoke) ───────────────────────────────────
{
  const schemaFields: SchemaFieldDef[] = [
    { id: "kaltmiete", severity: "critical" },
    { id: "kaution", severity: "important" },
  ];
  const gold: ExtractionEnvelope = {
    doc_type: "mietvertrag",
    fields: {
      kaltmiete: {
        raw_value: "650,00 Euro",
        normalized_value: { amount: 65000, currency: "EUR" },
        absence_state: "present",
        evidence: [{ quote: "monatlich 650,00 Euro", page: 1, bbox: null }],
      },
      kaution: {
        raw_value: null,
        normalized_value: null,
        absence_state: "absent",
        evidence: [],
      },
    },
  };
  // gold-vs-gold with OCR text containing the quote -> perfect score.
  const ocr = "Grundmiete monatlich 650,00 Euro";
  const summary = scoreFixture("smoke", "mietvertrag", gold, gold, schemaFields, ocr);
  eq(summary.exact_match_rate, 1, "scoreFixture: gold self-score exact_match_rate");
  eq(summary.normalized_match_rate, 1, "scoreFixture: gold self-score normalized_match_rate");
  eq(summary.evidence_grounded_rate, 1, "scoreFixture: gold self-score evidence_grounded_rate");
  eq(summary.absence_state_correct_rate, 1, "scoreFixture: gold self-score absence_state_correct_rate");
  eq(summary.severity_weighted_error_rate, 0, "scoreFixture: gold self-score zero error");
}
{
  // Candidate hallucinates a kaution value: critical-field-ish error on
  // an important field. exact_match miss, normalized miss, absence miss.
  const schemaFields: SchemaFieldDef[] = [
    { id: "kaution", severity: "important" },
  ];
  const gold: ExtractionEnvelope = {
    doc_type: "mietvertrag",
    fields: {
      kaution: { raw_value: null, normalized_value: null, absence_state: "absent", evidence: [] },
    },
  };
  const candidate: ExtractionEnvelope = {
    doc_type: "mietvertrag",
    fields: {
      kaution: {
        raw_value: "1.950,00 Euro",
        normalized_value: { amount: 195000, currency: "EUR" },
        absence_state: "present",
        evidence: [{ quote: "Kaution 1.950,00 Euro", page: 1, bbox: null }],
      },
    },
  };
  const summary = scoreFixture("halluc", "mietvertrag", gold, candidate, schemaFields, "no kaution in source");
  eq(summary.severity_weighted_error_rate, 1, "scoreFixture: hallucinated kaution -> full error");
  ok(!summary.fields[0].absence_state_correct, "scoreFixture: hallucinated absence wrong");
  ok(!summary.fields[0].exact_match, "scoreFixture: hallucinated exact wrong");
}

function fieldErr(severity: "critical" | "important" | "nice_to_have", hasErr: boolean): FieldMetricResult {
  return {
    field_id: "x",
    severity,
    gold_absence_state: "present",
    candidate_absence_state: "present",
    exact_match: !hasErr,
    normalized_match: !hasErr,
    evidence_grounded: !hasErr,
    absence_state_correct: !hasErr,
    has_error: hasErr,
  };
}

console.log(`✓ metrics.test.ts: ${assertions} assertions passed`);
