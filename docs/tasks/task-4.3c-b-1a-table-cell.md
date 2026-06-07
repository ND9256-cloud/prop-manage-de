# Task 4.3c-b-1a — table_cell grounding for unit_ref (scorer + rule registry + synthetic fixtures)

Context: docs/tasks/task-4.3c-plan.md (4.3c-b) + the ChatGPT critique. Build and
PROVE the table-cell evidence validator on SYNTHETIC gold fixtures, scorer-side
only. NO production extractor change, NO production envelope_validator change, NO
re-extraction, NO Sonnet, NO composites. table_cell lives in the EVAL types as
the proving ground; promoting it to the production envelope + teaching the
extractor to emit it + re-extracting Lena is the SEPARATE next task (4.3c-b-1b).
Lena's real unit_ref STAYS grade 0 after this task — expected.

Integrity principle (non-negotiable): the LLM PROPOSES table-cell evidence; the
scorer VALIDATES every part against OCR; only validated evidence counts.
- Store cell_value_raw (OCR token, e.g. "1") SEPARATELY from the field's
  normalized value ("1.OG"). Scorer grounds the RAW token and reproduces the
  normalized value via a deterministic rule — never trusts a model-declared
  clean value. Anti-laundering: cell_value_raw="1.OG" must NOT pass unless "1.OG"
  literally grounds in OCR.
- For unit_ref, row_anchor is REQUIRED for grade 3 (bare "1" under a floor column
  is ambiguous across rows without it).

## Eval evidence type (scripts/eval/types.ts)
Discriminated union on OPTIONAL evidence_type (default "direct_quote" when absent
→ backward compatible; existing {quote,page,bbox} unchanged).
- direct_quote: { evidence_type?:"direct_quote", quote, page, bbox? }
- table_cell:   { evidence_type:"table_cell", page, table_cell: {
    row_anchor:{quote,anchor_type,canonical?}, column_anchor:{quote,canonical?},
    cell_value_raw:string, derivation_rule:DerivationRule } }
Do NOT store a model-declared normalized cell value; if present, scorer ignores+recomputes.

## Derivation rule registry (scripts/eval/derivation-rules.ts; shared by scorer)
Typed enum + deterministic apply(); no impl => not allowed. First set ONLY:
literal; floor_abbreviation_normalization (reuse 4.3c-a floor phrase→token);
geschoss_numeric_to_og ("1"→"1.OG","2"→"2.OG","EG"→"EG","DG"→"DG", LICENSED only
when column is floor-like). Free-form rule strings rejected at shape validation.
Reuse the 4.3c-a floor logic now wired through schemas/.../schema.yaml + field_specs.

## Field allow-list
Per-field allowed evidence types + rules. unit_ref: types {direct_quote,
table_cell, derived}; table_cell rules {literal, geschoss_numeric_to_og}; derived
rule floor_abbreviation_normalization. Others unchanged.

## Scorer table_cell validation (scripts/eval/metrics.ts) — route on evidence_type
1. Shape: type allowed; row+column+cell_value_raw+derivation_rule present; rule allowed; page present (missing on critical → cap 2).
2. Ground each on cited page (normalized whitespace/hyphenation): row_anchor.quote, column_anchor.quote (CONFIGURED header-synonym map only, e.g. "Gesch."→"Geschoss"; uncovered header not in OCR = hallucinated = fail), cell_value_raw.
3. Locality (same page only): row_anchor & cell_value_raw within ±3 OCR lines; column_anchor within previous 10 lines of value; total span ≤15 lines.
4. Column licenses rule: geschoss_numeric_to_og only if column_anchor.canonical=="floor" (or configured floor-header synonym). "1" under "Zimmer"/"Nr." must NOT derive floor → fail.
5. Ambiguity: another row in same block, same cell_value_raw + column, row_anchor not disambiguating → cap ≤2. row_anchor REQUIRED for grade 3.
6. Derivation: rule(cell_value_raw) === field.normalized_value.
Grades: 3 = (row+column+raw ground)+locality+column-licenses-rule+rule-reproduces+no-ambiguity, subtype "table_cell_grounded"; 2 = value+one anchor, cohesion incomplete; 1 = raw on page, no row/column relationship; 0 = raw absent / different pages / rule fails / wrong-column / hallucinated anchor.

## Synthetic fixtures — new test src/tests/eval/table-cell-grounding.test.ts (DB-free/API-free)
- Valid bare floor cell ("Everding Lena | 1 | 650,00" under "Mieter Geschoss Grundmiete", raw "1", geschoss_numeric_to_og) → 3.
- Wrong column ("1" under "Zimmer") → 0.
- Ambiguous header ("1" under "Nr.") → 0.
- Duplicate floor values across rows, row_anchor weak/missing → ≤2.
- Header synonym: OCR "Gesch.", anchor "Geschoss" → pass only if synonym configured; uncovered hallucinated header → fail.
- Anti-laundering: cell_value_raw="1.OG" when OCR has only "1" → 0.
- Raw absent → 0; anchors on different page → 0.
Wire into eval-tests CI.

## Steps
1. Evidence union + table_cell in types.ts (backward-compatible default).
2. derivation-rules.ts registry (enum, deterministic, reuse 4.3c-a floor norm).
3. Field allow-list.
4. table_cell validation in metrics.ts per the standard above.
5. table-cell-grounding.test.ts with the fixtures; wire into CI.
6. Re-score Lena (eval/candidates/lena2): unit_ref STILL grade 0 — confirm UNCHANGED.
7. ARCHITECTURE_STATE.md (eval section): table_cell type (eval), rule registry, scorer-validates-not-trusts, cell_value_raw separation, row_anchor-required-for-3. REQUIRED — ci.yml trigger path.

## Out of scope
- NO production extractor / envelope_validator change; NO re-extraction; NO Sonnet (all 1b).
- NO composite/address; NO money-table; NO bbox.
- Do not change scalar/identity/4.3c-a derived logic or normalized_match.
- Do not make table_cell/derived hard-fail the gold-grounding invariant (report-only).

## Definition of done
- Evidence union backward-compatible (existing eval tests unchanged-green).
- Rule registry enum-backed/deterministic; free-form rule rejected.
- table_cell scorer: cell_value_raw separation, column-licenses-rule, row_anchor-required-for-3, ambiguity downgrade.
- New test green + in CI: valid→3, wrong-column→0, ambiguous-header→0, duplicate→≤2, header-synonym gating, anti-laundering→0.
- Lena re-score: unit_ref UNCHANGED grade 0 (1b's target, documented).
- All existing eval tests green; gold-grounding invariant green (report-only); tsc+lint clean; ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3c-b-1a-table-cell; PR; CI green.
