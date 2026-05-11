# Task 1.5 Deploy Runbook — manual post-merge procedure

**This is a Nils-execution runbook, not a Claude Code task.** Run it after PR #?? (Task 1.5 v2 envelope path) merges to main.

**Time required:** ~15 minutes if everything works. ~30 minutes if rollback is needed.

**What this runbook accomplishes:** Deploys the Task 1.5 code to the Supabase Edge Function and confirms that both extraction paths work correctly against real production documents. Catches the failure mode "I broke extraction for the 116 doc types we are not changing."

**When NOT to run this runbook:**

- The PR has not yet merged to main
- You don't have at least 30 minutes of uninterrupted time
- It's late at night and you're tired (smoke-test interpretation needs judgment)
- You don't have the Discord open in case something needs urgent attention

---

## Pre-deploy: sanity checks

```bash
ssh federico@100.86.27.51
cd ~/repos/property-management-saas

# Confirm main has the merge
git checkout main
git pull
git log -5 --oneline | cat
# Look for: "v2: wire envelope path alongside legacy Haiku Step 5 (Task 1.5)"

# Confirm the registry is in place
cat schemas/index.ts
# Expected: V2_SCHEMA_DOC_TYPES = new Set(["mietvertrag"])

# Confirm regression tests still pass on main
npx tsc --noEmit
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx src/tests/v2-claim-store-migration.test.ts
npx tsx src/tests/v2-extraction-envelope-migration.test.ts
npx tsx src/tests/verifiers.test.ts

# Confirm Supabase CLI is linked
supabase status | cat
# Look for the project ref. If not linked: supabase link --project-ref <ref>
```

If any of the above fails, do NOT proceed. The code didn't actually reach a deployable state.

---

## Step 1: capture the pre-deploy state

Before deploying, snapshot the current Edge Function version and the row counts. This is what you compare against if you need to roll back.

```bash
# Current deployed function version
supabase functions list | cat

# Row counts for the two tables we care about
psql "$DATABASE_URL" <<SQL | cat
SELECT
  'document_extractions' AS table_name,
  COUNT(*) AS row_count,
  MAX(created_at) AS latest_row
FROM warehouse.document_extractions
UNION ALL
SELECT
  'document_extractions_v2' AS table_name,
  COUNT(*) AS row_count,
  MAX(created_at) AS latest_row
FROM warehouse.document_extractions_v2
UNION ALL
SELECT
  'document_intelligence' AS table_name,
  COUNT(*) AS row_count,
  MAX(created_at) AS latest_row
FROM warehouse.document_intelligence;
SQL
```

Write these numbers down. You will compare against them after the smoke tests.

Also save the current Git commit hash for the Edge Function in case rollback is needed:

```bash
git rev-parse HEAD~1 > /tmp/pre_task_1_5_commit
cat /tmp/pre_task_1_5_commit
```

That's the commit BEFORE Task 1.5's merge (i.e., the previous deploy target if rollback is needed).

---

## Step 2: deploy the Edge Function

```bash
cd ~/repos/property-management-saas
supabase functions deploy process-document
```

Expected output: deployment succeeds, version number increments. If deployment fails, do NOT proceed. Diagnose first (probably an import path error or a Deno-specific syntax issue).

Note the new function version number from the output.

---

## Step 3: identify smoke-test documents

Pick the documents you'll re-process:

```bash
psql "$DATABASE_URL" <<SQL | cat
-- Lena Everding's Mietvertrag (simplest v2 case)
SELECT id, file_name, doc_type, property_id
FROM warehouse.documents
WHERE doc_type = 'mietvertrag'
  AND property_id IN (SELECT id FROM "Property" WHERE short_code = 'KO132')
ORDER BY created_at DESC
LIMIT 5;
SQL

# Pick the one for Lena Everding from the file_name listing.
# Note the document_id.
```

```bash
psql "$DATABASE_URL" <<SQL | cat
-- A Rechnung (legacy path)
SELECT id, file_name, doc_type, property_id
FROM warehouse.documents
WHERE doc_type = 'rechnung'
ORDER BY created_at DESC
LIMIT 5;
SQL

# Pick any reasonable Rechnung. Note the document_id.
```

Save the two document IDs:

```bash
export LENA_DOC_ID="<paste lena's document id>"
export RECHNUNG_DOC_ID="<paste rechnung document id>"

echo "LENA: $LENA_DOC_ID"
echo "RECHNUNG: $RECHNUNG_DOC_ID"
```

---

## Step 4: smoke test 1 — Mietvertrag through v2 path

