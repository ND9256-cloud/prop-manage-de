# Task 4.3a — evidence-grounding scorer v1 (scalar fields, grades 0–3)

Context: docs/tasks/task-4.3-plan.md (WS2). Scorer-only — replace the broken
verbatim-quote `evid` metric with a field-aware, same-page, local-window
grounding GRADE for direct scalar fields, and split value-correctness from
evidence-grounding. NO schema/extractor change, NO re-extraction, NO Sonnet.

## Grade (per scalar field, 0–3)
- 3: normalized value (or accepted surface form) in a same-page local window AND a field-specific label/anchor in that window.
- 2: value in same-page window, no field-specific label nearby (or evidence.page missing on a critical field → cap at 2).
- 1: value appears somewhere in OCR but not tied to the field/window.
- 0: value not in OCR, or evidence contradicts OCR.

## Windows (same page ONLY — never cross pages)
- Direct: ±5 OCR lines around the value occurrence.
- Table-tolerant: also accept a field label/header in the previous 10 lines; wrapped cell values in the next 3 lines.
- If evidence.page is present, restrict the search to that page.

## Value normalization (value-match step)
- Money: "650,00" = "650.00" = "650 €" = "EUR 650,00".
- Dates: "01.09.2025" = "1. September 2025".
- Names: surname/company core token + ≥1 disambiguating token.

## Field labels (field-specific, NOT broad synonyms)
- Source per-field label sets from schemas/<doc_type>/generated/field_specs.ts — do NOT hardcode.
- kaltmiete grounds on Kaltmiete / Grundmiete / Nettokaltmiete; it must NOT ground on Miete / Monatsmiete / Gesamtmiete / Warmmiete.

## Metrics split
- Keep normalized_match exactly as-is (value-correctness).
- evidence_grounded becomes the 0–3 grade + its rate. Report both per-field and aggregated. Never collapse them.

## Derived fields — OUT OF SCOPE (4.3c)
- unit_ref and any composite/derived field: mark derived_pending, exclude from the grounding aggregate, do NOT assign a grade, no source_components/derivation machinery.

## Steps
1. Implement the grade in scripts/eval/metrics.ts — pure, deterministic, DB-free/API-free.
2. Wire into the score path (scripts/eval/run.ts) and results JSON: per-field grade + aggregate grade rate, separate from normalized_match.
3. Add src/tests/eval/grounding-grade.test.ts: synthetic OCR asserting each grade (3/2/1/0), the same-page constraint (value on wrong page → not grade 3), the label-trap (Monatsmiete must NOT ground kaltmiete), and the table-header lookback. Wire it into the eval-tests CI job.
4. Re-score the existing Lena candidate (eval/candidates/lena2); print her per-field grades. No re-extraction.
5. Update ARCHITECTURE_STATE.md (eval section): new grounding grade, value/evidence split, derived_pending, evid no longer verbatim. REQUIRED — touches an arch path, the gate fires otherwise.

## Out of scope
- No envelope/schema/extractor changes; no re-extraction; no Sonnet calls.
- No EvidenceGroundingStatus enum / derived grounding (4.3c).
- No gold-self-grounding invariant or fixture-layout split (4.3b).
- Do not change normalized_match math.

## Definition of done
- Grade function pure + deterministic; value vs grounding split in results.
- Lena re-score prints per-field grades (present fields reach grade 3, unit_ref = derived_pending).
- New grounding-grade test green and in CI; existing six eval tests unchanged-green.
- tsc + lint clean. ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3a-grounding-scorer; PR; CI green.
