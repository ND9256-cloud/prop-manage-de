# Task 1.5d — OCR truncation fix (extractText max_tokens + stop_reason guard)

Task type: t2 S (Edge Function code change + tests + re-OCR runbook, requires review)

Reference docs:
- Anthropic Claude Haiku 4.5 model card: max 200K input context, max 64K output tokens
- `supabase/functions/process-document/index.ts:209-345` — the `extractText` function
- This brief is generated from a forensic analysis on 2026-05-15: OCR text on both Lena Everding's Mietvertrag (doc_id `f7c3e663-11bf-4b91-947c-9136df9eefae`, 13,766 chars) and Julija Paul's Mietvertrag (doc_id `ff52f1a5-b963-4228-b46a-693e8e4821b8`, 11,121 chars) ends mid-document — neither contains the Kaution clause. Sonnet correctly returned `kaution: absent` on the truncated text, surfacing the bug.

Code touched:
- `supabase/functions/process-document/index.ts` — extractText function: raise PDF max_tokens, raise image max_tokens, add stop_reason guard on both paths
- `src/tests/extract-text-truncation.test.ts` — NEW, pure test that exercises the truncation-detection logic
- `ARCHITECTURE_STATE.md` — append a section

NOT touched:
- The model choice (`claude-haiku-4-5-20251001` stays — current, active, correct tier for OCR)
- The classifyDocument / extractFields / categorize / generateV2Envelope steps
- Any frontend code
- Schema YAML files
- The v2 pipeline dispatch logic

## Context

The OCR step (`extractText` step 3 in the pipeline) sends the entire PDF to Claude Haiku 4.5 with `max_tokens: 4000`. Haiku 4.5 supports up to 64,000 output tokens. The 4000 cap is approximately 16,000 characters of German legal text — about 4 pages of a typical Mietvertrag.

Effect: any document longer than ~4 pages of dense text has its OCR silently truncated. Sonnet later operates on the truncated text and produces correct-looking extractions for the visible portion while marking fields it never saw as `absent` with high confidence. No error is logged. No alert fires. Downstream consumers (the brain, future emitters, the triage overlay) see incomplete data with no signal that it's incomplete.

Corpus survey (run on 2026-05-15):

| doc_type | total | OCR length > 12000 chars | OCR length 13-14.5k (very likely truncated) |
|---|---|---|---|
| mietvertrag | 10 | 1 | 1 |
| selbstauskunft | 2 | 2 | 1 |
| heizkostenabrechnung | 19 | 1 | 0 |
| grundsteuerbescheid | 12 | 1 | 0 |
| grundbuchauszug | 8 | 2 | 0 |

Lena and Paul are confirmed cases. Probably ~5-10 other corpus docs are also affected (any doc where the real content exceeds ~4 pages of dense text). Most short documents (Rechnungen averaging 2,678 chars) are unaffected.

## Why this fix (and what we considered but rejected)

The senior-engineering answer was discussed at length and converged on raising `max_tokens` to the model's actual maximum (64,000 = 16x current) and adding a stop_reason guard. Rejected alternatives:

- **Continuation loop** (re-prompt Claude to continue from where it stopped): unnecessary at the new cap. Adds API calls, complexity, and stitching bugs for problems we won't hit.
- **Page-by-page PDF splitting** with downstream stitching: industry-standard for pure-OCR services that lack large context windows. Haiku 4.5 has a 200K input context, so this constraint doesn't apply. Adds significant code surface for no quality gain.
- **Switch model to Sonnet 4.6**: Haiku 4.5 is the correct tier for OCR (low latency, low cost). No quality concern with Haiku's text recognition. Don't change.

Note: at the new cap (64K output tokens = ~256K characters), the longest OCR output ever seen in this corpus (13,766 chars) is at 5.4% of capacity. Even a 100-page contract would fit. The stop_reason guard exists so that if a 600-page document ever appears, we get a loud signal instead of silent truncation.

## Repo conventions

- npm (not pnpm)
- Edge Functions run on Deno; `extractText` lives in `supabase/functions/process-document/index.ts`
- Edge Function deploys are manual via `supabase functions deploy process-document` (NOT auto-deployed by git push — Nils does this after merge)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts` for DB-touching tests, plain `npx tsx` for pure tests
- Branch protection enforced on main — feature branch + PR, never push direct
- Pipe potentially-paged commands through `| cat`

## Steps

### 1. Write the test FIRST (no DB)

Path: `src/tests/extract-text-truncation.test.ts`

This is a pure-logic test. It does NOT call the Edge Function or hit the Anthropic API. Instead it tests a small extracted helper that classifies a Claude API response.

Extract the response-handling logic into a pure helper that the test can exercise. Add this to `supabase/functions/process-document/index.ts` (or to a new sibling file if you prefer separation — `supabase/functions/process-document/ocr-result.ts`):

```typescript
// Pure helper — no I/O, no env. Tested in src/tests/extract-text-truncation.test.ts
export type OcrResultClassification = {
    text: string;
    confidence: number;          // 0-100 scale, same as the rest of the codebase
    truncated: boolean;          // true if the model hit max_tokens
    stopReason: string | null;
};