Trigger re-extraction by inserting a new processing job for Lena's Mietvertrag. The exact mechanism depends on how the pipeline is currently triggered — most likely a row in a `processing_jobs` table with status `queued`:

```bash
psql "$DATABASE_URL" <<SQL | cat
-- Adjust column names to match the actual processing_jobs schema.
-- The legacy code inserts into this table; mirror its pattern.
INSERT INTO warehouse.processing_jobs (document_id, status, created_at)
VALUES ('$LENA_DOC_ID', 'queued', NOW())
RETURNING id, document_id, status;
SQL
```

The Edge Function picks up the job within ~60 seconds (pg_cron triggers it every minute). Wait 2-3 minutes, then check:

```bash
psql "$DATABASE_URL" <<SQL | cat
-- Job status
SELECT id, document_id, status, error_message, last_stage, completed_at
FROM warehouse.processing_jobs
WHERE document_id = '$LENA_DOC_ID'
ORDER BY created_at DESC
LIMIT 3;
SQL
```

Expected: most recent job has `status = 'completed'`. If `status = 'failed'`, read the `error_message` — that's your diagnosis.

Now check the v2 envelope was written:

```bash
psql "$DATABASE_URL" <<SQL | cat
SELECT
  id,
  doc_type,
  schema_version,
  prompt_version,
  model,
  jsonb_pretty(fields) AS fields,
  jsonb_pretty(lifecycle) AS lifecycle,
  human_review_status,
  created_at
FROM warehouse.document_extractions_v2
WHERE source_document_id = '$LENA_DOC_ID'
ORDER BY created_at DESC
LIMIT 1;
SQL
```

**Read the output carefully. Verify ALL of these:**

