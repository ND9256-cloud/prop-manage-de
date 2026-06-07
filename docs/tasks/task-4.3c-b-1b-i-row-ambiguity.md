# Task 4.3c-b-1b-i — table-cell validator: row_anchor conditional on row ambiguity (scorer-only)

Context: docs/tasks/task-4.3c-plan.md + task-4.3c-b-1a-table-cell.md. 1a required
row_anchor for grade 3 in ALL table_cell cases. But Lena's floor "1" lives in a
single-unit DESCRIPTION table (header "Wohnfläche ca. Geschoss Zimmer ..." then ONE
value row "100,00 m² 1 3,5 1 1 0 1 – Mitte 0"), with NO tenant in the row — so a
mandatory tenant row_anchor wrongly caps an unambiguous single-unit floor at 2.
Refine: row_anchor is required for grade 3 ONLY when the table block has multiple
candidate rows for the column (ambiguity to resolve). Single-candidate-row blocks
reach grade 3 on value + licensed floor column + locality alone.

SCORER-ONLY — NO production change, NO re-extraction, NO Sonnet. Lena's CANDIDATE
unit_ref STAYS grade 0 (still direct_quote; she moves in 1b-ii). This task
builds+proves the refined rule on SYNTHETIC fixtures mirroring her table shape.

Principle: row_anchor exists to disambiguate WHICH ROW supplied the cell. With
only one candidate row there is nothing to disambiguate, so row_anchor adds no
defensibility and must not be required for grade 3. With multiple rows sharing the
column, row_anchor stays required (unchanged from 1a).

## Validator change (scripts/eval/metrics.ts, gradeTableCell)
- After grounding the column header + cell_value_raw, count CANDIDATE DATA ROWS in
  the table block (lines in the locality window, below the header, carrying a value
  in that column). Define block/data-row pragmatically for the linearized floor case.
- single-row block (exactly 1 candidate data row): row_anchor NOT required for 3.
  Grade 3 = column header grounds + cell_value_raw grounds under the licensed floor
  column + locality holds + rule reproduces value. (row_anchor if present must still
  ground; absent is fine here.)
- multi-row block (>1 candidate data row): row_anchor REQUIRED for 3 (unchanged from
  1a). Missing/weak row_anchor → cap ≤2.
- Column-position precision: cell_value_raw must be bound to the TARGET (licensed
  floor) column, not merely present elsewhere in the row. Lena's row
  "100,00 m² 1 3,5 1 1 0 1 ..." has multiple "1"s under different columns — only the
  one under "Geschoss" counts. (1a column licensing + locality should constrain this;
  the fixture must test it.)

## Synthetic fixtures (extend src/tests/eval/table-cell-grounding.test.ts)
- Lena-shape single-unit description table: header "Wohnfläche ca. Geschoss Zimmer Küche ..."
  + value "100,00 m² 1 3,5 1 1 0 1 – Mitte 0"; table_cell column_anchor "Geschoss"
  (canonical floor), cell_value_raw "1", rule geschoss_numeric_to_og, NO row_anchor →
  grade 3 (single-row, unambiguous).
- Column-position trap: a declaration pointing at the wrong "1" (e.g. under Küche/Bad)
  must NOT pass as the floor; only the Geschoss-column "1" grades 3.
- Multi-row rent-roll, same floor "1" in two tenant rows, NO row_anchor → ≤2.
- Multi-row rent-roll, same floor, WITH correct row_anchor → 3.
- Header-above-wrapped-value: header line then value on the next line → grade 3 (single-row).

## Existing fixtures
Review 1a table-cell fixtures. The ONLY ones whose expected grade changes are
single-row + no-row_anchor cases (now correctly 3, were 2) — update those
deliberately. Multi-row cases and the duplicate-row→≤2 case are UNCHANGED. Do NOT
weaken any anti-laundering / wrong-column / ambiguity assertion.

## Steps
1. Refine gradeTableCell: candidate-row counting; row_anchor required for 3 only in multi-row blocks; single-row reaches 3 without it; keep column-position binding.
2. Add the synthetic fixtures above; update only single-row-no-anchor expected grades among existing fixtures.
3. Re-score Lena (eval/candidates/lena2): unit_ref STILL grade 0 — confirm UNCHANGED (her candidate is direct_quote; 1b-ii moves her).
4. Update ARCHITECTURE_STATE.md (eval section): row_anchor conditional on row ambiguity; single-row blocks reach 3 without row_anchor. (Good hygiene; note this task touches only scripts/eval + tests, not a trigger path.)

## Out of scope
- NO production extractor / envelope_validator change; NO re-extraction; NO Sonnet (all 1b-ii).
- NO new evidence types, composites, money-table, bbox.
- Do not change scalar/identity/derived grade logic or normalized_match.
- Do not weaken 1a's anti-laundering, wrong-column, or multi-row ambiguity assertions.
- Do not make table_cell/derived hard-fail the gold-grounding invariant (report-only).

## Definition of done
- gradeTableCell: row_anchor required for 3 only in multi-row blocks; single-row reaches 3 without it; column-position binding preserved.
- New fixtures green: Lena-shape single-row → 3; column-position trap respected; multi-row no-anchor → ≤2; multi-row with anchor → 3; wrapped-value → 3.
- Existing 1a assertions unchanged except single-row-no-anchor grades (2→3, deliberate); anti-laundering/wrong-column/ambiguity intact.
- Lena re-score: unit_ref UNCHANGED grade 0 (1b-ii's target).
- All eval tests green; gold-grounding invariant green (report-only); tsc + lint clean; ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3c-b-1b-i-row-ambiguity; PR; CI green.
