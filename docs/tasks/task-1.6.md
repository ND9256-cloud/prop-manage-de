# Task 1.6 — Triage overlay dual-read

Task type: t2 M (logic + UI, requires review)

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §3.1 (envelope shape), §11 (dual-path migration plan)

Code touched:
- `src/lib/warehouse-actions.ts` — `getTriageDocument()` function at line 1563. Add v2 envelope fetch + decision logic.
- `src/components/warehouse/triage-overlay.tsx` — render v2 envelope fields when present; show "Legacy-Format" badge when falling back; add "Re-extract" button for legacy docs that have a v2 schema available.
- `src/lib/extraction-display.ts` — NEW shared helper: maps v2 envelope (typed normalized_value) to display strings.
- `src/tests/triage-document-shape.test.ts` — NEW assertion test for the action return shape (no DB; pure JSON fixture).

NOT touched in this task:
- Parent components (`inbox-table.tsx`, `property-costs.tsx`, `category-documents.tsx`) — they only pass `documentId`; nothing changes for them.
- The Edge Function or the v2 pipeline — already done in Tasks 1.5 + 1.5b.
- The legacy `document_extractions` schema or path — must remain readable.
- `updateExtractionField()` — only writes to legacy `document_extractions`; intentionally NOT extended to v2 (v2 envelopes are append-only per architecture §3.1). For v2 docs, the overlay's edit UI must be DISABLED (read-only) with a tooltip explaining that v2 envelopes are immutable. Editing v2 will come later (probably as a "Re-extract" or "Adjudicate" flow, not in-place edit).

## Context

Phase 1 Tasks 1.5 + 1.5b are complete. Lena Everding's Mietvertrag (`f7c3e663-11bf-4b91-947c-9136df9eefae`) has a v2 envelope at `warehouse.document_extractions_v2` with all 5 fields correctly extracted (kaltmiete €650, unit_ref 1.OG, tenant Everding/Lena, mietbeginn 2025-04-01, mietende not_applicable).

But the user-facing triage overlay still reads from `document_extractions` (legacy Haiku) — so Lena's overlay shows the OLD extracted fields, not the v2 envelope. Task 1.6 wires the overlay to prefer v2 when present, with a graceful fallback to legacy.

## Decision rule

For each document the overlay loads:

1. Query `warehouse.document_extractions_v2` for the latest row with `source_document_id = documentId`. Use the `(source_document_id, created_at DESC)` index. Take the single most recent row.
2. If a row exists: this is a "v2 document". Render the v2 envelope fields in the EXTRAHIERTE FELDER section. Show no badge (v2 is the new normal).
3. If no v2 row exists: fall back to the legacy `document_extractions` fetch as today. Show a small "Legacy-Format" badge near the EXTRAHIERTE FELDER header. If the document's `doc_type` is one of the v2-enabled types (currently just `mietvertrag` — read this list from `schemas/index.ts` if it's importable in the action, otherwise hardcode `['mietvertrag']` with a TODO), show a "Neu extrahieren" (Re-extract) button next to the legacy badge.
4. NEVER render both. The decision is binary: v2 present → v2 shown; v2 absent → legacy shown.

The Re-extract button enqueues a new processing job for the document. Implementation: a new server action `requeueDocumentExtraction(documentId)` that:
- Validates the document exists and belongs to the org
- Inserts a row into `warehouse.processing_jobs` with `status='queued'`, `document_id=documentId`, `org_id=orgId`, `created_at=now()`
- Returns `{ jobId, error: null }` on success
- Audit-logs the event (`re_extraction_requested` event type — add to AuditEventType enum if not present)

The button shows a brief inline status after click: "In Warteschlange..." → after ~30s the overlay can be refreshed and the v2 envelope appears. For simplicity, do NOT poll — just show the status and let the user refresh manually or close+reopen.

## Why dual-read instead of migration

Architecture §11 mandates dual-path during the transition: legacy docs keep working without forcible re-extraction. Re-extraction is opt-in via the button. This means:
- Old documents that haven't been re-extracted continue to show legacy fields.
- Newly-uploaded mietvertrag documents go through the v2 pipeline and show v2 fields.
- Users can opt into v2 for any old mietvertrag by clicking Re-extract.

No mass migration. No data loss. Legacy fields remain visible until the document is intentionally re-extracted.

## Repo conventions

- npm (not pnpm)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Pipe potentially-paged commands through `| cat`
- Branch protection enforced — do NOT push to main; PR pattern only
- UI language is German (approved English loanwords: Dashboard, Inbox, Export, Upload, Download, CSV, PDF, E-Mail). Use "Legacy-Format" and "Neu extrahieren" for the new UI strings; "Format" is German anyway.

