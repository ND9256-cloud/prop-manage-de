# Task 1.5 — Step 8b refactor: wire v2 envelope path alongside Haiku Step 5

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §11 (full section — read in entirety), §11.2 (the actual v2 launch plan with the per-document flow diagram), §3 (envelope shape), §9.1 (Sonnet at launch)
- `extraction-v2-implementation-plan.md` Task 1.5 section

Schema and pipeline references:
- `supabase/functions/process-document/index.ts` (current pipeline — read top to bottom)
- `schemas/mietvertrag/generated/prompt_fragment.ts` (the prompt this task wires into Step 8b)
- `schemas/mietvertrag/generated/envelope_validator.ts` (validates v2 envelope shape before insert)
- `supabase/functions/process-document/verifiers/index.ts` (VERIFIERS registry)

This is the **highest-risk task in Phase 1**. It modifies the production pipeline that runs on every uploaded document. A bug here affects extraction for all properties — KO132, HHS55, and every future customer's property. **Read the verification steps carefully before reporting completion. Do NOT deploy if any smoke test fails.**

## What this task does

Adds a dual-path branch inside `process-document/index.ts`:

- **Doc types WITH a v2 schema** (currently only `mietvertrag`): skip Haiku Step 5. Run Sonnet Step 8b with the schema's `prompt_fragment_template` instead of the existing intelligence-layer prompt. Validate the response against the envelope shape. Run verifiers. Write to `warehouse.document_extractions_v2`. No write to legacy `warehouse.document_extractions`.

- **Doc types WITHOUT a v2 schema** (all others — ~116 doc types: Rechnung, Versicherungspolice, Grundbuchauszug, etc.): pipeline runs unchanged. Step 5 (Haiku) writes legacy `document_extractions` with vendor_name/amount/invoice_date as today. Step 8b (Sonnet) writes legacy `document_intelligence` with summary/tags/entities as today. No v2 envelope written.

The path is selected by a registry lookup: `HAS_V2_SCHEMA(doc_type: string) => boolean`.

The decision-making for which path to take must be deterministic, fast, and based on a static registry — NOT a live database lookup, NOT an LLM call.

## What this task does NOT do

- Does NOT remove the Haiku Step 5 code path. It continues to exist and run for non-v2 doc types.
- Does NOT modify the classifier (Step 4). Classification still returns `doc_type` as today.
- Does NOT emit claims. The v2 envelope is written; claim emission happens in Task 1.7.
- Does NOT change the triage UI. UI changes happen in Task 1.6.
- Does NOT touch `warehouse.document_intelligence` for v2 docs (Mietverträge get a v2 envelope, not an intelligence row — intelligence stays for legacy doc types).

## Repo conventions (do NOT deviate)

- Package manager: **npm**
- Edge Function runtime: **Deno** — use explicit `.ts` extensions on internal imports
- Deployment: `supabase functions deploy process-document` (NOT auto-deployed by git push)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Pipe potentially-paged commands through `| cat`
- Do NOT push directly to main. Branch protection requires PR workflow.

## Steps

### 1. Add the v2 schema registry

The generator (Task 0.3) already produces per-doc-type files but does not produce a top-level registry. Create one.

Path: `schemas/index.ts`

```typescript
// Registry of doc types with v2 schemas.
// This file is HAND-MAINTAINED. When adding a new doc-type schema:
// 1. Create schemas/<doc_type>/schema.yaml
// 2. Run npm run gen:schemas
// 3. Add the doc_type to V2_SCHEMA_DOC_TYPES below
//
// Hand-maintained (rather than auto-generated) so adding a doc type is a
// deliberate, reviewable act — not a side effect of a YAML file existing.

export const V2_SCHEMA_DOC_TYPES = new Set([
  "mietvertrag",
]);

export function hasV2Schema(docType: string): boolean {
  return V2_SCHEMA_DOC_TYPES.has(docType);
}
```

Note: this registry is INTENTIONALLY hand-maintained. Even though the schemas directory's structure could be discovered at build time, that would mean "any schema YAML that exists" automatically becomes a production code path. We want adding a doc type to be deliberate.

When Task 1.4 was wohnungsuebergabeprotokoll content only, that's why the entry above is just `mietvertrag` — the Übergabeprotokoll schema YAML is still a stub (no fields populated yet, that comes in Phase 2). Only `mietvertrag` has a complete launch-slice schema.

### 2. Read the current pipeline

Before modifying, read `supabase/functions/process-document/index.ts` end-to-end. Understand:

- The order of steps (Step 1 claimJob through Step 9 completeJob)
- Where Step 5 (extractFields with Haiku) actually executes
- Where Step 8b (generateIntelligence with Sonnet) executes
- What gets written to `document_extractions` (Step 5 output)
- What gets written to `document_intelligence` (Step 8b output)
- Error handling — what happens when a step fails

This is mandatory reading. Modifying the pipeline without understanding the existing flow is the recipe for breaking the 116 doc types we are trying to preserve.

### 3. Modify Step 5 (Haiku) — add the v2-schema skip

Find the function that runs Step 5 (likely named `extractFields` or similar). Before it makes the Haiku API call, check the registry:

```typescript
import { hasV2Schema } from "../../../schemas/index.ts";

// Inside extractFields function, after we know the doc_type:
if (hasV2Schema(doc_type)) {
  // v2 path: skip Haiku entirely. No legacy extraction is written.
  // The v2 envelope will be written by Step 8b instead.
  return { skipped: true, reason: "v2_schema" };
}

// Otherwise: existing Haiku logic runs unchanged for legacy doc types.
```

The exact signature and integration depends on the existing code structure. The principle: the skip must happen BEFORE the API call (no wasted Haiku spend) and the function must signal cleanly to downstream code that no extraction was written.

### 4. Modify Step 8b (Sonnet) — add the v2-envelope branch

Step 8b currently produces intelligence-layer output (summary, tags, entity_name, action_signals, structured_fields). Modify it to branch on the registry:

```typescript
import { hasV2Schema } from "../../../schemas/index.ts";
import { PROMPT_FRAGMENT as MIETVERTRAG_PROMPT } from "../../../schemas/mietvertrag/generated/prompt_fragment.ts";
import { validateEnvelope as validateMietvertragEnvelope } from "../../../schemas/mietvertrag/generated/envelope_validator.ts";
import { VERIFIERS } from "./verifiers/index.ts";

// Map from doc_type to its prompt + validator.
// (Could be data-driven from the registry, but for one doc type at launch, explicit.)
const V2_PROMPTS: Record<string, { prompt: string; validate: (data: unknown) => { ok: boolean; errors?: string[] } }> = {
  mietvertrag: { prompt: MIETVERTRAG_PROMPT, validate: validateMietvertragEnvelope },
};

// Inside generateIntelligence function, after the doc_type is known:
if (hasV2Schema(doc_type)) {
  // v2 path: produce envelope via Sonnet with the schema's prompt fragment.
  const v2Config = V2_PROMPTS[doc_type];
  // ... build the full prompt with v2Config.prompt as the per-field section ...
  // ... call Sonnet ...
  // ... parse the response as a JSON object mapping field_id → field_envelope ...
  // ... validate the envelope shape with v2Config.validate ...
  // ... run verifiers per the schema's verifier_refs (overriding absence_state on failure) ...
  // ... write to warehouse.document_extractions_v2 ...
  return; // do NOT write to document_intelligence for v2 docs
}

// Otherwise: existing intelligence-layer logic runs unchanged.
```

The verifier-running step:
- Load `schemas/mietvertrag/schema.yaml` (or import the parsed schema if available — check what gen-schemas.ts produces)
- For each field in the envelope where `absence_state == "present"`, look up the schema field's `verifier_refs` array, fetch each verifier from `VERIFIERS[ref]`, run it
- If a verifier returns `{ passes: false, reason }`:
  - Set the field's `validation_status` to `"failed"`
  - Set `confidence` to `"low"`
  - Optionally override `absence_state` to `"contradicted"` if the failure is semantic (value not in OCR), or `"ambiguous"` if it's structural (wrong format)
  - Store the reason in a `verifier_failures` field on the envelope row OR append to the field envelope itself

### 5. Persistence — write to `warehouse.document_extractions_v2`

The envelope structure to insert (per architecture §3.3):

```typescript
{
  source_document_id: <document_id>,
  doc_type: <doc_type>,
  schema_version: <from schema YAML>,
  prompt_version: <from schema YAML — for v1 launch, same as schema_version>,
  model: "claude-sonnet-4-20250514", // or whatever the current Sonnet model identifier is
  extraction_run_id: <uuid>,
  fields: { <field_id>: <field_envelope>, ... },
  lifecycle: { issue_date, effective_date, signed_date, expiry_date, document_status, supersedes_document_id: null, amended_by_document_id: null, lifecycle_evidence: { ... } },
  human_review_status: "not_reviewed", // default
}
```

