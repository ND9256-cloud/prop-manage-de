# Task 4.3c-b-1b-i-2 — table_cell ambiguity counts only rows under the licensed floor column (scorer-only)

Context: ARCHITECTURE_STATE.md 4.3c-b-1b-i + the ii-B Lena re-extraction finding.
1b-i made row_anchor required for grade 3 only in MULTI-row blocks, counting
candidate data rows in `gradeTableCellOnPage` (scripts/eval/metrics.ts) as
`dataValueLines = valueLines.filter(vi => vi >= headerMin)` — i.e. ANY value line
after the first header carrying the raw token. That OVER-counts: on Lena's page 2
the floor row ("100,00 m² 1 3,5 ..." under a "Geschoss" header) AND an unrelated
garage row ("3 4 1 1 – Garage", >10 lines later, no floor header) both carry a
standalone "1", so the block reads as multi-row → row_anchor required → her
single-unit floor (correctly emitted with NO row_anchor) caps at grade 2 instead
of 3. Refine: a competing floor "row" counts ONLY when its raw token is
locality-associated with a LICENSED FLOOR column header.

SCORER-ONLY: scripts/eval/metrics.ts + the table-cell test. NO production change,
NO re-extraction, NO Sonnet. Must NOT weaken genuine multi-row protection.

## The fix (principle — read the current gradeTableCellOnPage and reuse its column-locality check)
A candidate floor row = a value line carrying the raw token that ALSO has a
licensed floor-column header within the locality window (the SAME "column header
within the previous ~10 lines" rule already used for grade-3 column grounding).
Compute `multiRow` from THOSE rows only — not from bare token occurrences anywhere
on the page.
- Lena page 2: floor row (Geschoss header within 10 lines) counts = 1; garage row
  (no floor header within 10 lines) does NOT count → single-row → row_anchor not
  required → grade 3.
- Genuine rent-roll with two tenant rows under ONE Geschoss header: both within
  the header's locality → 2 candidate rows → multi-row → row_anchor still REQUIRED
  (unchanged).
Implement by aligning the candidate-row count with the existing per-value-line
column-locality logic (`columnOk`), replacing the `vi >= headerMin` filter.

## Fixtures (extend src/tests/eval/table-cell-grounding.test.ts)
- Lena-shape two-value-row page: "Wohnfläche ca. Geschoss Zimmer ..." header + floor
  row "100,00 m² 1 3,5 1 1 0 1 – Mitte 0", then (>10 lines later, or under no floor
  header) a garage row "3 4 1 1 – Garage"; table_cell column "Geschoss", raw "1",
  geschoss_numeric_to_og, NO row_anchor → grade 3 (garage row must NOT make it multi-row).
- Genuine multi-floor-row rent-roll: "Mieter Geschoss Miete" + two tenant rows each
  with a floor under Geschoss, NO row_anchor → ≤2 (protection intact); WITH a
  disambiguating row_anchor → 3.
- All existing table-cell assertions stay green (single-row, wrong-column, anti-laundering, ambiguity).

## Re-score Lena (confirm)
With the refined scorer, re-score eval/candidates/lena-iiB: unit_ref should move
2 → 3 (garage row no longer counts as a competing floor row). Report the grade
honestly; if still 2 for a different reason, that's a finding, not a force.

## Out of scope
- No production / envelope_validator change, no re-extraction, no Sonnet.
- Do not change locality window sizes, the column-licensing rule, anti-laundering, or other grade paths.
- Do not loosen genuine multi-row protection (two real floor rows under one header still need row_anchor for 3).

## Definition of done
- Ambiguity count uses only rows with a licensed floor header in locality.
- Lena-shape (floor row + unrelated garage row) → grade 3 without row_anchor; genuine two-floor-row rent-roll → ≤2 without anchor, 3 with disambiguating anchor.
- All existing table-cell + eval tests green; tsc clean.
- Lena re-score reported (expected 2 → 3).
- ARCHITECTURE_STATE.md note (good hygiene; touches only scripts/eval + tests, not a trigger path).
- Single commit on feature/task-4.3c-b-1b-i-2-column-aligned-rows; PR; CI green.