## Steps

### 1. Write the shape test FIRST (no DB, pure fixture)

Path: `src/tests/triage-document-shape.test.ts`

Tests that exercise the `getTriageDocument` return shape WITHOUT hitting the database. Mock the action by extracting the shape-building logic into a pure helper, OR use a JSON fixture and assert against the renderer's expectations.

The simpler approach: write the test against `extraction-display.ts` (Step 2 below). The helper takes a v2 envelope (or legacy fields) and returns a normalized list of `{label, value, fieldName, severity?, absence_state?}` rows ready for the overlay to render. Test:

- v2 envelope with Lena's exact fields → renders 5 rows: Einheit "1.OG", Kaltmiete "650,00 EUR", Mietbeginn "01.04.2025", Mieter "Everding, Lena", (no Mietende row because absence_state="not_applicable")
- v2 envelope with mietende present → renders 6 rows including Mietende
- v2 envelope with absence_state="absent" on kaltmiete → renders Kaltmiete row with "— (nicht im Dokument)" display
- Legacy extraction with `extracted_fields: {amount, vendor_name, invoice_date}` (Rechnung shape) → renders Betrag, Lieferant, Rechnungsdatum
- Legacy extraction with `extracted_fields: {rent_cold, lease_start}` (lease shape) → renders Kaltmiete, Mietbeginn

~10–15 assertions. Use the same `expect`/`shouldPass` harness as `verifiers.test.ts` and `envelope-validator.test.ts`. Pure function tests — no `tsx -r dotenv/config` needed.

This test exists primarily to lock in the renderer contract. If a future schema or label changes break it, the test fails before deploying.

Run the test against an empty `extraction-display.ts` first to confirm it fails. Then implement the helper.

### 2. Implement `src/lib/extraction-display.ts`

Pure module. No DB, no Supabase, no Prisma imports. Just transforms envelope shapes into display rows.

Public API:

```typescript
export type DisplayRow = {
  fieldId: string;        // canonical field name (e.g. "kaltmiete")
  label: string;          // German UI label (e.g. "Kaltmiete")
  display: string;        // formatted display value, e.g. "650,00 EUR" or "— (nicht im Dokument)"
  rawValue: unknown;      // for internal use / edit mode
  absenceState?: string;  // for v2 only
  severity?: string;      // for v2 only — informs ordering or styling later
  editable: boolean;      // false for v2 (append-only), true for legacy
};

export function buildDisplayRows(input:
  | { kind: "v2"; envelope: Record<string, unknown>; docType: string }
  | { kind: "legacy"; extractedFields: Record<string, unknown>; docType?: string }
): DisplayRow[];
```

For v2: iterate the envelope's known fields per `docType`. For mietvertrag: kaltmiete → "Kaltmiete", unit_ref → "Einheit", tenant_identity → "Mieter", mietbeginn → "Mietbeginn", mietende → "Mietende". Format `normalized_value` using the type info (money → "650,00 EUR", date → "DD.MM.YYYY", enum/string → as-is, structured → `name` field).

If `absence_state === "not_applicable"`, OMIT the row entirely (e.g. open-ended lease has no Mietende). For other non-present absence_states, render with placeholder text: "— (nicht im Dokument)" for absent, "— (unleserlich)" for illegible, etc.

For legacy: use the existing label mappings already in `triage-overlay.tsx` (look at the `formatFieldDisplay` function for clues to what field names exist: `amount`, `rent_cold`, `invoice_date`, `lease_start`, `lease_end`, `vendor_name`). Build a label map for the common Haiku field names.

If a v2 docType is unknown (not mietvertrag), the function should NOT throw — return an empty array and rely on legacy fallback. Defensive coding.

### 3. Modify `getTriageDocument` in `src/lib/warehouse-actions.ts`

After step 2 (the current legacy extraction fetch, line ~1581-1586) and BEFORE step 3 (signed URL), insert the v2 envelope fetch:

```typescript
// 2b) Latest v2 envelope (if any) — preferred over legacy when present
const { data: v2Envelope } = await db.from('document_extractions_v2')
    .select('id, doc_type, schema_version, prompt_version, model, extraction_run_id, fields, lifecycle, human_review_status, created_at')
    .eq('source_document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
```

Notes on the query:
- `.maybeSingle()` not `.single()` — we EXPECT it might not exist for legacy-only docs.
- The org filter happens through RLS (the `doc_extractions_v2_org_isolation` policy enforces it via `source_document_id → documents.property_id → Property.organizationId`). No explicit `.eq('org_id', orgId)` needed because the table doesn't have an `org_id` column.
- Index `idx_doc_extractions_v2_source_latest` (source_document_id, created_at DESC) makes this fast.