The Mietvertrag prompt does NOT currently ask for lifecycle fields explicitly. For Phase 1, the lifecycle can default to:
- `issue_date`: pull from mietbeginn if present
- `effective_date`: same as mietbeginn
- `signed_date`: null (not extracted in launch slice)
- `expiry_date`: from mietende if present, otherwise null
- `document_status`: "active" by default; "draft" if no signature evidence; "cancelled" only on explicit indication
- `supersedes_document_id`: null
- `amended_by_document_id`: null
- `lifecycle_evidence`: null

The point of the lifecycle being optional at launch: it's a structural slot in the envelope, populated more fully in Phase 2. Phase 1 emits enough to be valid but doesn't deeply analyze lifecycle.

### 6. Error handling

The v2 path can fail at several points:
- Sonnet call fails → retry per existing retry logic; if exhausted, write error to job log
- Sonnet returns non-JSON → log raw response, fail the job (do NOT silently produce a malformed envelope)
- Envelope validator rejects the response → log validation errors, fail the job
- Verifier runs on a malformed envelope → catch the error, fail the job gracefully

**Critical**: if the v2 path fails for a document with a v2 schema, do NOT fall back to writing a legacy extraction. The failure should propagate up. Mixing paths on a single document is the recipe for downstream data confusion.

### 7. Deploy the Edge Function

After all the code is in place locally:

```bash
supabase functions deploy process-document
```

The Supabase CLI must be linked (was done in Tier 0). If deployment fails, do NOT proceed to smoke tests — diagnose first.

### 8. Smoke tests (MANDATORY — do not skip)

These tests run against the production Supabase database. They use real documents from the existing dataset.

**Smoke test 1: v2 path produces an envelope**

