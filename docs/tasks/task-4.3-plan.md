# Task 4.3 — Gold set + evidence-grounding redefinition (Step-0 plan)

Three workstreams, in order. WS1 and WS2 are prerequisites: the labeling in WS3
can only be scored correctly once the layout is fixed and the grounding metric
is redefined.

## WS1 — Fixture layout: one source.txt per gold envelope
Proven (2026-05-31): multi-envelope case dirs share one source.txt, so every
envelope but Everding scored garbage — Hofmann's mietvertrag gold scored 0.00
against the wrong document's OCR.
- Option A: split into one-envelope dirs `<case>/<doc_type>/{expected.json, source.txt}`. Cleanest; changes fixture_id.
- Option B: keep dirs, add `<doc_type>.source.txt` beside each envelope. Less disruptive to existing ids.
- Loader: `source_text_path` must resolve PER-ENVELOPE, not per case_dir.
- Watch: do not break extract-wiring / score-smoke fixture_id assumptions. Step-0 carefully.

## WS2 — Evidence-grounding redefinition  [DECISION NEEDED — defensibility]
Proven (2026-05-31): current rule = verbatim quote is a substring of OCR. It
fails on the gold's OWN quotes for table-sourced fields, because OCR linearizes
tables into messy text; quotes (gold and model) are clean reconstructions.
Whitespace-normalization alone is insufficient — line 167 of Lena's source had
label and value separated by a wall of table whitespace, and the prose
"beträgt monatlich" was not present at all. Values DO appear: "650,00" at lines
99/167, "Everding, Lena" at line 23.
Options, weakest -> strongest grounding:
- Value-anchored: grounds if normalized value/token appears in OCR. Robust, but weak as a legal shield — a value can appear anywhere.
- Value + local label window: value token AND a label/synonym within N lines. Ties value to context.
- Token-overlap: quote grounds if >= X% of its content tokens appear in a local OCR window. Robust, keeps quote semantics.
Lean: value+window or token-overlap, NOT bare value-presence — defensibility is
the moat. Send to ChatGPT for an adversarial pass before implementing.
Plus: add the gold-self-grounding invariant — every gold field MUST ground in
its own source.txt under the chosen rule, as a CI test. It fails until WS1 lands
(that is the point). Lena's evid should move 0.625 -> ~1.0.
NOTE: evid must NOT gate CI until this redefinition lands (per ARCHITECTURE_STATE line ~1548).

## WS3 — Adversarial fixtures  [~8hr labeling]
Stress the known weak spots:
- Mietvertrag (5-10): missing kaution (the structural Sonnet miss), co-tenants (two names), odd floors (Dachgeschoss, EG rechts, 2.OG links), OCR-garbled numbers, Staffel/Indexmiete, fixed-term vs open-ended.
- Übergabeprotokoll (3-5): Hofmann-class edges.
- Each = one gold envelope + its own source.txt (per WS1). Label values + grounding evidence per the chosen rule.
- Then: CI coverage gate over the gold split.

## Sequence
WS1 (layout) -> WS2 (decide rule, implement, add invariant) -> WS3 (label against the working harness) -> CI coverage gate.

## Baseline (pre-4.3, for regression reference)
Lena via `score --fixture-id everding`: norm=1.000, exact=0.875, evid=0.625.