Then build the return shape. Add new fields to the data envelope:

```typescript
return {
    error: null,
    data: {
        document: doc,
        // ... existing fields ...
        extraction: ... // legacy as before
        v2Envelope: v2Envelope ? {
            id: v2Envelope.id,
            doc_type: v2Envelope.doc_type,
            schema_version: v2Envelope.schema_version,
            prompt_version: v2Envelope.prompt_version,
            model: v2Envelope.model,
            extraction_run_id: v2Envelope.extraction_run_id,
            fields: v2Envelope.fields as Record<string, unknown>,
            lifecycle: v2Envelope.lifecycle as Record<string, unknown>,
            human_review_status: v2Envelope.human_review_status as string,
            created_at: v2Envelope.created_at as string,
        } : null,
        v2EnabledDocTypes: ['mietvertrag'], // TODO: import from schemas/index.ts when reachable
        // ...
    },
};
```

The renderer decides which to show based on `v2Envelope` presence.

### 4. New server action `requeueDocumentExtraction`

In `src/lib/warehouse-actions.ts`, add:

```typescript
export async function requeueDocumentExtraction(documentId: string): Promise<{ jobId: string | null; error: string | null }> {
    const orgContext = await getOrgContextWritable();
    if (orgContext.error) return { jobId: null, error: orgContext.error };
    const { orgId } = orgContext;

    const db = warehouseDb(orgId);

    // Verify doc belongs to org
    const { data: doc } = await db.from('documents')
        .select('id')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .maybeSingle();

    if (!doc) return { jobId: null, error: 'Not found' };

    // Insert new processing job
    const { data: job, error } = await db.from('processing_jobs')
        .insert({ org_id: orgId, document_id: documentId, status: 'queued' })
        .select('id')
        .single();

    if (error) return { jobId: null, error: error.message };

    await logAuditEvent({
        eventType: 're_extraction_requested',
        documentId,
    });

    return { jobId: job.id as string, error: null };
}
```

Add `re_extraction_requested` to the AuditEventType enum / list (wherever it lives — grep for an existing audit event name like `quarantined` to find the file).

### 5. Modify `src/components/warehouse/triage-overlay.tsx`

Two changes:

**(a) Render path selection.** After `getTriageDocument` returns, decide:

```typescript
const rows = data.v2Envelope
  ? buildDisplayRows({ kind: 'v2', envelope: data.v2Envelope.fields, docType: data.v2Envelope.doc_type })
  : buildDisplayRows({ kind: 'legacy', extractedFields: data.extraction?.extracted_fields ?? {}, docType: data.document.doc_type });

const isV2 = data.v2Envelope !== null;
```

Render the EXTRAHIERTE FELDER section by iterating `rows`. Each row uses the existing `EditableField` component when `row.editable === true` (legacy), or a new read-only display variant when `editable === false` (v2). The v2 read-only variant should look the same as legacy in present mode (just plain text, no input).

**(b) Header badges and buttons.** Above the EXTRAHIERTE FELDER section:

- If `isV2`: show a small "v2" Badge (use existing `<Badge>` shadcn component, variant="secondary"). Tooltip: "Strukturierte Extraktion (Schema {schema_version})".
- If `!isV2`: show a "Legacy-Format" Badge (variant="outline"). 
- If `!isV2 && data.v2EnabledDocTypes.includes(data.document.doc_type)`: also show a "Neu extrahieren" button next to the badge. On click, call `requeueDocumentExtraction(documentId)` and show inline status "In Warteschlange..." for ~30s then revert. Do NOT poll. Disable the button while pending.

The Re-extract button text inline state machine:
- idle: "Neu extrahieren" (clickable)
- pending (post-click): "In Warteschlange..." (disabled, 30s timeout then back to idle)
- error (only on action error): "Fehler — erneut versuchen" (clickable)

### 6. Test (unit-level)

After implementing:
- `npx tsx src/tests/triage-document-shape.test.ts` — should pass with all assertions green
- `npx tsc --noEmit` — silent
- Run full regression as in Task 1.5b:
  ```bash
  npm run gen:schemas:check
  npx tsx -r dotenv/config src/tests/schemas.test.ts
  npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
  npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts
  npx tsx -r dotenv/config src/tests/v2-extraction-envelope-migration.test.ts
  npx tsx src/tests/verifiers.test.ts
  npx tsx src/tests/verifiers-no-model-identifiers.test.ts
  npx tsx src/tests/envelope-validator.test.ts
  npx tsx src/tests/triage-document-shape.test.ts
  ```
- All pass. tsc silent.

### 7. ARCHITECTURE_STATE.md