Pick one Mietvertrag from KO132 (suggested: Lena Everding's Mietvertrag — Apr 2025, simplest case). Re-process it through the pipeline:

```bash
# Find the document ID
psql $DATABASE_URL -c "SELECT id, file_name FROM warehouse.documents WHERE doc_type = 'mietvertrag' AND property_id = (SELECT id FROM \"Property\" WHERE short_code = 'KO132') LIMIT 5;"

# Trigger re-extraction via the pipeline (mechanism depends on existing code —
# probably involves inserting a row into a processing_jobs table or calling an RPC)

# After processing, inspect the v2 envelope
psql $DATABASE_URL -c "SELECT id, doc_type, schema_version, jsonb_pretty(fields) FROM warehouse.document_extractions_v2 WHERE source_document_id = '<lena_doc_id>' ORDER BY created_at DESC LIMIT 1;"
```

Verify the envelope contains:
- All 5 launch-slice fields (kaltmiete, unit_ref, tenant_identity, mietbeginn, mietende)
- Each field has raw_value, normalized_value, evidence quote, confidence, absence_state, validation_status
- `kaltmiete.normalized_value == { amount: 65000, currency: "EUR" }` (€650.00 in minor units)
- `unit_ref.normalized_value == "1.OG"` (Lena is in the 1.OG unit)
- `tenant_identity.normalized_value.name` contains "Lena Everding" or "Everding"
- `mietbeginn.normalized_value == "2025-04-01"` (Lena's lease start)

Also verify NO row was written to legacy `document_extractions` for this document:

```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM warehouse.document_extractions WHERE document_id = '<lena_doc_id>' AND created_at > NOW() - INTERVAL '5 minutes';"
```

Expected: 0.

**Smoke test 2: legacy path still works for non-v2 doc types**

Pick one Rechnung (invoice) from the existing dataset. Re-process it:

```bash
psql $DATABASE_URL -c "SELECT id, file_name FROM warehouse.documents WHERE doc_type = 'rechnung' LIMIT 5;"
# (trigger re-extraction)
psql $DATABASE_URL -c "SELECT jsonb_pretty(extracted_fields) FROM warehouse.document_extractions WHERE document_id = '<rechnung_doc_id>' ORDER BY created_at DESC LIMIT 1;"
```

Verify the legacy `document_extractions` row IS written with vendor_name, amount, invoice_date as today. The format must be identical to the existing legacy format.

Also verify NO v2 envelope row was written:

```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM warehouse.document_extractions_v2 WHERE source_document_id = '<rechnung_doc_id>';"
```

Expected: 0.

**Smoke test 3: both documents render in the inbox**

Open the live URL `https://prop-manage-de.vercel.app/dashboard/warehouse/inbox` and confirm both the Mietvertrag and the Rechnung appear. The triage overlay's dual-read behavior is Task 1.6 — at this point, the Mietvertrag may render with empty fields because Task 1.6's reader hasn't shipped yet. THAT IS EXPECTED for this task. The Rechnung must render correctly (legacy path).

If any of the three smoke tests fails: **do not deploy further, do not open the PR**. Diagnose first. Roll back the deployment if needed: `git revert <commit>` + `supabase functions deploy process-document`.

### 9. Update ARCHITECTURE_STATE.md

Add a section describing:

- Dual-path migration is now live: doc types in `V2_SCHEMA_DOC_TYPES` go through v2 envelope, all others use the legacy path
- Registry at `schemas/index.ts` is hand-maintained — adding a doc type requires explicit edit
- Currently only `mietvertrag` is in the registry
- Step 5 (Haiku) skipped for v2 doc types; runs unchanged for legacy doc types
- Step 8b (Sonnet) branches: v2 envelope for registered types, intelligence layer for others
- Verifiers from Task 1.3 are now wired into the v2 path
- Triage UI is NOT yet updated — that's Task 1.6 (next)
- Edge Function deployment is required after merging (manual step, not automatic via git push)

### 10. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.5-v2-envelope-path

# (write the code, deploy, run smoke tests, update ARCHITECTURE_STATE.md)

git add schemas/index.ts supabase/functions/process-document/index.ts ARCHITECTURE_STATE.md
git commit -m "v2: wire envelope path alongside legacy Haiku Step 5 (Task 1.5)

Dual-path pipeline per architecture §11.2:
- Doc types in V2_SCHEMA_DOC_TYPES skip Haiku Step 5, run Sonnet Step 8b
  with the schema's prompt fragment, validate envelope, run verifiers,
  write to warehouse.document_extractions_v2
- All other doc types continue through the legacy path unchanged

Registry hand-maintained at schemas/index.ts. Currently includes only
mietvertrag. New doc types added by deliberate edit, not by schema
YAML existence.

Verifier failures override absence_state to contradicted/ambiguous,
downgrade confidence, set validation_status.

Smoke tests pass:
1. Lena Everding Mietvertrag (KO132 1.OG) produces v2 envelope with all
   5 launch-slice fields; no legacy extraction row written.
2. Rechnung produces legacy extraction with vendor_name/amount/
   invoice_date unchanged; no v2 envelope written.
3. Both render in inbox (Mietvertrag will render fully after Task 1.6
   ships dual-read in triage overlay).

Edge Function deployed via: supabase functions deploy process-document"

git push -u origin feature/task-1.5-v2-envelope-path
```

Report back the branch URL AND the smoke-test outputs. Nils opens the PR.

## Acceptance gates (verify before reporting completion)

- `schemas/index.ts` exists with `V2_SCHEMA_DOC_TYPES = new Set(["mietvertrag"])`
- `supabase/functions/process-document/index.ts` modified to add the dual-path branch
- Edge Function deployed: confirmed via `supabase functions list` showing recent deployment timestamp
- Smoke test 1 passes: Lena's Mietvertrag produces v2 envelope, no legacy extraction row
- Smoke test 2 passes: a Rechnung produces legacy extraction, no v2 envelope
- Smoke test 3 passes: both render in inbox (Mietvertrag fields may not display fully until Task 1.6)
- ARCHITECTURE_STATE.md updated
- All regression tests still pass (claim store, envelope, schemas, domain knowledge, verifiers, generator check)
- `npx tsc --noEmit` silent
- Branch pushed to origin

## Constraints

- Do NOT remove or modify the Haiku Step 5 code path for non-v2 doc types. The ~116 other doc types depend on it.
- Do NOT auto-discover the registry from schemas directory structure. The registry is hand-maintained for a reason.
- Do NOT add Übergabeprotokoll to the registry — its schema YAML is still stubbed (no launch-slice fields). Only Mietvertrag for now.
- Do NOT silently fall back to legacy extraction if the v2 path fails. Fail the job loudly.
- Do NOT skip the smoke tests. They are the only check that catches "I broke extraction for 116 doc types overnight."
- Do NOT skip the Edge Function deploy. `git push` does not deploy.
- Do NOT modify `document_intelligence` writes for non-v2 doc types. Intelligence layer stays for legacy.
- Do NOT push directly to main. Use feature branch + PR workflow.
- Pipe git commands through `| cat`.

## Risk acknowledgment

This task touches the production pipeline. The blast radius is "extraction for all uploaded documents." Read the existing code carefully before modifying. Use the smoke tests as the gate — not "the code compiles" or "the tests pass" but "real documents flow through both paths correctly."

If any smoke test fails: roll back the deployment immediately (revert the commit, redeploy the previous version) and report the failure. Do not attempt to fix forward under time pressure — the legacy path must keep working.
