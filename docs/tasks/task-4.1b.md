# Task 4.1b — Complete the live-extract path (Sonnet) + real-case OCR inputs

## Why
4.1 shipped the harness but stubbed the live extractor, and the real fixtures have no OCR source text — so today the harness only scores gold-against-itself and evidence-grounding is always false. This task makes the scoreboard real: wire the production Sonnet (Step 8b) extractor into `extract` mode and add OCR text to the 5 real-case fixtures, so `extract --live --fixture-cap N` produces real candidate envelopes and `score --candidate` grades real extraction against gold (value, normalized, evidence-grounding, absence). Completes 4.1's own AC ("runs each through the pipeline; Sonnet only at launch") that 4.1 deferred. Adversarial fixtures + labeling stay in 4.3.

## Step 0 — verify before building (do NOT guess)
1. Confirm 4.1 is merged to main (scripts/eval/{run,loader,metrics,types}.ts present on main). If not merged, STOP — this branches off main after 4.1.
2. Locate where per-document OCR text is persisted (table/column — likely warehouse.documents or the OCR step output). Confirm the document IDs for the 5 real cases (Lena = f7c3e663-11bf-4b91-947c-9136df9eefae; find Paul EG, Kuru DG, Weber x2, Hofmann by matching the existing fixture case dirs).
3. Read run.ts runExtract + loader's source_text_path/case_dir convention — confirm exactly where a fixture's source.txt must live and how the loader exposes it.
4. Confirm the production Step 8b extraction entry point (function: OCR text + doc_type/schema -> envelope). This is what extract mode calls. Confirm it is callable from a script; if it is only reachable via an Edge Function (HTTP), FLAG it — the wiring strategy changes.
5. Confirm the candidate-envelope shape extract writes matches what score --candidate / loadCandidateEnvelope expects.

## Scope
- Add source.txt (real OCR text, pulled from where Step 0 #2 found it) to each of the 5 real-case gold fixtures.
- Wire the production Sonnet Step 8b extractor into run.ts extract mode: for each matched fixture, read source.txt, run extraction, write candidate envelope to --out/<fixture_id>. Sonnet only (Opus is 4.5). Keep the --live + --fixture-cap gating exactly as-is.
- After this: extract --live --fixture-cap N produces real candidate envelopes; score --candidate <dir> grades them.

## Out of scope (separate tasks)
- Adversarial synthetic fixtures + Nils labeling (4.3).
- Formal gold/dev/test split population beyond the 5 real cases (4.3).
- Opus / critic / model diversity / triage disagreement (4.5).
- CI wiring + Discord alert (4.2).
- Any change to the production extractor itself, or to emitter/applier/resolver/composer/presenter. Call the extractor; do not modify it.

## Test (run it, don't report it)
- Wiring test with a MOCKED extractor (no API): extract mode reads source.txt, calls the mocked extractor, writes a candidate envelope of the expected shape to the out dir. Deterministic, zero spend. This is the CI-safe test.
- One bounded LIVE smoke (manual/local only, NOT in CI): extract --live --fixture-cap 1 --doc-type mietvertrag on the Lena case -> produces a candidate envelope; score --candidate <dir> -> results JSON well-formed and evidence_grounded_rate for Lena is now computable (>0, since source.txt exists). ~1 doc of Sonnet spend.
- Existing metrics + score-smoke tests still pass.

## Definition of done
- Step 0 facts in PR description (OCR text location, extractor entry point, the 5 doc IDs).
- tsc clean, lint clean (changed files). Mocked wiring test passes when run.
- CI must NOT call live Sonnet — the live smoke is manual/local; CI runs the mocked test only.
- Single commit. Branch feature/task-4.1b-live-extract off main after 4.1 merged + git pull.
- ARCHITECTURE_STATE.md updated (Tier 0).
- PR opened and verified on GitHub.
- CI green.

## Notes
This makes the harness measure real extraction quality on the real cases — the moat metric. Bounded spend (live behind --live + cap, never in CI). The 8-hour adversarial labeling (4.3) comes when we want edge-case coverage.
