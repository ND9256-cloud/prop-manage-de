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

// ══ Row ambiguity refinement (Task 4.3c-b-1b-i) ════════════════════════════
// row_anchor is required for grade 3 ONLY when the table block has >1 candidate
// data row for the column. A single-candidate-row block (e.g. Lena's single-unit
// DESCRIPTION table) reaches 3 on value + licensed floor column + locality alone.

// ── Lena-shape single-unit description table, NO row anchor → 3 ─────────────
// Header "Wohnfläche ca. Geschoss Zimmer …" then ONE value row that linearizes
// the whole unit onto a single line (multiple "1"s under different columns). That
// is ONE candidate data row, so the unambiguous Geschoss "1" reaches 3 without a
// tenant row anchor.
{
  const ocr = [
    "--- Seite 1 ---",
    "Beschreibung der Wohnung",
    "Wohnfläche ca. Geschoss Zimmer Küche Bad Balkon WC Lage",
    "100,00 m² 1 3,5 1 1 0 1 – Mitte 0",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "", // NO row anchor — single-unit table
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  const r = groundingGrade(unitRefSpec(), cand, ocr);
  eq(r.grade, 3, "single-row description table: floor '1' under 'Geschoss', no row anchor needed → 3");
  eq(r.value_page, 1, "single-row description table: value on page 1");
}

// ── Column-position trap on the SAME single-unit row → 0 ────────────────────
// The row repeats "1" under Küche/Bad/WC. Declaring a NON-floor column (Küche)
// with the floor rule must NOT pass — only the Geschoss-column "1" is a floor.
{
  const ocr = [
    "--- Seite 1 ---",
    "Beschreibung der Wohnung",
    "Wohnfläche ca. Geschoss Zimmer Küche Bad Balkon WC Lage",
    "100,00 m² 1 3,5 1 1 0 1 – Mitte 0",
  ].join("\n");
  const trap = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "",
    colQuote: "Küche", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), trap, ocr).grade, 0, "column-position trap: '1' under 'Küche' (not a floor column) → 0");

  // And the Geschoss declaration on the very same OCR still grades 3 — proving it
  // is the column anchor, not mere presence of '1', that licenses the floor.
  const floorDecl = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "",
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), floorDecl, ocr).grade, 3, "column-position: only the 'Geschoss'-column '1' grades 3");
}

// ── Multi-row rent-roll, same floor "1" in two tenant rows, NO row anchor → ≤2
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieter Geschoss Grundmiete",
    "Everding Lena 1 650,00",
    "Schmidt Berta 1 700,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "", // missing row anchor in a multi-row block
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  const r = groundingGrade(unitRefSpec(), cand, ocr);
  ok(r.grade !== null && r.grade <= 2, "multi-row + no row anchor → capped ≤ 2 (row_anchor required for 3)");
  eq(r.grade, 2, "multi-row + no row anchor → exactly 2");
}

// ── Multi-row rent-roll, same floor, WITH correct row anchor → 3 ────────────
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieter Geschoss Grundmiete",
    "Everding Lena 1 650,00",
    "Schmidt Berta 1 700,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Everding Lena", // disambiguating row anchor
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 3, "multi-row + correct row anchor pins Everding's row → 3");
}

// ── Header-above-wrapped-value: OCR wraps the row so the floor lands on its own
// line below the header. One candidate data row, no row anchor → 3.
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieter Geschoss Miete",
    "Everding Lena",
    "1",
    "650,00",
  ].join("\n");
  const cand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "", // no row anchor on a single wrapped row
    colQuote: "Geschoss", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 3, "wrapped value: floor '1' on the line below 'Geschoss', single row → 3");
}

// ══ Held-out table shapes (Task 4.3c-b-ii-B, anti-overfit to Lena) ══════════
// §3 of the ii-B brief: prove the EMISSION guidance generalizes, not just on
// Lena's exact "Geschoss"/numeric shape. These use DISTINCT headers ("Etage"),
// a distinct floor token (EG passthrough), distinct tenant names, and distinct
// ambiguous columns ("Pos."/"Anzahl") from Lena and from every case above. As
// in §3, the candidate table_cell evidence is hand-authored (no live Sonnet);
// this confirms the scorer behaves on the three target shapes.

// ── (1) Multi-row rent-roll (Mieter | Etage | Kaltmiete, 2 tenants):
// row_anchor PRESENT and disambiguating → 3; the SAME table with NO row anchor
// is ambiguous → ≤2 (so the anchor is what earns 3, not the floor token alone).
{
  const ocr = [
    "--- Seite 1 ---",
    "Mieterliste Objekt Hauptstraße 5",
    "Mieter Etage Kaltmiete",
    "Koch Markus 2 720,00",
    "Becker Sophie 2 810,00",
  ].join("\n");
  const anchored = tableCell({
    normalized: "2.OG", page: 1, rowQuote: "Koch Markus",
    colQuote: "Etage", colCanonical: "floor", rawValue: "2", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), anchored, ocr).grade, 3, "held-out multi-row: '2' under 'Etage', row-anchored to Koch → 3");

  const noAnchor = tableCell({
    normalized: "2.OG", page: 1, rowQuote: "", // multiple tenant rows, no disambiguation
    colQuote: "Etage", colCanonical: "floor", rawValue: "2", rule: "geschoss_numeric_to_og",
  });
  const r = groundingGrade(unitRefSpec(), noAnchor, ocr);
  ok(r.grade !== null && r.grade <= 2, "held-out multi-row: row_anchor REQUIRED → no anchor caps ≤2");
}

// ── (2) Single-row description table (distinct from Lena: "Etage" header, EG
// passthrough, no tenant in the row): row_anchor OMITTED → 3.
{
  const ocr = [
    "--- Seite 1 ---",
    "Objektbeschreibung",
    "Wohnfläche Etage Zimmer Bad",
    "62,50 m² EG 2 1",
  ].join("\n");
  const cand = tableCell({
    normalized: "EG", page: 1, rowQuote: "", // single-unit description table → omit row_anchor
    colQuote: "Etage", colCanonical: "floor", rawValue: "EG", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), cand, ocr).grade, 3, "held-out single-row: 'EG' under 'Etage', no row anchor → 3");
}

// ── (3) Ambiguous numeric column ("1" under "Pos." and under "Anzahl"): even
// row-anchored and even when the model LIES that the column is floor, an
// ambiguous column must NOT derive a floor → NOT grade 3 (0).
{
  const posOcr = ["--- Seite 1 ---", "Pos. Mieter Kaltmiete", "1 Wagner Tom 650,00"].join("\n");
  const posCand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Wagner Tom",
    colQuote: "Pos.", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), posCand, posOcr).grade, 0, "held-out ambiguous: '1' under 'Pos.' is not a floor column → not 3 (0)");

  const anzOcr = ["--- Seite 1 ---", "Wohnung Anzahl Räume Miete", "Top 4 1 3 690,00"].join("\n");
  const anzCand = tableCell({
    normalized: "1.OG", page: 1, rowQuote: "Top 4",
    colQuote: "Anzahl", colCanonical: "floor", rawValue: "1", rule: "geschoss_numeric_to_og",
  });
  eq(groundingGrade(unitRefSpec(), anzCand, anzOcr).grade, 0, "held-out ambiguous: '1' under 'Anzahl' is not a floor column → not 3 (0)");
}

console.log(`✓ table-cell-grounding.test.ts: ${assertions} assertions passed`);
