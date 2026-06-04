# Task 4.1b-followup — eliminate extractor.ts drift (schema-drive V2_CONFIGS + wrapper guard)

## Why
scripts/eval/extractor.ts re-hosts production Step 8b and hand-duplicates V2_CONFIGS (field specs + verifier refs) and the German system-prompt wrapper from supabase/functions/process-document/index.ts. If those drift from production, the eval harness silently measures something different from what ships — unacceptable for a legal-defensibility product. Remove the duplication; guard what can't be removed.

## Step 0 — verify before changing (do NOT guess)
1. Confirm 4.1b is merged to main (scripts/eval/extractor.ts present on main). If not, STOP.
2. Read schemas/mietvertrag/schema.yaml (+ schemas/mietvertrag/generated/*). Confirm it carries per-field id, severity, type, enum_values, and verifier_refs — the source that should drive V2_CONFIGS. Prefer driving from the generated TS artifact if one already exposes these (cleaner than parsing YAML at runtime).
3. Read extractor.ts V2_CONFIGS (fieldSpecs + verifierRefs) and buildPrompt's system-prompt wrapper. Locate the exact production wrapper in index.ts (the lines extractor.ts cites, ~934-944) for the drift-guard.

## Scope
- Drive extractor.ts fieldSpecs + verifierRefs from the schema source (schema.yaml or its generated artifact), NOT the hardcoded V2_CONFIGS table. Single source of truth = the schema files (same source prompt_fragment already comes from). NO behavior change — the schema-driven config must equal today's hardcoded values, so the existing extract-wiring/metrics/score-smoke tests still pass unchanged.
- The system-prompt wrapper lives in Deno index.ts and can't be cleanly imported into Node — keep extractor.ts's copy BUT add a drift-guard test that reads index.ts, extracts the wrapper string, and asserts it byte-matches extractor.ts's wrapper. Diverging fails the test.
- Keep the shared prompt_fragment / validator / verifier imports as-is.

## Out of scope
- Changing the production extractor (index.ts).
- Adding doc types (only mietvertrag has a config).
- 4.2 CI wiring, 4.3 gold set.

## Test (run it, don't report it)
- Existing src/tests/eval/extract-wiring.test.ts + metrics.test.ts + score-smoke.test.ts still pass (proves schema-driven config == old hardcoded config).
- New drift-guard test: extractor.ts's system-prompt wrapper byte-matches production index.ts's wrapper; and the schema-driven fieldSpecs/verifierRefs match the expected mietvertrag set.
- Mocked only; no live Sonnet.

## Definition of done
- Step 0 facts in PR body. tsc clean, lint clean (changed files). All four tests pass when run.
- Single commit. Branch feature/task-4.1b-followup-config-drift off main after git pull.
- ARCHITECTURE_STATE.md updated (Tier 0).
- PR opened and verified on GitHub. CI green.

## Notes
Removes the one real debt from 4.1b: silent eval/production drift. After this the harness's extractor config can't diverge from the schema source of truth, and the wrapper is drift-guarded.