export function classifyOcrResponse(
    response: { content?: Array<{ text?: string }>; stop_reason?: string },
    nominalConfidence: number,   // 90 for PDF, 85 for image — the current values
): OcrResultClassification {
    const text = response.content?.[0]?.text || "";
    const stopReason = response.stop_reason ?? null;
    const truncated = stopReason === "max_tokens";
    // When truncated, drop confidence to 60 (low signal) — downstream Sonnet
    // doesn't know the OCR was truncated, but this confidence flows through
    // to consumers that DO want to gate on it.
    const confidence = truncated ? 60 : nominalConfidence;
    return { text, confidence, truncated, stopReason };
}
```

The test exercises:

1. **Happy path PDF (stop_reason `end_turn`)** — confidence stays at 90, truncated false
2. **Happy path PDF (stop_reason missing)** — confidence stays at 90, truncated false (we treat absent stop_reason as a clean stop, not as truncated — Anthropic responses always include stop_reason in practice but defensive coding)
3. **Truncated PDF (stop_reason `max_tokens`)** — confidence drops to 60, truncated true
4. **Happy path image (stop_reason `end_turn`, nominalConfidence=85)** — confidence stays at 85
5. **Truncated image (stop_reason `max_tokens`, nominalConfidence=85)** — confidence drops to 60
6. **Empty content array** — text is `""`, no crash
7. **Missing content field entirely** — text is `""`, no crash
8. **Other stop_reasons** (`tool_use`, `stop_sequence`, etc.) — treated as not-truncated, confidence stays at nominal

~10-12 assertions, same harness style as `verifiers.test.ts` and `envelope-validator.test.ts`. Should run with plain `npx tsx`.

### 2. Patch the PDF path

In `supabase/functions/process-document/index.ts`, modify the PDF branch (current lines ~221-263):

**Change A — bump max_tokens:**

```typescript
// Before:
max_tokens: 4000,

// After:
max_tokens: 64000,  // Haiku 4.5 supports up to 64K output tokens; truncation
                    // detection via stop_reason below handles overflow defensively.
```

**Change B — call the classifier and react to truncation:**

Replace:
```typescript
const pdfResult = await pdfResponse.json();
extractedText = pdfResult.content?.[0]?.text || "";
ocrConfidence = 90;
console.log(`extractText: PDF text extracted via Claude (${extractedText.length} chars)`);
```

With:
```typescript
const pdfResult = await pdfResponse.json();
const classified = classifyOcrResponse(pdfResult, 90);
extractedText = classified.text;
ocrConfidence = classified.confidence;
if (classified.truncated) {
    console.warn(
        `extractText: PDF OCR hit max_tokens for doc ${doc.id}; ` +
        `${extractedText.length} chars extracted (TRUNCATED). ocr_confidence set to 60.`
    );
} else {
    console.log(`extractText: PDF text extracted via Claude (${extractedText.length} chars)`);
}
```

### 3. Patch the image path

Same shape, in the image branch (current lines ~267-307):

**Change A — bump max_tokens:**

```typescript
// Before:
max_tokens: 2000,

// After:
max_tokens: 8000,  // Single-image OCR rarely needs this much, but defensive
                   // headroom for dense scans (Übergabeprotokolle, dense forms).
```

**Change B — apply classifyOcrResponse with nominalConfidence=85:**

```typescript
const visionResult = await visionResponse.json();
const classified = classifyOcrResponse(visionResult, 85);
extractedText = classified.text;
ocrConfidence = classified.confidence;
if (classified.truncated) {
    console.warn(
        `extractText: image OCR hit max_tokens for doc ${doc.id}; ` +
        `${extractedText.length} chars extracted (TRUNCATED). ocr_confidence set to 60.`
    );
} else {
    console.log(`extractText: image OCR extracted (${extractedText.length} chars)`);
}
```

### 4. Cost note (informational, no code change)

At Haiku 4.5 pricing ($1/M input, $5/M output as of 2026-05-15):
- Lena's 8MB PDF re-OCR: ~$0.05 single document, output-dominated
- Re-OCRing all 10 mietverträge: ~$0.50 total
- Re-OCRing the entire 250-document corpus if ever needed: ~$5

The new `max_tokens: 64000` doesn't change per-token cost — only output tokens actually generated are billed. A document that previously generated 4000 tokens will generate 4000 tokens (or however many are needed to extract the full text). No cost change for non-truncated documents.

### 5. ARCHITECTURE_STATE.md

Append a section documenting:
- Task 1.5d (OCR truncation fix) complete
- `extractText` PDF path: max_tokens raised 4000→64000, stop_reason guard added
- `extractText` image path: max_tokens raised 2000→8000, stop_reason guard added
- New pure helper `classifyOcrResponse` (also exported, callable from tests)
- New test `src/tests/extract-text-truncation.test.ts` (10-12 assertions)
- When the guard fires (stop_reason='max_tokens'), `ocr_confidence` drops to 60 and a warning is logged with the doc_id
- Followup: corpus docs with truncated OCR will need re-queue; runbook in deploy plan section below

### 6. Verify

```bash
npx tsx src/tests/extract-text-truncation.test.ts
# Should print ✓ N extract-text-truncation assertions passed