Append a section documenting:
- Task 1.6 (Triage overlay dual-read) complete
- `getTriageDocument` now reads v2 envelope first, falls back to legacy
- `requeueDocumentExtraction` action added; "Neu extrahieren" UI button for v2-enabled doc types
- `src/lib/extraction-display.ts` is the canonical mapping from envelope shapes to display rows; future v2 doc types (Übergabeprotokoll, etc.) extend the map there
- Edit-in-overlay remains LEGACY-ONLY; v2 envelopes are append-only per architecture §3.1

### 8. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.6-triage-dual-read

# (write test, implement extraction-display.ts, modify warehouse-actions.ts, modify triage-overlay.tsx, update ARCHITECTURE_STATE.md, verify)

git add src/lib/extraction-display.ts \
        src/lib/warehouse-actions.ts \
        src/components/warehouse/triage-overlay.tsx \
        src/tests/triage-document-shape.test.ts \
        ARCHITECTURE_STATE.md
# (plus any audit-event-enum file)

git commit -m "feat(triage): dual-read v2 envelope with legacy fallback (Task 1.6)

getTriageDocument now fetches the latest v2 envelope alongside the
legacy document_extractions row. When a v2 envelope is present, the
triage overlay renders v2 fields with a 'v2' badge and disables in-
place editing (v2 envelopes are append-only per architecture §3.1).
When absent, the overlay renders legacy fields with a 'Legacy-Format'
badge. For documents whose doc_type has a v2 schema (currently:
mietvertrag), a 'Neu extrahieren' button enqueues a fresh processing
job that produces a v2 envelope on the next cron tick.

New: src/lib/extraction-display.ts — pure function mapping envelope
shapes (v2 or legacy) to display rows. Insulated from React, the DB,
and Supabase. Future v2 doc types extend the field-label map here.

New: src/tests/triage-document-shape.test.ts — ~12 assertions
covering Lena's exact field set, absence-state rendering, and legacy
fallback shapes. Locks the renderer contract.

New action: requeueDocumentExtraction(documentId) — re-queues a doc
for re-processing; audit-logs 're_extraction_requested'.

No mass migration: legacy docs stay on legacy until users click
Re-extract. Architecture §11 dual-path migration.

Acceptance: Lena's Mietvertrag (KO132 1.OG) now shows kaltmiete
650,00 EUR, Einheit 1.OG, Mieter Everding/Lena, Mietbeginn
01.04.2025, no Mietende row (not_applicable), 'v2' badge in header.
Rechnung documents continue to show legacy fields with 'Legacy-
Format' badge."

git push -u origin feature/task-1.6-triage-dual-read
```

Report back the branch URL, test outputs, and verify the triage overlay renders Lena's v2 envelope correctly when navigated to in the Vercel preview deployment.

## Acceptance gates

- `src/tests/triage-document-shape.test.ts` exists, all assertions pass. Includes Lena-specific case.
- `src/lib/extraction-display.ts` is pure: no imports from `@supabase`, `prisma`, `react`, or `next`. Grep test in CI or in the test file itself.
- `getTriageDocument` returns `{data: {..., v2Envelope, v2EnabledDocTypes}}` shape.
- Triage overlay correctly renders Lena's v2 envelope when opened (manual test on Vercel preview).
- A non-mietvertrag document (e.g. any Rechnung) opens with the "Legacy-Format" badge and shows the legacy fields.
- "Neu extrahieren" button visible for legacy mietvertrag docs ONLY, and clicking it queues a new processing job (verify in `warehouse.processing_jobs` table).
- All regression tests pass; tsc silent.
- ARCHITECTURE_STATE.md updated.

## Constraints

- Do NOT modify `updateExtractionField` to write v2 envelopes. v2 is append-only.
- Do NOT add a v2 envelope edit flow. That's a separate task.
- Do NOT poll for the re-extraction result. Simple inline state machine, manual refresh.
- Do NOT change parent components (`inbox-table.tsx`, `property-costs.tsx`, `category-documents.tsx`).
- Do NOT touch the Edge Function or v2 pipeline code.
- UI strings German; loanwords allowed per project convention.
- Pipe git commands through `| cat`.

## After this task

Phase 1 will be functionally complete on the UI side. Tasks 1.7 (Mietvertrag claim emitter) and 1.8 (claim-store applier) finish the data-flow side — taking the v2 envelope and producing claims in `warehouse.claims` so that downstream resolvers like `rent_for_unit("KO132", "1.OG")` can return €650.

Lena's v2 envelope (`c370b9b8-63af-4ea1-b04e-6b0950dc9bb5`) is in the database; once the overlay reads it, the UI side of Phase 1 is closed.
