# Task 4.3b — one source.txt per gold envelope + gold-self-grounding invariant

Context: docs/tasks/task-4.3-plan.md (WS1) + task-4.3a-grounding-scorer.md.
Make the fixture layout sound (each gold envelope resolves to its OWN source
OCR) and lock it with a CI invariant: every gold envelope's present,
non-derived fields must ground at grade 3 in its own source. Loader + test
only — NO extractor/schema change, no re-extraction, no Sonnet.

## Layout / loader (Option B — preserve fixture_ids, additive)
Resolve a gold envelope's source in this order:
1. `<envelope_basename>.source.txt` in the same dir (dedicated per-envelope source).
2. If the dir contains exactly ONE gold envelope, fall back to the dir's `source.txt`.
3. Otherwise source_text_path = null (multi-envelope dir, secondary not yet backfilled).
Do NOT rename dirs or change fixture_ids. Do NOT delete existing shared source.txt.
Result: Lena (single-envelope dir) keeps resolving to her source.txt; hofmann/
supersession secondaries resolve to null until WS3 backfills per-doc OCR.

## Gold-self-grounding invariant (new test)
For every gold envelope WITH a non-null resolved source: assert every PRESENT,
NON-DERIVED field grounds at grade 3 in that source (using the 4.3a/names grade).
Skip (do not fail): fields with absence_state absent/not_applicable; derived
fields (unit_ref etc.); and whole envelopes whose source is null → report these
as `pending_source`, NOT failures.
Print summary: asserted_envelopes=N, pending_source=M, and any field below
grade 3 (hard failure — gold value doesn't ground in its own source).
Lena must pass (her present non-derived fields are already grade 3).

## Steps
1. Loader (scripts/eval/loader.ts): per-envelope source resolution as above.
2. Add src/tests/eval/gold-grounding.test.ts: run the invariant over all gold fixtures; assert Lena passes; assert the known multi-envelope secondaries are reported pending_source (not failed). DB-free/API-free.
3. Wire gold-grounding.test.ts into the eval-tests CI job.
4. Update ARCHITECTURE_STATE.md (eval section): per-envelope source resolution, gold-self-grounding invariant, pending_source semantics. REQUIRED — arch path.

## Out of scope
- No extractor/schema change, no re-extraction, no Sonnet.
- Do NOT create per-document OCR for multi-envelope cases (WS3 — Nils labels).
- No derived/composite grounding (4.3c); unit_ref stays derived_pending.
- Do not change 4.3a grade logic or normalized_match.

## Definition of done
- Loader resolves source per-envelope (dedicated → single-dir fallback → null).
- Invariant green: Lena (+ any 1:1 dir) asserted at grade 3; multi-envelope secondaries reported pending_source, not failed.
- New test in CI; existing seven eval tests unchanged-green; tsc + lint clean; ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3b-gold-grounding; PR; CI green.