# Full regression
npm run gen:schemas:check
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts
npx tsx -r dotenv/config src/tests/v2-extraction-envelope-migration.test.ts
npx tsx src/tests/verifiers.test.ts
npx tsx src/tests/verifiers-no-model-identifiers.test.ts
npx tsx src/tests/envelope-validator.test.ts
npx tsx src/tests/triage-document-shape.test.ts
npx tsx src/tests/extract-text-truncation.test.ts

# Type check
npx tsc --noEmit
```

Expected: all previous test counts unchanged plus the new 10-12 assertions. tsc silent.

### 7. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.5d-ocr-truncation-fix

# (implement test, patch index.ts, update ARCHITECTURE_STATE.md, verify)

git add supabase/functions/process-document/index.ts \
        src/tests/extract-text-truncation.test.ts \
        ARCHITECTURE_STATE.md

git commit -m "fix(ocr): raise max_tokens to model max + add truncation guard (Task 1.5d)

extractText was capped at max_tokens=4000 (~16k chars output) while
Claude Haiku 4.5 supports up to 64,000 output tokens. Multi-page docs
were silently truncated mid-document. Sonnet then operated on the
truncated text and produced correct-looking extractions, with fields
in the missing portion marked 'absent' with high confidence and no
warning logged.

Verified failure: Lena Everding Mietvertrag (doc_id f7c3e663...) and
Julija Paul Mietvertrag (doc_id ff52f1a5...) both have truncated OCR
that does not include the Kaution clause; both v2 envelopes therefore
incorrectly show kaution: absent with high confidence.

Fix:
- PDF max_tokens: 4000 → 64000 (Haiku 4.5 model max)
- Image max_tokens: 2000 → 8000 (defensive)
- New classifyOcrResponse() pure helper inspects stop_reason on the
  Anthropic response; if stop_reason='max_tokens', drops ocr_confidence
  to 60 and logs a structured warning. Loud failure instead of silent
  truncation if a future document ever exceeds 64K output tokens.

New test: src/tests/extract-text-truncation.test.ts — 10-12 assertions
covering happy path, truncated path, image path, and edge cases
(empty content, missing content field, other stop_reasons). Pure test,
no DB or API mock required.

Cost impact: zero per-document. max_tokens raises the ceiling, not
the floor — only tokens actually generated are billed. A doc that
previously used 4000 tokens still uses 4000 tokens.

Edge Function redeploy required after merge.

Followup: re-queue mietverträge whose ocr_text length suggests
truncation. SQL filter in deploy runbook."

git push -u origin feature/task-1.5d-ocr-truncation-fix
```

## Deploy runbook (Nils does this after merge)

### 1. Redeploy Edge Function

```bash
ssh federico@100.86.27.51
cd ~/repos/property-management-saas
set -a && source .env.local && set +a
git checkout main && git pull

supabase functions deploy process-document
supabase functions list | grep -E "process-document|NAME" | cat
# Expect VERSION to bump (currently at 37 as of 2026-05-13)
```

### 2. Identify docs to re-OCR

Two cohorts:

**Cohort A — explicit known cases:** Lena + Paul Mietverträge. Re-queue both unconditionally.

**Cohort B — suspected truncation in the rest of the corpus:** docs where current OCR length is suspiciously close to the old 16k ceiling. Use this query to enumerate before re-queuing:

```sql
SELECT id, doc_type, file_name, LENGTH(ocr_text) AS ocr_chars
FROM warehouse.documents
WHERE ocr_text IS NOT NULL
  AND LENGTH(ocr_text) > 10000
ORDER BY ocr_chars DESC;
```

Manual judgment call: any mietvertrag, nebenkostenabrechnung, or grundsteuerbescheid in that list is worth re-OCRing. Short ones (Rechnungen, simple invoices) almost certainly weren't truncated; leave them. Conservative estimate: probably 5-15 docs.

### 3. Re-queue identified docs

