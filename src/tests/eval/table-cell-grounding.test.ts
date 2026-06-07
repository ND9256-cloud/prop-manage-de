// table_cell grounding tests (Task 4.3c-b-1a) — scorer-only validation of
// model-PROPOSED table-cell evidence for unit_ref. Pure, deterministic,
// DB-free, API-free: synthetic OCR + hand-built specs/candidates. No production
// extractor/envelope change, no re-extraction, no Sonnet.
//
// Integrity principle proven here: the LLM proposes a table cell; the scorer
// VALIDATES every part against OCR. The RAW token (cell_value_raw, e.g. "1") is
// grounded SEPARATELY from the normalized value ("1.OG"), which is reproduced by
// a deterministic rule — a model-declared clean value never passes on its own.
//
// Covers: valid bare floor cell → 3; wrong column → 0; ambiguous header → 0;
// duplicate rows w/ missing row anchor → ≤2; header-synonym gating (configured
// pass, hallucinated fail); anti-laundering (raw "1.OG" w/ OCR only "1") → 0;
// raw absent → 0; anchors on different pages → 0; the rule registry (enum-backed,
// deterministic, free-form rejected) and the per-field rule allow-list.

import assert from "node:assert/strict";

import { groundingGrade } from "../../../scripts/eval/metrics.ts";
import {
  applyDerivationRule,
  isDerivationRule,
  tableCellAllowed,
  tableCellRuleAllowed,
  type DerivationRule,
} from "../../../scripts/eval/derivation-rules.ts";
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

// unit_ref spec (the only table_cell field today). Derived/critical, mirroring
// the generated GROUNDING_SPECS; table_cell routing keys off evidence_type, so
// the derived metadata is not load-bearing here but kept realistic.
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

// Builds a present unit_ref candidate carrying ONE table_cell evidence entry.
// An empty/omitted rowQuote models a missing/weak row anchor.
function tableCell(opts: {
  normalized: unknown;
  page?: number | null;
  rowQuote?: string;
  colQuote: string;
  colCanonical?: string;
  rawValue: string;
  rule: string;
}): FieldEnvelope {
  return {
    raw_value: opts.rawValue,
    normalized_value: opts.normalized,
    absence_state: "present",
    evidence: [
      {
        evidence_type: "table_cell",
        page: opts.page === undefined ? 1 : opts.page,
        table_cell: {
          row_anchor: { quote: opts.rowQuote ?? "", anchor_type: "tenant_name" },
          column_anchor: {
            quote: opts.colQuote,
            ...(opts.colCanonical ? { canonical: opts.colCanonical } : {}),
          },
          cell_value_raw: opts.rawValue,
          derivation_rule: opts.rule as DerivationRule,
        },
      },
    ],
  } as FieldEnvelope;
}

// ══ Rule registry: enum-backed, deterministic, free-form rejected ══════════
{
  ok(isDerivationRule("literal"), "registry: literal is a rule");
  ok(isDerivationRule("geschoss_numeric_to_og"), "registry: geschoss_numeric_to_og is a rule");
  ok(isDerivationRule("floor_abbreviation_normalization"), "registry: floor_abbreviation_normalization is a rule");
  ok(!isDerivationRule("make_up_a_rule"), "registry: free-form string is NOT a rule");
  ok(!isDerivationRule(42), "registry: a non-string is NOT a rule");

  eq(applyDerivationRule("geschoss_numeric_to_og", "1"), "1.OG", "rule: '1' → 1.OG");
  eq(applyDerivationRule("geschoss_numeric_to_og", "2"), "2.OG", "rule: '2' → 2.OG");
  eq(applyDerivationRule("geschoss_numeric_to_og", "EG"), "EG", "rule: 'EG' → EG (passthrough)");
  eq(applyDerivationRule("geschoss_numeric_to_og", "DG"), "DG", "rule: 'DG' → DG (passthrough)");
  eq(applyDerivationRule("geschoss_numeric_to_og", "Zimmer"), null, "rule: non-floor token → null");
  eq(applyDerivationRule("literal", "1.OG"), "1.OG", "rule: literal returns the token verbatim");
  // floor_abbreviation_normalization reuses the 4.3c-a floor phrase→token map.
  eq(applyDerivationRule("floor_abbreviation_normalization", "1. Obergeschoss"), "1.OG", "rule: floor phrase → 1.OG (reused 4.3c-a)");

  // Per-field allow-list.
  ok(tableCellAllowed("unit_ref"), "allow-list: unit_ref permits table_cell");
  ok(!tableCellAllowed("kaltmiete"), "allow-list: kaltmiete does NOT permit table_cell");
  ok(tableCellRuleAllowed("unit_ref", "geschoss_numeric_to_og"), "allow-list: unit_ref table_cell allows geschoss_numeric_to_og");
  ok(tableCellRuleAllowed("unit_ref", "literal"), "allow-list: unit_ref table_cell allows literal");
  ok(!tableCellRuleAllowed("unit_ref", "floor_abbreviation_normalization"), "allow-list: floor_abbreviation_normalization is a DERIVED rule, not a table_cell rule");
}

