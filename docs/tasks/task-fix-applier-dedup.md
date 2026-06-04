# Fix — applier claim idempotency (dedup on re-processing)

## Why
Re-processing a document stacks duplicate active claims. The applier keys dedup on `source_extraction_run_id`, so each re-run looks new and inserts fresh active claims for facts that already exist. In a GoBD append-only store duplicates can't be deleted — only superseded by hand (already paid that on Lena's 3 May-25 dupes). First customer who re-uploads a corrected document hits this. Shadow mode surfaces the first symptom as `kaltmiete_amount_mismatch`.

## Desired property (an invariant, not a patch)
Claim application is idempotent. Applying the same document's extraction N times yields exactly one active claim per fact. Applying a corrected version supersedes the prior active claim (close old, open new) rather than stacking a parallel active claim.

Distinguish two cases:
- identical re-emission -> suppress (true no-op)
- changed fact from same document -> supersede via the existing supersession path, do not insert a parallel active claim

## Step 0 — verify before changing (do NOT guess column names)
1. Open the applier. Locate where it decides insert vs skip vs supersede. Confirm the current dedup key is source_extraction_run_id only.
2. Confirm warehouse.claims identity columns: subject, predicate, value (jsonb), valid_from, valid_to, source_document_id, source_extraction_run_id, superseded_at, superseded_by_claim_id.
3. Confirm how "currently active" is defined in THIS codebase (valid_to IS NULL? superseded_at IS NULL? both?). Use the existing definition; do not invent one.
4. Find the existing supersession entry point (closing-matrix / Task 2.2 supersession gate). Changed facts route through THIS, not a new path.
5. Confirm whether value comparison happens in SQL (jsonb equality) or app code (parsed object). If app-level, comparison must be canonical — key order and number/string representation must not yield false negatives.

## Scope (do exactly this)
- Identify a fact by (source_document_id, subject, predicate, value, valid_from) — NOT by source_extraction_run_id.
- Identical re-application (same identity tuple, same value): no-op. No insert, no supersede, do not touch superseded_at.
- Same (source_document_id, subject, predicate, valid_from) but value differs: route through the existing supersession path — supersede the prior active claim, insert the new one, exactly one active claim remains.
- value comparison must be canonical (jsonb=jsonb in SQL, or deep-equal on parsed jsonb). State which layer in the PR description.

## Out of scope (separate tasks — do NOT do here)
- The partial unique index migration enforcing this at the DB layer (follow-up; needs a clean store first).
- Backfilling/superseding pre-existing duplicate active claims (separate; needs a count first).
- Shadow-mode alert tuning.
- Any change to emitters, resolvers, composer, presenter.

## Test (DoD includes this passing — run it, don't report it)
Extend the integration suite (everding end-to-end is the model). Real Lena data (document_id f7c3e663-11bf-4b91-947c-9136df9eefae), never fabricated:
- a. Apply Lena's extraction -> assert exactly one active kaltmiete claim, value 65000.
- b. Apply the SAME facts again (new extraction_run_id, identical facts) -> assert STILL exactly one active claim AND no new superseded_at was written (true no-op).
- c. Apply a modified extraction (same document_id, value -> 70000) -> assert exactly one active claim at 70000, and the 65000 claim is superseded (superseded_at set, superseded_by_claim_id -> new claim).

Load .env.local via dotenv.config at top of the test file. Precise on counts and supersession links.

## Definition of done
- Step 0 facts confirmed in PR description (actual column names, actual active-claim predicate, actual supersession entry point).
- tsc clean, lint clean. Test above passes when run.
- Single descriptive commit. Branch feature/fix-applier-dedup off main after git pull.
- ARCHITECTURE_STATE.md updated (touches pipeline logic — Tier 0 gate).
- PR opened and verified on GitHub (a pushed branch is not an opened PR).
- CI green (tenant-isolation, migration-drift, all gates).

## Notes
Highest-priority pre-customer fix. Correctness over speed. The five real cases are the truth — if Lena's end-to-end test regresses, stop and investigate.