```sql
-- Lena (known)
UPDATE warehouse.processing_jobs
SET status = 'queued', updated_at = NOW(), error_message = NULL
WHERE document_id = 'f7c3e663-11bf-4b91-947c-9136df9eefae'
  AND id = (SELECT id FROM warehouse.processing_jobs
            WHERE document_id = 'f7c3e663-11bf-4b91-947c-9136df9eefae'
            ORDER BY created_at DESC LIMIT 1);

-- Paul (known)
UPDATE warehouse.processing_jobs
SET status = 'queued', updated_at = NOW(), error_message = NULL
WHERE document_id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8'
  AND id = (SELECT id FROM warehouse.processing_jobs
            WHERE document_id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8'
            ORDER BY created_at DESC LIMIT 1);
```

For other corpus docs identified in step 2, re-queue similarly. Per-minute cron will pick them up.

### 4. Verify

Within ~10 minutes (cron tick + ~90s OCR + Sonnet per doc):

```sql
-- Did OCR length grow? (indicates truncation was happening before)
SELECT 
  d.id, d.file_name, 
  LENGTH(d.ocr_text) AS ocr_chars_now,
  d.ocr_confidence,
  d.updated_at
FROM warehouse.documents d
WHERE d.id IN ('f7c3e663-11bf-4b91-947c-9136df9eefae', 'ff52f1a5-b963-4228-b46a-693e8e4821b8')
ORDER BY d.updated_at DESC;
```

Expected:
- Lena: ocr_chars goes from 13,766 to something larger (likely 20-40k for a 12-page contract). ocr_confidence stays 90 (full extraction; no truncation).
- Paul: ocr_chars goes from 11,121 to something larger. Same confidence behavior.

Then verify the v2 envelope now contains kaution and full nebenkostenvorauszahlung values:

```sql
SELECT id, source_document_id, schema_version, fields->'kaution' AS kaution, 
       fields->'nebenkostenvorauszahlung' AS nk, created_at
FROM warehouse.document_extractions_v2
WHERE source_document_id IN ('f7c3e663-11bf-4b91-947c-9136df9eefae', 
                              'ff52f1a5-b963-4228-b46a-693e8e4821b8')
ORDER BY created_at DESC LIMIT 4;
```

Expected: the new envelopes (created_at after redeploy) have `kaution.absence_state: "present"` with real evidence quotes, and `nebenkostenvorauszahlung.absence_state: "present"` for any contract that has one.

If kaution is STILL absent after this fix:
- Open the document PDF in the browser and verify whether a Kaution clause actually exists
- If yes, check the new `ocr_text` length and whether the word "Kaution" appears in the OCR text
- If the OCR is now complete but Sonnet missed it, that's a prompt issue (Task 1.5e candidate)
- If the OCR still doesn't contain "Kaution" / "Sicherheitsleistung", the bug isn't truncation — it's something else (OCR quality, PDF structure)

### 5. Update memory

After the runbook completes:
- Note Task 1.5d done in ARCHITECTURE_STATE.md ✓ (already done in PR)
- If new corpus docs were re-OCRed, note approximate count

## Acceptance gates

- `src/tests/extract-text-truncation.test.ts` exists, all assertions pass
- `extract-text-truncation.test.ts` imports `classifyOcrResponse` from `supabase/functions/process-document/` (or sibling file) — purity is enforced by the test framework (no DB/API/Anthropic imports needed in the test)
- PDF path: max_tokens=64000, truncation warning logged on max_tokens stop_reason, ocr_confidence set to 60 on truncation
- Image path: max_tokens=8000, same guard
- All regression tests still pass; tsc silent
- ARCHITECTURE_STATE.md updated
- Branch pushed to origin
- Runbook above is part of the PR description so Nils has it handy

## Constraints

- Do NOT change the model. Haiku 4.5 stays.
- Do NOT redeploy the Edge Function. Deploy is Nils's manual step.
- Do NOT re-queue any document. Re-queue is Nils's manual step per the runbook.
- Do NOT touch any other pipeline step (classify, extract, categorize, generate).
- Do NOT alter the `ocr_confidence` field's general semantics — only set it to 60 on the truncation path. Other codepaths still set it to 0/85/90 as before.
- Pipe git commands through `| cat`.

## What this does NOT solve

- Sonnet extraction quality on the truncated text. If a real Mietvertrag has tricky multi-page structure that Haiku OCR mangles (table boundaries, multi-column layout, etc.), this task doesn't help with that. Different problem; future task if it surfaces.
- The Paul `unit_ref` template-text issue. Already solved by the prompt instructions in schema.yaml; Sonnet correctly normalizes to "EG" today.
- Anything related to the legacy `document_extractions` path. v2 only.

After this lands and Lena + Paul re-extract with kaution + full nebenkostenvorauszahlung visible, Phase 1 is unblocked for Task 1.7 (claim emitter).