- A row exists (not 0 rows)
- `doc_type = 'mietvertrag'`
- `schema_version = '2026-05-11-v1'`
- `model = 'claude-sonnet-4-20250514'`
- `human_review_status = 'not_reviewed'`
- `fields` contains all 5 expected fields: `kaltmiete`, `unit_ref`, `tenant_identity`, `mietbeginn`, `mietende`
- For each field, the envelope contains: `raw_value`, `normalized_value`, `evidence` with a quote, `confidence`, `absence_state`, `validation_status`
- `kaltmiete.normalized_value` is `{ "amount": 65000, "currency": "EUR" }` (€650.00 — Lena's rent)
- `kaltmiete.validation_status` is `'valid'` (the monetary-verbatim verifier passed — the amount appears in OCR text)
- `unit_ref.normalized_value` is `"1.OG"`
- `tenant_identity.normalized_value.name` contains "Everding" (case-insensitive)
- `mietbeginn.normalized_value` is `"2025-04-01"` (Lena's lease start)
- `mietende.absence_state` is `"not_applicable"` (Lena's lease is open-ended — this is the absence-state distinction that matters)
- `lifecycle.effective_date` is `"2025-04-01"`
- `lifecycle.document_status` is `"active"`

Also verify NO legacy extraction was written for Lena's document:

```bash
psql "$DATABASE_URL" <<SQL | cat
SELECT id, document_id, created_at
FROM warehouse.document_extractions
WHERE document_id = '$LENA_DOC_ID'
  AND created_at > NOW() - INTERVAL '5 minutes';
SQL
```

Expected: 0 rows. (Lena may have an OLD legacy row from before the deploy — that's fine. We're checking that the new processing job did NOT write a new legacy row.)

**If any of the verifications fail, stop here. Go to Rollback.**

---

## Step 5: smoke test 2 — Rechnung through legacy path

Trigger re-extraction for the Rechnung:

```bash
psql "$DATABASE_URL" <<SQL | cat
INSERT INTO warehouse.processing_jobs (document_id, status, created_at)
VALUES ('$RECHNUNG_DOC_ID', 'queued', NOW())
RETURNING id, document_id, status;
SQL
```

Wait ~2 minutes, then check the legacy extraction was written:

```bash
psql "$DATABASE_URL" <<SQL | cat
SELECT
  id,
  document_id,
  jsonb_pretty(extracted_fields) AS extracted_fields,
  confidence_score,
  created_at
FROM warehouse.document_extractions
WHERE document_id = '$RECHNUNG_DOC_ID'
ORDER BY created_at DESC
LIMIT 1;
SQL
```

**Verify ALL of these:**

- A row exists with a recent `created_at` (within the last 5 minutes)
- `extracted_fields` contains the existing legacy fields: `vendor_name`, `amount`, `invoice_date` (and possibly `description`, `address_hint`)
- Field values look reasonable for the Rechnung you picked

Also verify NO v2 envelope was written for the Rechnung:

```bash
psql "$DATABASE_URL" <<SQL | cat
SELECT COUNT(*) AS v2_envelope_count
FROM warehouse.document_extractions_v2
WHERE source_document_id = '$RECHNUNG_DOC_ID';
SQL
```

Expected: 0.

And verify intelligence still ran for the Rechnung:

```bash
psql "$DATABASE_URL" <<SQL | cat
SELECT id, summary, tags, entity_name, created_at
FROM warehouse.document_intelligence
WHERE document_id = '$RECHNUNG_DOC_ID'
ORDER BY created_at DESC
LIMIT 1;
SQL
```

Expected: a row with summary/tags/entity_name populated.

**If any of the verifications fail, stop here. Go to Rollback.**

---

## Step 6: smoke test 3 — visual check of the inbox

Open the live URL: `https://prop-manage-de.vercel.app/dashboard/warehouse/inbox`

Verify:

- Both Lena's Mietvertrag and the Rechnung appear in the listing
- The Rechnung renders with vendor_name, amount, date columns populated as before (no regression)
- Lena's Mietvertrag may render with EMPTY fields in the listing (the dual-read in the triage overlay is Task 1.6 — not shipped yet). THIS IS EXPECTED. The data is in `document_extractions_v2`; the UI reader for it is the next task.

Click into a few other documents to confirm the inbox layout looks normal. If anything looks broken beyond "Mietvertrag fields empty in listing," investigate before considering this smoke test passed.

---

## Step 7: post-deploy verification

If all three smoke tests passed, document the success:

```bash
# Confirm the row counts incremented as expected
psql "$DATABASE_URL" <<SQL | cat
SELECT
  'document_extractions' AS table_name,
  COUNT(*) AS row_count
FROM warehouse.document_extractions
UNION ALL
SELECT
  'document_extractions_v2' AS table_name,
  COUNT(*) AS row_count
FROM warehouse.document_extractions_v2;
SQL
```

Compare to Step 1 numbers:
- `document_extractions` should have grown by 1 (the Rechnung re-extraction)
- `document_extractions_v2` should have grown by 1 (Lena's Mietvertrag)

Note the new deploy version:

```bash
supabase functions list | cat
```

The deploy is complete. The v2 envelope path is live for Mietverträge.

---

## Rollback procedure (if any smoke test fails)

**Step 1: revert the Edge Function**

The Supabase CLI doesn't have a "redeploy previous version" command, so rollback means redeploying from the pre-Task-1.5 git state:

```bash
cd ~/repos/property-management-saas

PRE_TASK_1_5=$(cat /tmp/pre_task_1_5_commit)
echo "Rolling back Edge Function to commit: $PRE_TASK_1_5"

git stash # save any local changes
git checkout $PRE_TASK_1_5 -- supabase/functions/process-document/

supabase functions deploy process-document

git checkout main -- supabase/functions/process-document/
git stash pop 2>/dev/null || true
```

This redeploys the pre-Task-1.5 version of the Edge Function while keeping main at the post-Task-1.5 state. The Edge Function is now running old code; the repo is unchanged.

**Step 2: revert the merge commit on main (optional but recommended)**

If the deploy rollback alone is enough (the bad code is no longer running), you can leave main as-is and fix-forward later. But if you want main to match what's deployed:

```bash
git checkout main
git revert <merge-commit-hash> --no-edit
# Follow PR workflow:
git checkout -b revert/task-1.5
git push -u origin revert/task-1.5
# Open PR, merge, etc.
```

**Step 3: diagnose the failure**

Read the Edge Function logs in the Supabase dashboard, the failed job's `error_message`, and the most recent envelope (if any) for the failing document. Most likely causes:

- Sonnet API authentication issue (env var) → check `ANTHROPIC_API_KEY` in Edge Function secrets
- Envelope validator rejecting Sonnet output → inspect raw Sonnet response in logs
- Insert error on `document_extractions_v2` → check RLS / schema permissions
- Import path error in Deno → check `.ts` extensions on internal imports

Fix in a new branch, re-test locally, redeploy.

**Step 4: communicate**

Post in `#status` (or wherever appropriate) that the deploy was rolled back and the v2 path is not yet live. This avoids confusion if anyone else is checking the inbox.

---

## What this runbook does not cover

- Multi-property tests beyond KO132/HHS55 (we don't have other properties)
- Load testing (one document at a time is fine for a smoke test)
- The Mietvertrag rendering in the triage overlay (Task 1.6, separate)
- Claim emission (Task 1.7, the envelope is written but no claims are produced yet)

After this runbook completes successfully, Phase 1 advances to Task 1.6 (triage overlay dual-read).
