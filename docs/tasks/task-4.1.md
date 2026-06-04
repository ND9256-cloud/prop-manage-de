# Task 4.1 — Eval harness scaffolding

## Why
Before the chat interface (D.1) we need the regression/accuracy net that measures extraction quality against ground truth. 4.1 builds the harness; 4.2 wires it to CI + Discord; 4.3 populates the full gold set; 4.5 adds Opus. This task is scaffolding only.

## Design decision (read first)
Separate extraction (live Sonnet — slow, costs money, non-deterministic) from scoring (deterministic, fast, no LLM). Two modes:
- `extract --live` — runs Step 8b on each fixture's OCR input, writes candidate envelopes. Gated behind an explicit flag, bounded fixture count, never auto-runs.
- `score` — compares candidate envelopes to gold envelopes, computes metrics, writes results JSON. No LLM, deterministic.
This makes 4.2's per-PR gate tractable (CI scores recorded candidates deterministically; live extraction runs on-demand/nightly) and keeps us inside the Anthropic spend cap.

## Step 0 — verify before building (do NOT guess)
1. Read architecture §13.2 — the gold/dev/test split definition and directory convention. The fixture loader must respect it.
2. Read an existing fixture envelope (tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json). Confirm field shape: raw_value, normalized_value, evidence (quote), absence_state. Confirm per-field severity comes from schemas/<doc_type>/schema.yaml fields[].severity (the 0.2 meta-schema), NOT the envelope.
3. Locate the extraction INPUT for each fixture — the OCR text Step 8b consumes. If fixtures store only the gold envelope and no input, FLAG it: extract mode is blocked until inputs exist (4.3 gold-set work), but score mode + the metrics module are fully buildable and testable now. Do NOT fabricate inputs.
4. Confirm how Step 8b extraction is invoked in code (function: OCR text + schema -> envelope) for the extract-mode caller.
5. Confirm the envelope/field TypeScript types for typed comparison. Check for any existing scripts/eval/ stub.

## Scope (4.1 only)
- scripts/eval/run.ts CLI with extract --live and score modes as above.
- Metrics module (separate file, unit-testable without LLM):
  - exact_match: raw_value string equality
  - normalized_match: canonical comparison of normalized_value (deep-equal / jsonb-style — keys sorted, numeric-by-value)
  - evidence_grounded: evidence present AND its quote found verbatim in the source OCR text. (Semantic "does the quote justify the value" is deferred to the 4.5 critic — do NOT attempt LLM judgment here.)
  - absence_state_correct: gold-absent => candidate reports absence (no hallucinated value); gold-present => candidate present.
  - severity_weighted_error_rate per doc_type, using fields[].severity from schema.yaml.
- Fixture loader respecting the §13.2 split.
- Output: eval/results/<timestamp>.json — per-doc-type -> per-field metrics + per-model (Sonnet only now), structured so two runs can be diffed (4.2 consumes this).
- Runs against the existing Phase 1/2 fixtures (the 5 real cases). Full gold set + adversarial fixtures are 4.3.

## Out of scope (separate tasks)
- CI workflow + Discord regression alert (4.2).
- Gold-set population, adversarial fixtures, labeling (4.3).
- Opus / critic / model diversity (4.5).
- Launch checklist (4.4).
- Semantic evidence-justifies-value judgment (4.5).
- Any change to extractor / emitter / applier / resolver / composer / presenter.

## Test (run it, don't report it)
- Metrics unit test (deterministic, NO LLM): hand-built candidate-vs-gold pairs exercising each metric — exact hit/miss, normalized hit/miss (incl. key-order and numeric-vs-text), evidence grounded/ungrounded, absence correct/incorrect, severity weighting. This is the core correctness test.
- score mode smoke: run against the existing fixtures (gold-vs-gold => perfect score) and assert the results JSON is well-formed with expected keys.
- extract --live mode: smoke on a SINGLE fixture only if inputs exist (bounded spend); otherwise assert it errors cleanly when inputs are absent. Do NOT run live extraction across the whole set during verification.

## Definition of done
- Step 0 facts in PR description (split convention, fixture field shape, severity source, whether fixture inputs exist).
- tsc clean, lint clean (changed files). Metrics unit test + score smoke pass when run.
- Live extract requires an explicit --live flag and a fixture cap; never auto-runs.
- Single commit. Branch feature/task-4.1-eval-harness off main after git pull.
- ARCHITECTURE_STATE.md updated (Tier 0).
- PR opened and verified on GitHub.
- CI green.

## Notes
Scaffolding only. The metrics module must be rock-solid and is tested deterministically. Live extraction cost is bounded behind a flag. If fixture inputs (OCR text) don't exist yet, build everything score-side and flag the input gap for 4.3 — do not fabricate inputs.
