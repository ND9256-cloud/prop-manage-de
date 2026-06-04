# Task 4.3c-a — scorer-only derived grounding for single-source derived fields (unit_ref)

Context: docs/tasks/task-4.3c-plan.md (4.3c-a) + task-4.3a-grounding-scorer.md.
Grade single-source DERIVED fields (currently derived_pending) by validating
their derivation scorer-side. NO schema/extractor change, no re-extraction, no
Sonnet. Composite multi-component fields (e.g. addresses) stay derived_pending → 4.3c-b.

## Derived grade for a single-source derived field
derived_grounded (grade 3) iff BOTH:
1. quote-grounds: the field's evidence.quote text appears in OCR on its
   evidence.page (normalized whitespace; same-page window as 4.3a). The cited
   source phrase must really exist in the document.
2. rule-reproduces: applying the field's declared deterministic normalization
   rule to the evidence.quote yields the field's normalized_value. The derivation
   must be reproducible from the cited source.
Grades:
- 3: both hold (source exists AND the rule reproduces the value).
- 1: quote grounds but the rule does NOT reproduce the value (source present, derivation unverified).
- 0: quote does not ground (cited source absent from OCR).

## floor_synonym_normalization (the rule for unit_ref)
Declared, deterministic, CLOSED map in the scorer (documented). German floor
phrase → canonical floor token used by unit_ref normalized_value:
- Erdgeschoss / EG → EG
- 1./2./3. Obergeschoss, "1. OG"/"1.OG", erste/zweite/dritte Etage → 1.OG / 2.OG / 3.OG
- Dachgeschoss / DG → DG
- Unter-/Kellergeschoss / UG → UG
- Preserve position suffix links/rechts/Mitte → e.g. "1.OG links".
Unknown/unmappable input → no result (honest non-match), NEVER guess.

## Spec wiring
- unit_ref already has derived=true in GROUNDING_SPECS. Add derived_kind="single_source"
  + normalization_rule="floor_synonym_normalization". Fields with a single_source
  rule get the derived grade above; fields without (composites) stay derived_pending.
- Route unit_ref through derived grading in metrics.ts; composites untouched.

## Gold-self-grounding invariant — DO NOT turn it red
Derived fields graded by c-a are REPORTED in the invariant output with their
grade but DO NOT hard-fail it in c-a (report-only for derived). Hard-gating of
derived fields waits until 4.3c is complete. Lena's unit_ref must not break the
green gate regardless of its grade.

## Steps
1. floor_synonym_normalization(quote) -> token | null in metrics.ts — pure, deterministic, documented, tested.
2. Derived grade fn (quote-grounds + rule-reproduces) for single_source fields; route unit_ref; composites stay derived_pending.
3. Add src/tests/eval/derived-grounding.test.ts (synthetic OCR, DB-free/API-free): "Wohnung im 1. Obergeschoss" -> "1.OG" grade 3; "Dachgeschoss" -> "DG" grade 3; "1. Obergeschoss links" -> "1.OG links" grade 3; quote present but rule mismatch -> grade 1; quote absent -> grade 0; unmapped floor phrase -> honest non-match. Wire into eval-tests CI.
4. Update gold-grounding invariant to REPORT (not hard-fail) derived grades; keep it green.
5. Re-score Lena (eval/candidates/lena2): print unit_ref's derived grade. NOTE: Lena's unit_ref evidence is a table-cell ("1" under a "Geschoss" column), NOT a clean floor phrase — it may grade 1 or 0, exposing it as a table case for 4.3c-b. Report whatever grade is honest; do NOT force it to 3.
6. Update ARCHITECTURE_STATE.md (eval section): single-source derived grounding, floor_synonym_normalization, composites still pending, invariant reports-not-fails derived. REQUIRED — arch path.

## Out of scope
- No schema/extractor change, no re-extraction, no Sonnet.
- No source_components / typed EvidenceGroundingStatus enum (4.3c-b).
- Composite/multi-component fields stay derived_pending.
- Do not change scalar/identity grade logic or normalized_match.
- Do not make derived fields hard-fail the gold-grounding invariant yet.

## Definition of done
- floor_synonym_normalization deterministic + tested; single_source derived grade (3/1/0) implemented.
- unit_ref routed through derived grading; composites still derived_pending.
- New derived-grounding test green + in CI; existing eight eval tests unchanged-green; gold-grounding invariant still green (derived report-only).
- Lena re-score prints unit_ref's honest derived grade (table-case boundary noted if <3).
- tsc + lint clean; ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3c-a-derived-grounding; PR; CI green.