// ══ Valid bare floor cell → grade 3 ════════════════════════════════════════
{
  const ocr = [
    "--- Seite 1 ---",
    "Aufstellung der Mieteinheiten",
    "Mieter Geschoss Grundmiete",
    "Everding Lena 1 650,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  const r = groundingGrade(unitRefSpec(), cand, ocr);
  eq(r.grade, 3, "valid: '1' under floor 'Geschoss', row-anchored, rule reproduces 1.OG → 3");
  eq(r.value_page, 1, "valid: value located on page 1");
  ok(r.graded && r.excluded === null, "valid: field is graded");
}

// ══ Wrong column ("1" under "Zimmer") → grade 0 ════════════════════════════
// The model even LIES that the column is floor (canonical:"floor"); the scorer
// rejects it because "Zimmer" is not a configured floor header.
{
  const ocr = ["--- Seite 1 ---", "Mieter Zimmer Grundmiete", "Mueller Anna 1 650,00"].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Mueller Anna",
    colQuote: "Zimmer", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 0, "wrong column: '1' under 'Zimmer' must NOT derive a floor → 0");
}

// ══ Ambiguous header ("1" under "Nr.") → grade 0 ═══════════════════════════
{
  const ocr = ["--- Seite 1 ---", "Nr. Mieter Grundmiete", "1 Mueller Anna 650,00"].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Mueller Anna",
    colQuote: "Nr.", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 0, "ambiguous header: '1' under 'Nr.' is not a floor column → 0");
}

// ══ Duplicate floor values, row anchor missing → ≤ 2 ═══════════════════════
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieter Geschoss Grundmiete",
    "Mueller Anna 1 650,00",
    "Schmidt Berta 1 700,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "", // missing/weak row anchor
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  const r = groundingGrade(unitRefSpec(), cand, ocr);
  ok(r.grade !== null && r.grade <= 2, "duplicate rows + missing row anchor → capped at ≤ 2 (row_anchor required for 3)");
  eq(r.grade, 2, "duplicate rows: value + floor column anchor, row missing → exactly 2");
}

// ══ Header synonym gating ══════════════════════════════════════════════════
// OCR has the abbreviation "Gesch."; the configured synonym map grounds the
// anchor "Geschoss". An uncovered header ("Stockwerk") is hallucinated → fail.
{
  const ocr = ["--- Seite 1 ---", "Mieter Gesch. Grundmiete", "Everding Lena 1 650,00"].join("\n");

  const configured = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), configured, ocr).grade, 3, "header synonym: anchor 'Geschoss' grounds on OCR 'Gesch.' (configured) → 3");

  const hallucinated = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Stockwerk", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), hallucinated, ocr).grade, 0, "hallucinated header: 'Stockwerk' not in OCR / not configured → 0");
}

// ══ Anti-laundering: cell_value_raw="1.OG" when OCR has only "1" → 0 ════════
// The RAW token must literally ground; a model-declared clean value cannot
// launder itself into a pass.
{
  const ocr = ["--- Seite 1 ---", "Mieter Geschoss Grundmiete", "Everding Lena 1 650,00"].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1.OG", rule: "literal",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 0, "anti-laundering: raw '1.OG' absent from OCR (only '1' present) → 0");
}

// ══ Raw absent → 0 ═════════════════════════════════════════════════════════
{
  const ocr = ["--- Seite 1 ---", "Mieter Geschoss Grundmiete", "Everding Lena 1 650,00"].join("\n");
  const cand = tableCell({
    normalized: "7.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "7", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 0, "raw absent: cell_value_raw '7' not in OCR → 0");
}

// ══ Anchors on different pages → 0 (same-page constraint) ══════════════════
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieter Geschoss Grundmiete",
    "--- Seite 2 ---",
    "Everding Lena 1 650,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 2, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 0, "different pages: column header on page 1, value on page 2 (cited) → 0");
}

// ══ Free-form / disallowed rule rejected at shape validation → 0 ═══════════
{
  const ocr = ["--- Seite 1 ---", "Mieter Geschoss Grundmiete", "Everding Lena 1 650,00"].join("\n");
  const freeform = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "totally_made_up_rule",
  });
  eq(groundingGrade(unitRefSpec(), freeform, ocr).grade, 0, "shape: free-form derivation_rule rejected → 0");

  // floor_abbreviation_normalization is a DERIVED rule, NOT allowed for table_cell.
  const wrongTypeRule = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "floor_abbreviation_normalization",
  });
  eq(groundingGrade(unitRefSpec(), wrongTypeRule, ocr).grade, 0, "shape: a derived-only rule on table_cell is not allowed → 0");
}

console.log(`✓ table-cell-grounding.test.ts: ${assertions} assertions passed`);
