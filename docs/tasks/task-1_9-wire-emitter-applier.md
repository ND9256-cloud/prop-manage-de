# Task 1.9 — Wire Step 8b → emitter → applier (HTTP bridge)

**Task type:** t2 M (logic + DB writes via HTTP bridge, smoke-test required)

**Branch:** `feature/task-1.9-wire-emitter-applier`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 1.9 acceptance criteria
- Architecture §5.5.7 ("Synchronous, transactional" applies to applier internals; cross-runtime bridging via HTTP is permitted because the applier's transaction is self-contained and idempotent via SELECT-before-INSERT)
- Task 1.7 emitter: `src/lib/emitters/mietvertrag.ts`
- Task 1.8 applier: `src/lib/claim-store/applier.ts`

**Phase 1 success criterion this task moves toward:** Same as 1.7/1.8 — `rent_for_unit("KO132","1.OG")` returns €650. This task closes the loop: when Step 8b finishes writing the v2 envelope, the emitter runs, the applier inserts claims, and the resolver (Task 1.10) can read them.

---

## The cross-runtime constraint

The Edge Function runs on **Deno**. The applier uses **Prisma**, which is Node-only. They can't share a process. The bridge: after Step 8b commits the envelope, the Edge Function HTTP-POSTs to a new Node API route that loads the envelope, runs the emitter, and calls `applyEmission`. The applier's transaction is fully contained inside the Node route.

This is permitted by architecture §5.5.7's "Synchronous, transactional" rule because:
- The applier still runs in a single Postgres transaction (the bridging is HTTP, not DB)
- The applier is idempotent — retrying the HTTP call after a network failure inserts no duplicate claims (SELECT-before-INSERT keyed on `(source_extraction_run_id, subject, predicate, source_field_path)`)
- The pipeline log records both the extraction's `extraction_run_id` and the HTTP call result, so any inconsistency is detectable

Trade-off accepted: a single same-region HTTPS round-trip (~50ms) in exchange for not duplicating applier logic in Deno.

---

## Scope

1. **Emitter registry** — `src/lib/emitters/index.ts` maps `doc_type → { fn, version }`. Currently one entry: `mietvertrag`.
2. **New API route** — `src/app/api/pipeline/apply-emission/route.ts`. POST. Body: `{ extraction_run_id }`. Loads envelope, runs emitter, calls `applyEmission`, returns the `ApplyResult` plus a `status` field.
3. **Edge Function patch** — after Step 8b's `INSERT INTO warehouse.document_extractions_v2` commits, POST to the new route with the new row's `extraction_run_id`. Log the response into the existing pipeline log entry.
4. **Internal-secret auth** — both sides read `PIPELINE_INTERNAL_SECRET`. Route rejects requests missing or mismatching the header.
5. **Smoke test** — re-extract Lena Everding mietvertrag end-to-end, assert two claims appear in `warehouse.claims`.
6. **ARCHITECTURE_STATE.md update.**

---

## Out of scope

- Multi-emitter support beyond mietvertrag — registry pattern is in place but only mietvertrag is registered. Other emitters land per their own tasks.
- Evidence wiring — `EmitterContext.evidence_id_for_field` returns `null` for all fields. Evidence-row population is a separate task.
- Retry/backoff on transient HTTP failures — Phase 1 logs the failure and proceeds (the envelope persists; applier can be replayed via a manual /api call later). Robust retry is a hardening follow-up.
- Pipeline log schema changes — write the apply result into the existing log entry's `details` JSONB; no new columns.
- Backfill for already-extracted envelopes — out of scope. A separate script (post-Phase-1) walks `warehouse.document_extractions_v2`, calls the new route for each row, and reports.

---

## Files touched

- `src/lib/emitters/index.ts` — new, registry mapping doc_type → emitter + version
- `src/app/api/pipeline/apply-emission/route.ts` — new, the Node API endpoint
- `src/tests/api/apply-emission.test.ts` — new, integration test against the route
- `supabase/functions/process-document/index.ts` — patch: after Step 8b, POST to the new route
- `.env.local.example` — append `PIPELINE_INTERNAL_SECRET=`
- `ARCHITECTURE_STATE.md` — append a section on the v2 pipeline wiring

**NOT touched:**
- Existing emitter files (`src/lib/emitters/mietvertrag.ts`, `types.ts`) — frozen at Task 1.7
- Existing applier files (`src/lib/claim-store/*`) — frozen at Task 1.8
- DB schema — no migrations
- Other API routes

---

## Repo conventions (recap)

- npm (not pnpm), tsc clean, lint clean
- Tests run via `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>` (Task 1.8 lesson — without this, `dotenv/config` looks for `.env` and DB env vars don't load)
- Branch protection on main, feature branch + PR
- Single descriptive commit per PR
- Pipe potentially-paged commands through `| cat`

---

## Step 1 — Emitter registry

Create `src/lib/emitters/index.ts`:

```typescript
// Emitter registry. Maps doc_type → { emitter function, version }.
// The version string is written to DerivationRecord.emitter_version by
// the applier; it captures which version of the emitter produced the claims,
// so a future emitter bump can find affected claims via:
//
//   SELECT output_id FROM warehouse.derivation_records
//   WHERE emitter_version = 'X.Y.Z' AND output_type = 'claim'
//
// Bump the version when emission semantics change (new claim kind, changed
// value shape, new field consumed). Don't bump for non-behavioral changes.

import { emitMietvertragClaims } from "./mietvertrag.ts";
import type { EmissionResult, EmitterContext } from "./types.ts";

export type EmitterFn = (envelope: any, context: EmitterContext) => EmissionResult;

export interface EmitterEntry {
  fn: EmitterFn;
  version: string;
}

export const EMITTERS: Record<string, EmitterEntry> = {
  mietvertrag: { fn: emitMietvertragClaims as EmitterFn, version: "1.0.0" },
};

export function getEmitter(doc_type: string): EmitterEntry | null {
  return EMITTERS[doc_type] ?? null;
}
```

The `as EmitterFn` cast is needed because each emitter declares its specific envelope type (e.g. `MietvertragEnvelope`), but the registry surface uses `any` for the envelope. Type safety lives inside each emitter; the registry is a runtime dispatcher.

---

## Step 2 — Apply-emission API route

Create `src/app/api/pipeline/apply-emission/route.ts`:

```typescript
// POST /api/pipeline/apply-emission
//
// Internal-only endpoint called by the Deno Edge Function after Step 8b
// commits a v2 envelope. Loads the envelope, dispatches to the appropriate
// emitter, calls the applier.
//
// Auth: x-internal-secret header must equal env.PIPELINE_INTERNAL_SECRET
// (timing-safe comparison).
//
// Body: { extraction_run_id: string }
//
// Response:
//   200 { status: "applied", apply_result: ApplyResult, doc_type, schema_version }
//   200 { status: "no_emitter_for_doc_type", doc_type }
//   400 { error: "..." }   — invalid body, envelope not found, etc.
//   401 { error: "unauthorized" }
//   500 { error: "..." }   — applier threw

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getEmitter } from "@/lib/emitters";
import { applyEmission } from "@/lib/claim-store/applier";
import type { ApplyContext } from "@/lib/claim-store/types";

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. We pad both to a fixed
  // length so length itself doesn't leak via early-return.
  const aBuf = Buffer.from(a.padEnd(128, "\0"));
  const bBuf = Buffer.from(b.padEnd(128, "\0"));
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

export async function POST(req: NextRequest) {
  // --- Auth -----------------------------------------------------------------
  const secret = req.headers.get("x-internal-secret");
  const expected = process.env.PIPELINE_INTERNAL_SECRET;
  if (!secret || !expected || !constantTimeEqual(secret, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- Body parse -----------------------------------------------------------
  let body: { extraction_run_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const extraction_run_id = body.extraction_run_id;
  if (!extraction_run_id || typeof extraction_run_id !== "string") {
    return NextResponse.json(
      { error: "extraction_run_id required" },
      { status: 400 }
    );
  }

  // --- Load envelope --------------------------------------------------------
  const envelopeRows = await prisma.$queryRaw<
    {
      id: string;
      source_document_id: string;
      doc_type: string;
      schema_version: string;
      extraction_run_id: string;
      fields: any;
      lifecycle: any;
    }[]
  >`
    SELECT id, source_document_id, doc_type, schema_version,
           extraction_run_id, fields, lifecycle
    FROM warehouse.document_extractions_v2
    WHERE extraction_run_id = ${extraction_run_id}::uuid
    LIMIT 1
  `;
  if (envelopeRows.length === 0) {
    return NextResponse.json(
      { error: `no envelope for extraction_run_id=${extraction_run_id}` },
      { status: 400 }
    );
  }
  const envelope = envelopeRows[0];

  // --- Resolve emitter ------------------------------------------------------
  const entry = getEmitter(envelope.doc_type);
  if (!entry) {
    console.warn(
      `[apply-emission] no_emitter_for_doc_type doc_type=${envelope.doc_type} extraction_run_id=${extraction_run_id}`
    );
    return NextResponse.json({
      status: "no_emitter_for_doc_type",
      doc_type: envelope.doc_type,
    });
  }

  // --- Look up property + org for context ----------------------------------
  const propertyRows = await prisma.$queryRaw<
    { property_id: string; organizationId: string }[]
  >`
    SELECT d."propertyId" AS property_id, p."organizationId"
    FROM warehouse.documents d
    JOIN "Property" p ON p.id = d."propertyId"
    WHERE d.id = ${envelope.source_document_id}::uuid
    LIMIT 1
  `;
  if (propertyRows.length === 0) {
    return NextResponse.json(
      { error: `no property mapping for document=${envelope.source_document_id}` },
      { status: 400 }
    );
  }
  const { property_id, organizationId } = propertyRows[0];

  // --- Run emitter ----------------------------------------------------------
  // The emitter is pure. It reads the envelope subset it understands;
  // schema_version/doc_type are passed through for completeness.
  const emissionResult = entry.fn(
    {
      doc_type: envelope.doc_type,
      schema_version: envelope.schema_version,
      fields: envelope.fields,
      lifecycle: envelope.lifecycle,
    },
    {
      property_id,
      source_document_id: envelope.source_document_id,
      source_extraction_run_id: envelope.extraction_run_id,
      evidence_id_for_field: () => null, // evidence wiring is a future task
    }
  );

  // --- Apply ---------------------------------------------------------------
  const applyContext: ApplyContext = {
    property_id,
    org_id: organizationId,
    extraction_run_id: envelope.extraction_run_id,
    emitter_version: entry.version,
  };

  try {
    const apply_result = await applyEmission(emissionResult, applyContext);
    return NextResponse.json({
      status: "applied",
      apply_result,
      doc_type: envelope.doc_type,
      schema_version: envelope.schema_version,
    });
  } catch (e: any) {
    console.error(
      `[apply-emission] applier threw extraction_run_id=${extraction_run_id}`,
      e
    );
    return NextResponse.json(
      { error: e.message ?? String(e) },
      { status: 500 }
    );
  }
}
```

**Path assumptions:** `@/lib/db` exports `prisma`. `@/lib/emitters` resolves to `src/lib/emitters/index.ts`. `@/lib/claim-store/applier` resolves to `src/lib/claim-store/applier.ts`. These match the Task 1.7/1.8 layout.

**`warehouse.documents.propertyId`** — verify the actual column name on the documents table; if it's different (e.g. `property_id` snake_case), adjust the JOIN query. The grep below catches this before commit:

```bash
grep -E "propertyId|property_id" supabase/migrations/*documents*.sql | head -5
```

If the column is snake_case, change the SELECT to `d.property_id AS property_id, p."organizationId"`.

---

## Step 3 — Edge Function patch

Modify `supabase/functions/process-document/index.ts`. Find the block where Step 8b completes (the `INSERT INTO warehouse.document_extractions_v2` returning the new row, after which the existing pipeline log entry is written). Immediately after the envelope insert succeeds, before writing the pipeline log entry, add:

```typescript
// --- Step 9: bridge to Node-side emitter + applier -----------------------
// After the v2 envelope is committed, POST to the Node API route which
// loads the emitter, produces claims, and runs the applier. Phase 1
// failure mode: if the bridge call fails, log and proceed — the envelope
// persists; a manual retry script can replay later.

let applyResult: any = null;
let applyStatus: string = "skipped_no_url";

const appUrl = Deno.env.get("NEXT_PUBLIC_APP_URL");
const internalSecret = Deno.env.get("PIPELINE_INTERNAL_SECRET");

if (appUrl && internalSecret) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s hard cap
  try {
    const bridgeRes = await fetch(`${appUrl}/api/pipeline/apply-emission`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ extraction_run_id: extractionRunId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const bridgeBody = await bridgeRes.json();
    if (!bridgeRes.ok) {
      applyStatus = "bridge_http_error";
      applyResult = { http_status: bridgeRes.status, body: bridgeBody };
      console.warn("[step9] bridge HTTP error", bridgeRes.status, bridgeBody);
    } else {
      applyStatus = bridgeBody.status;
      applyResult = bridgeBody;
    }
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = (err as any)?.name === "AbortError";
    applyStatus = isTimeout ? "bridge_timeout" : "bridge_network_error";
    applyResult = { error: String(err) };
    console.warn(`[step9] ${applyStatus}`, err);
  }
} else {
  console.warn("[step9] NEXT_PUBLIC_APP_URL or PIPELINE_INTERNAL_SECRET missing; skipping apply");
}
```

Then in the existing pipeline log entry's details, include:

```typescript
details: {
  // ... existing fields ...
  step9_apply_status: applyStatus,
  step9_apply_result: applyResult,
}
```

The existing log entry already lives at the end of the document-processing flow; no new log row needed. Just augment the `details` JSONB.

**Important:** the Edge Function must NOT throw or fail the pipeline because of a bridge error. The envelope is already persisted, claims can be applied later. Phase 1 prioritizes envelope durability over claim-store completeness.

---

## Step 4 — Env wiring

1. Add to `.env.local.example`:
   ```
   # Shared secret for Edge Function → Node API bridge (Task 1.9)
   PIPELINE_INTERNAL_SECRET=
   ```
2. Generate a real secret locally (32+ random bytes), add to `.env.local` AND to the Edge Function's environment via `supabase secrets set PIPELINE_INTERNAL_SECRET=<value>`, and to Vercel project env (production + preview).
3. `NEXT_PUBLIC_APP_URL` must point at the deployed Vercel URL in production env (already set per probe). In local dev, point at `http://localhost:3000` and test against a running `npm run dev` server.

---

## Step 5 — Integration test

Create `src/tests/api/apply-emission.test.ts`. The test runs against a running Next.js dev server (`npm run dev`) on `localhost:3000`. It uses the real DB.

Setup: pick an existing real mietvertrag extraction_run_id (the probe earlier returned `03159bee-801b-4f24-9a91-b1007ff4d38d` for Lena). Use that. The test:

1. Cleans up any pre-existing claims for that extraction_run_id (raw SQL, requires `PIPELINE_TEST_ALLOW_DELETE=1` env to bypass the trigger — see "Notes" below for the cleanup approach).
2. POSTs to `http://localhost:3000/api/pipeline/apply-emission` with `{ extraction_run_id: "<known-mietvertrag-run>" }` and the correct header.
3. Asserts response status = 200, body.status = "applied".
4. Queries `warehouse.claims` for the new claims (kaltmiete + tenant_active).
5. Asserts: 2 inserted, correct subject (`unit:1.OG`), correct value (kaltmiete €650 = 65000 cents, tenant Everding,Lena).

Skip the test gracefully if `process.env.RUN_INTEGRATION_TESTS !== "1"`. CI doesn't have a running dev server. Local-only.

**Cleanup approach:** the immutability trigger blocks DELETE. For test cleanup, the simplest path is: pick a unique test extraction_run_id (not a real one), insert a synthetic envelope row before the test, run apply, then leave the data in place (it's tagged with an obvious test marker). Document this in the test file's header comment. Over time test runs accumulate harmless rows; production reporting can filter them out by extraction_run_id pattern.

Alternative (preferred for this task): instead of running against a real envelope, the test constructs a synthetic one with a UUIDv4 extraction_run_id, inserts it, calls the API, asserts the result. No cleanup needed because the synthetic envelope is tagged and easy to spot. Outline:

```typescript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/db";

const SECRET = process.env.PIPELINE_INTERNAL_SECRET!;
const BASE = process.env.APP_URL_FOR_TEST ?? "http://localhost:3000";

if (process.env.RUN_INTEGRATION_TESTS !== "1") {
  console.log("apply-emission integration test skipped (set RUN_INTEGRATION_TESTS=1)");
  process.exit(0);
}

const extraction_run_id = randomUUID();
const source_document_id = process.env.TEST_DOCUMENT_ID; // real warehouse.documents row id
assert.ok(source_document_id, "TEST_DOCUMENT_ID env required");

// Step 1: insert a synthetic mietvertrag envelope mirroring Lena's shape
await prisma.$executeRaw`
  INSERT INTO warehouse.document_extractions_v2
    (source_document_id, doc_type, schema_version, prompt_version, model,
     extraction_run_id, fields, lifecycle, human_review_status)
  VALUES
    (${source_document_id}::uuid, 'mietvertrag', '2026-05-21-v1', '2026-05-21-v1',
     'test-synthetic', ${extraction_run_id}::uuid,
     ${JSON.stringify({
        kaltmiete: { absence_state: "present", confidence: "high", raw_value: "650",
                     normalized_value: { amount: 65000, currency: "EUR" },
                     evidence: [{ page: 1, quote: "synthetic" }] },
        unit_ref:  { absence_state: "present", confidence: "high", raw_value: "1",
                     normalized_value: "1.OG", evidence: [{ page: 1, quote: "synthetic" }] },
        tenant_identity: { absence_state: "present", confidence: "high",
                           raw_value: "Test, Tenant",
                           normalized_value: { name: "Test, Tenant", is_legal_entity: false, legal_form: null },
                           evidence: [{ page: 1, quote: "synthetic" }] },
        mietbeginn: { absence_state: "present", confidence: "high", raw_value: "01.01.2025",
                      normalized_value: "2025-01-01",
                      evidence: [{ page: 1, quote: "synthetic" }] },
        mietende: { absence_state: "not_applicable", confidence: "high",
                    raw_value: null, normalized_value: null, evidence: [] },
     })}::jsonb,
     ${JSON.stringify({ document_status: "active", effective_date: "2025-01-01" })}::jsonb,
     'not_reviewed')
`;

// Step 2: POST the route
const res = await fetch(`${BASE}/api/pipeline/apply-emission`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-secret": SECRET },
  body: JSON.stringify({ extraction_run_id }),
});
const body = await res.json();

assert.equal(res.status, 200, `route returned ${res.status}: ${JSON.stringify(body)}`);
assert.equal(body.status, "applied");
assert.equal(body.apply_result.inserted_claim_ids.length, 2);

// Step 3: verify claims landed
const claims = await prisma.$queryRaw<any[]>`
  SELECT predicate, value FROM warehouse.claims
  WHERE source_extraction_run_id = ${extraction_run_id}::uuid
  ORDER BY predicate
`;
assert.equal(claims.length, 2);
assert.equal(claims[0].predicate, "kaltmiete");
assert.equal(claims[0].value.amount, 65000);
assert.equal(claims[1].predicate, "tenant_active");
assert.equal(claims[1].value.tenants[0].name, "Test, Tenant");

console.log("✓ apply-emission integration: synthetic envelope → 2 claims inserted");
await prisma.$disconnect();
```

The `TEST_DOCUMENT_ID` env var **must** reference a `warehouse.documents` row whose `propertyId` is a **dedicated test property**, NOT a real production property (KO132, HHS55, etc.). Reason: the test inserts synthetic claims under that property's id. Since `warehouse.claims` cannot be DELETEd (trigger), those claims persist and would surface in any future `rent_for_unit` query against that property. Tagging via `model="test-synthetic"` only filters envelopes, not the downstream claims.

Setup steps for first-time test run:
1. Create a dedicated `Property` row in the test org with shortcode `TEST_ISOLATED` (or similar).
2. Create one `warehouse.documents` row attached to it.
3. Record the document UUID as `TEST_DOCUMENT_ID` in `.env.local`.
4. Never query that property via `rent_for_unit` in production reporting.

Document this requirement in the test file's header comment as a hard precondition.

---

## Step 6 — ARCHITECTURE_STATE.md update

Append:

```markdown
## v2 pipeline wiring (Task 1.9+)

The Deno Edge Function (`supabase/functions/process-document/index.ts`)
calls a Node-side API route (`POST /api/pipeline/apply-emission`) after
Step 8b commits the v2 envelope. The Node route looks up the appropriate
emitter from the registry, runs it, and calls `applyEmission` (Task 1.8).

**Why HTTP, not direct Deno DB writes:** the applier is Prisma-based
(Node-only). Reimplementing it in Deno would duplicate ~500 lines of
closure logic and create a drift surface. The HTTP bridge adds ~50ms
per document but keeps a single source of truth for claim emission
and closure semantics.

**Failure mode:** if the bridge call fails (HTTP error, network, or 5s timeout), the
Edge Function logs and proceeds. The envelope persists; claims can be
applied later via a manual replay script. Phase 1 prioritizes envelope
durability over claim-store completeness. `step9_apply_status` values:
`applied`, `no_emitter_for_doc_type`, `bridge_http_error`, `bridge_network_error`,
`bridge_timeout`, `skipped_no_url`.

**Auth:** `x-internal-secret` header. Both sides read `PIPELINE_INTERNAL_SECRET`
from env. The route returns 401 on mismatch.

**Registered emitters:**
- `mietvertrag` → `emitMietvertragClaims` (Task 1.7), version `1.0.0`

**Pending wiring follow-ups (not Task 1.9):**
- Evidence-row population (`EmitterContext.evidence_id_for_field` currently
  returns null for all fields)
- Retry/backoff on transient bridge failures
- Backfill script for already-extracted envelopes
- Multi-emitter registry entries as other doc-type emitters land
```

---

## Step 7 — Verify

Pre-flight:

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
```

tsc must be clean.

Confirm document-table column name:

```bash
grep -E "propertyId|property_id" supabase/migrations/*documents*.sql | head -5
```

If the column is snake_case, patch the JOIN in Step 2 before commit.

Run the existing test suite to confirm no regression:

```bash
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" | tail -3 || break
done
```

All existing tests still green.

Then start a dev server in one shell:

```bash
npm run dev
```

And in another shell, set the integration env and run the new test:

```bash
RUN_INTEGRATION_TESTS=1 \
  TEST_DOCUMENT_ID=<real-document-uuid-from-warehouse.documents> \
  PIPELINE_INTERNAL_SECRET=<your-secret> \
  DOTENV_CONFIG_PATH=.env.local \
  npx tsx -r dotenv/config src/tests/api/apply-emission.test.ts
```

Should print `✓ apply-emission integration: synthetic envelope → 2 claims inserted`.

---

## Step 8 — Smoke test against a live re-extraction

After deploy to Vercel preview + Edge Function deploy:

1. Pick an existing mietvertrag document in production. Confirm its `extraction_run_id` is known.
2. Use the existing re-extraction trigger (Discord or pipeline endpoint) to re-process it.
3. Wait for the pipeline to complete.
4. Query:
   ```sql
   SELECT predicate, subject, value, valid_from
   FROM warehouse.claims
   WHERE source_extraction_run_id = '<new-extraction-run-id>'::uuid;
   ```
5. Confirm 2 rows (kaltmiete + tenant_active) with correct values for that document.
6. Confirm pipeline log `details.step9_apply_status` = `"applied"`.

If any step fails, do NOT merge — debug first. Manually-applied envelopes are a backfill problem, not a smoke-test pass.

---

## Step 9 — PR

```bash
git checkout -b feature/task-1.9-wire-emitter-applier
git add src/lib/emitters/index.ts \
        src/app/api/pipeline/apply-emission/route.ts \
        src/tests/api/apply-emission.test.ts \
        supabase/functions/process-document/index.ts \
        .env.local.example \
        ARCHITECTURE_STATE.md
git commit -m "feat(pipeline): wire Step 8b → emitter → applier via HTTP bridge (Task 1.9)

- src/lib/emitters/index.ts: registry mapping doc_type → emitter + version
- src/app/api/pipeline/apply-emission/route.ts: Node API endpoint, loads envelope,
  runs emitter, calls applyEmission; x-internal-secret auth
- supabase/functions/process-document/index.ts: after Step 8b commits, POST
  to the Node route with extraction_run_id; log result into pipeline log
  details. Failure here does not fail the pipeline.
- src/tests/api/apply-emission.test.ts: integration test with synthetic envelope
- .env.local.example: PIPELINE_INTERNAL_SECRET placeholder
- ARCHITECTURE_STATE.md: v2 pipeline wiring section"
git push -u origin feature/task-1.9-wire-emitter-applier
```

PR via GitHub web UI:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-1.9-wire-emitter-applier
```

Wait for CI. All checks green → set Vercel + Edge Function env vars (Step 4 item 2) → merge → smoke test (Step 8).

---

## Definition of done

- [ ] Branch pushed, PR opened
- [ ] CI green (existing tests + tsc + tenant-isolation + migration-drift + ARCHITECTURE_STATE gate)
- [ ] `npx tsc --noEmit` silent
- [ ] Integration test passes locally against `npm run dev` (synthetic envelope → 2 claims)
- [ ] ARCHITECTURE_STATE.md section added
- [ ] `PIPELINE_INTERNAL_SECRET` set in Vercel env (production + preview) and Supabase function env
- [ ] Single descriptive commit, PR merged into main
- [ ] **Smoke test (Step 8) green** against a live re-extracted mietvertrag — 2 claims appear with correct values
- [ ] Pipeline log shows `step9_apply_status: "applied"` for the smoke-test document

---

## Notes for reviewer

**HTTP bridge instead of Deno-side applier.** Reimplementing the applier in Deno would duplicate ~500 lines of transactional logic with three close_modes, three blocker checks, fuzzy tenant matching, and DerivationRecord writes. Each one of those would drift independently. The HTTP bridge adds latency but keeps the applier as the single source of truth. Trade is correct for Phase 1 — when scale demands sub-50ms emission, revisit.

**Bridge failure doesn't fail the pipeline.** The envelope is the durable artifact. Claims can always be re-derived from the envelope by replaying the bridge call. If the pipeline failed on bridge errors, a Vercel cold-start or rate-limit could silently lose envelopes. The asymmetry (envelope blocking, claims best-effort) is intentional Phase-1 hedge.

**Schema_version is read from the row, not validated against the registry.** If a schema_version drift occurs (e.g., the emitter expects `2026-05-21-v1` but the row is `2026-05-11-v1`), the emitter's existing optional-field checks handle it — fields it doesn't recognize are ignored; missing fields trigger the load-bearing-field guards and the result is empty. Future: registry could declare per-schema-version compatibility and explicitly route to versioned emitters.

**Test uses synthetic envelope, not Lena's real one.** Repeatable across runs. Lena's real envelope's `extraction_run_id` is fixed; running the test twice against it would hit the applier's idempotency check and skip both claims on the second run — making the test's "2 inserted" assertion fail. The synthetic envelope path is deterministic and replayable.

**Trigger-blocked DELETE means accumulated test rows.** The integration test inserts a synthetic envelope and never deletes it (the immutability trigger blocks DELETE on `warehouse.document_extractions_v2` and `warehouse.claims`). Over time, test rows accumulate. Mitigations: (a) tag test envelopes with `model = "test-synthetic"` so production reporting can filter them out; (b) the test runs only when `RUN_INTEGRATION_TESTS=1`, so CI doesn't auto-accumulate. A future hardening task can add a `--cleanup-test-rows` admin endpoint that uses service_role to truncate test-marked rows.

**The route resolves property_id and org_id from `warehouse.documents`.** This requires that every envelope row's `source_document_id` references a row in `warehouse.documents` with a valid `propertyId`. If a future ingestion path produces orphan envelopes (no document), the route returns 400. Phase 1 doesn't have orphans; flag if the assumption breaks.
