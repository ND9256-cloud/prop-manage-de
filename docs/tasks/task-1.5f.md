# Task 1.5f — Page-by-page OCR with parallelization

Task type: t2 L (architectural change to extractText, new dependency, real risk surface, requires review)

## Why this task exists

Task 1.5d (shipped 2026-05-20) fixed the silent OCR truncation bug by raising `max_tokens: 4000 → 64000`. The fix is correct but incomplete:

1. **Latency regression.** Heavy mietverträge now take 8-15 minutes to OCR because Haiku generates up to 64K output tokens in one streaming response. Pre-fix: ~30s. Post-fix: multi-minute.
2. **529 exposure.** Long single-call requests get rate-limited disproportionately. Lena's Mietvertrag (50K-char OCR output) got 529'd twice in one session on otherwise-fine Anthropic capacity.
3. **No bounded timeout.** A hanging request stalls the worker indefinitely.
4. **Whole-doc retry semantics.** Page 3 OCR fails → re-OCR pages 1-2 too.

The architectural answer (used by Google Document AI, AWS Textract, Mistral OCR, olmOCR) is per-page processing. This brief implements it.

## Goal

After this task lands:
- p50 OCR latency for typical mietverträge ≤ 30s
- p95 ≤ 90s
- No silent truncation possible (single page rarely exceeds 4K output tokens)
- Page failures isolated (one bad page doesn't kill the doc)
- Per-page bounded timeout
- Predictable Haiku cost (linear in pages, cheap)

## Reference docs

- `supabase/functions/process-document/index.ts:209-345` — the current `extractText` function (Task 1.5d state)
- `supabase/functions/process-document/ocr-result.ts` — pure helper from Task 1.5d (KEEP and reuse for per-page classification)
- Anthropic Haiku 4.5: 200K input context, 64K output tokens — single page never approaches either limit

## Code touched

- `supabase/functions/process-document/index.ts` — extractText function rewrite: PDF branch becomes splitting + parallel per-page calls + stitching. Image branch unchanged (single image = single call).
- `supabase/functions/process-document/page-extraction.ts` (NEW) — pure helpers: `splitPdfIntoPages()`, `extractPageText()`, `stitchPageOutputs()`, `parseStopReasons()`. Pure where possible; the Anthropic call is unavoidably impure but small.
- `supabase/functions/process-document/ocr-result.ts` — already-exists, REUSE `classifyOcrResponse()` for per-page classification. No changes.
- `src/tests/page-extraction.test.ts` (NEW) — pure tests covering splitting, stitching, page-failure handling, timeout handling.
- `ARCHITECTURE_STATE.md` — section appended.

## NOT touched

- The Sonnet intelligence step (Step 8b) — separate concern.
- The classifyDocument / extractFields / categorize steps — different prompts, different concerns.
- The image branch of extractText — single-image input doesn't need splitting.
- The v2 envelope generation logic.
- Any frontend code.
- Any schema YAML.

## Design

### Approach

1. **Split** the PDF into individual pages using `pdf-lib` (already-supported in Deno via npm specifier).
2. **Extract** each page in parallel (concurrency cap = 5) via the existing Haiku PDF call with `max_tokens: 4000`. Each page is a single-page PDF.
3. **Stitch** the per-page outputs into one OCR text with page boundary markers preserved (`\n\n--- Seite N ---\n\n`). Page boundaries are useful downstream for things like "kaution clause is on page 3."
4. **Aggregate** per-page stop_reasons and confidences. If ANY page hit `max_tokens` (shouldn't happen at 4K cap), log warning and mark `ocr_confidence: 60`. If ALL pages succeeded cleanly, `ocr_confidence: 90` as before. If any page completely failed (timeout, 529 after retries), mark `ocr_confidence: 0` and store partial OCR with explicit `[ERROR: page N extraction failed]` marker so the absence is visible, not silent.

### Concurrency

Run 5 pages in parallel per document. This is the sweet spot:
- Higher (10+) increases 529 risk by burst-loading Anthropic
- Lower (1) defeats the latency benefit
- 5 keeps a 10-page mietvertrag at 2 sequential batches × ~15s each = ~30s total

### Per-page retry policy

Each page call:
- 45s timeout (AbortController on fetch)
- On 529: retry once after 30s wait, then once more after 90s wait, then fail this page (mark as page error)
- On timeout: retry once with 60s timeout, then fail this page
- On 4xx (non-overload): fail immediately, no retry

Page failures are isolated: one failed page doesn't kill the doc. The OCR text gets `[ERROR: page N extraction failed]` inline at the page's position. Downstream consumers (Sonnet intelligence step) see the marker and the doc still proceeds. The job's `ocr_confidence` drops to reflect partial success.

### What "stitching with boundaries" looks like

For a 3-page doc where page 2 failed:

```
--- Seite 1 ---

[page 1 OCR text here]

--- Seite 2 ---

[ERROR: page 2 extraction failed after 3 attempts]

--- Seite 3 ---

[page 3 OCR text here]
```

Sonnet sees the boundary markers and can reason about page numbers when describing what it found. Future task: schema fields can reference page numbers for evidence.

### Dependencies

`pdf-lib` (~150KB, MIT, used by 1.5M+ projects, actively maintained, works in Deno via npm specifier). Add to `supabase/functions/process-document/index.ts` imports:

```typescript
import { PDFDocument } from "npm:pdf-lib@1.17.1";
```

Deno fetches and caches automatically on first deploy. No package.json change needed.

## Implementation steps

### 1. Write the test FIRST (no DB, no Anthropic)

Path: `src/tests/page-extraction.test.ts`

Pure tests against pure helpers. ~15-20 assertions covering:

**Splitting:**
- 1-page PDF input → 1 single-page PDF in output array
- 5-page PDF input → 5 single-page PDFs in output array
- Splitting preserves page count (verify with pdf-lib's `getPageCount()`)
- Empty/malformed PDF input → throws controlled error (not unhandled)

**Stitching:**
- 3 successful page outputs → single string with `--- Seite N ---` markers between them
- Page 2 failed (string contains ERROR marker), pages 1 + 3 succeeded → stitched output has ERROR marker preserved at page 2 position
- All pages failed → stitched output is all ERROR markers (no crash)
- Empty page output (page contains no extractable text) → still appears with empty body under its marker

**Aggregation:**
- All pages clean → returns `{ confidence: 90, anyTruncated: false, failedPages: [] }`
- One page hit max_tokens → returns `{ confidence: 60, anyTruncated: true, failedPages: [] }`
- One page completely failed → returns `{ confidence: 60 (best effort with partial data), anyTruncated: false, failedPages: [2] }`
- All pages failed → returns `{ confidence: 0, anyTruncated: false, failedPages: [1, 2, 3] }`

Run: `npx tsx src/tests/page-extraction.test.ts` — should print the assertion count and pass cleanly. Same harness style as existing tests.

### 2. Build the pure helpers

Path: `supabase/functions/process-document/page-extraction.ts`

```typescript
import { PDFDocument } from "npm:pdf-lib@1.17.1";

export type PageResult = {
    pageNumber: number;       // 1-indexed
    text: string;             // empty string on failure
    stopReason: string | null;
    truncated: boolean;
    failed: boolean;
    errorMessage: string | null;
};

export type AggregatedOcr = {
    text: string;             // stitched, with --- Seite N --- markers
    confidence: number;       // 0-100, see aggregation logic
    anyTruncated: boolean;
    failedPages: number[];
};

/**
 * Split a PDF (as ArrayBuffer) into N single-page PDFs (as Uint8Arrays).
 * Throws if PDF is malformed.
 */
export async function splitPdfIntoPages(pdfBuffer: ArrayBuffer): Promise<Uint8Array[]> {
    const sourceDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = sourceDoc.getPageCount();
    const pages: Uint8Array[] = [];
    
    for (let i = 0; i < pageCount; i++) {
        const newDoc = await PDFDocument.create();
        const [copiedPage] = await newDoc.copyPages(sourceDoc, [i]);
        newDoc.addPage(copiedPage);
        const pageBytes = await newDoc.save();
        pages.push(pageBytes);
    }
    
    return pages;
}

/**
 * Stitch per-page results into a single OCR text with page-boundary markers.
 * Failed pages render an [ERROR] line in their position so the gap is visible.
 */
export function stitchPageOutputs(results: PageResult[]): string {
    return results
        .sort((a, b) => a.pageNumber - b.pageNumber)
        .map(r => {
            const header = `--- Seite ${r.pageNumber} ---`;
            const body = r.failed
                ? `[ERROR: page ${r.pageNumber} extraction failed — ${r.errorMessage}]`
                : r.text;
            return `${header}\n\n${body}`;
        })
        .join("\n\n");
}

/**
 * Aggregate per-page results into final confidence + flags.
 */
export function aggregateResults(results: PageResult[]): Omit<AggregatedOcr, "text"> {
    const failedPages = results.filter(r => r.failed).map(r => r.pageNumber).sort((a, b) => a - b);
    const anyTruncated = results.some(r => r.truncated);
    
    let confidence: number;
    if (failedPages.length === results.length) {
        confidence = 0;  // total failure
    } else if (failedPages.length > 0 || anyTruncated) {
        confidence = 60; // partial success or truncation
    } else {
        confidence = 90; // clean
    }
    
    return { confidence, anyTruncated, failedPages };
}
```

### 3. The orchestrator

Also in `page-extraction.ts` (or split out — your call):

```typescript
/**
 * Call Haiku for a single page with retry + timeout. Impure (network call).
 */
export async function extractPageText(
    anthropicKey: string,
    pageNumber: number,
    pageBytes: Uint8Array,
    base64Encode: (b: Uint8Array) => string,
): Promise<PageResult> {
    const attempts = [
        { timeoutMs: 45000, waitBeforeMs: 0 },
        { timeoutMs: 45000, waitBeforeMs: 30000 },
        { timeoutMs: 60000, waitBeforeMs: 90000 },
    ];
    
    for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
        const { timeoutMs, waitBeforeMs } = attempts[attemptIdx];
        
        if (waitBeforeMs > 0) {
            await new Promise(r => setTimeout(r, waitBeforeMs));
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "x-api-key": anthropicKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 4000,  // single page never exceeds this
                    messages: [{
                        role: "user",
                        content: [
                            {
                                type: "document",
                                source: {
                                    type: "base64",
                                    media_type: "application/pdf",
                                    data: base64Encode(pageBytes),
                                },
                            },
                            {
                                type: "text",
                                text: "Extract all text from this PDF page. Return only the raw text content, preserving the original structure. No commentary.",
                            },
                        ],
                    }],
                }),
            });
            clearTimeout(timeoutId);
            
            // 529 → retry if attempts left
            if (response.status === 529 && attemptIdx < attempts.length - 1) {
                console.warn(`extractPageText: page ${pageNumber} got 529, retry ${attemptIdx + 1}`);
                continue;
            }
            
            if (!response.ok) {
                return {
                    pageNumber,
                    text: "",
                    stopReason: null,
                    truncated: false,
                    failed: true,
                    errorMessage: `Haiku ${response.status}`,
                };
            }
            
            const json = await response.json();
            const text = json.content?.[0]?.text || "";
            const stopReason = json.stop_reason ?? null;
            return {
                pageNumber,
                text,
                stopReason,
                truncated: stopReason === "max_tokens",
                failed: false,
                errorMessage: null,
            };
        } catch (err) {
            clearTimeout(timeoutId);
            const isTimeout = err instanceof Error && err.name === "AbortError";
            const isLastAttempt = attemptIdx === attempts.length - 1;
            
            if (isLastAttempt) {
                return {
                    pageNumber,
                    text: "",
                    stopReason: null,
                    truncated: false,
                    failed: true,
                    errorMessage: isTimeout ? "timeout" : (err instanceof Error ? err.message : "unknown"),
                };
            }
            console.warn(`extractPageText: page ${pageNumber} attempt ${attemptIdx + 1} failed, retrying`);
        }
    }
    
    // Unreachable but TS demands it
    return { pageNumber, text: "", stopReason: null, truncated: false, failed: true, errorMessage: "exhausted retries" };
}

/**
 * Run page extraction in parallel batches. Returns per-page results in page order.
 */
export async function extractAllPages(
    anthropicKey: string,
    pageBuffers: Uint8Array[],
    base64Encode: (b: Uint8Array) => string,
    concurrency: number = 5,
): Promise<PageResult[]> {
    const results: PageResult[] = [];
    
    for (let i = 0; i < pageBuffers.length; i += concurrency) {
        const batch = pageBuffers.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map((bytes, idx) =>
                extractPageText(anthropicKey, i + idx + 1, bytes, base64Encode)
            )
        );
        results.push(...batchResults);
    }
    
    return results;
}
```

### 4. Wire into extractText

In `supabase/functions/process-document/index.ts`, replace the entire PDF branch (current lines ~221-263) with:

```typescript
if (doc.mime_type === "application/pdf") {
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    
    // Split PDF into pages
    let pageBuffers: Uint8Array[];
    try {
        pageBuffers = await splitPdfIntoPages(fileBuffer);
        console.log(`extractText: split PDF into ${pageBuffers.length} pages for doc ${doc.id}`);
    } catch (splitErr) {
        const errMsg = splitErr instanceof Error ? splitErr.message : "PDF split failed";
        throw new Error(`PDF split failed: ${errMsg}`);
    }
    
    // Extract each page in parallel batches
    const pageResults = await extractAllPages(anthropicKey, pageBuffers, arrayBufferToBase64);
    
    // Aggregate + stitch
    const stitched = stitchPageOutputs(pageResults);
    const aggregated = aggregateResults(pageResults);
    extractedText = stitched;
    ocrConfidence = aggregated.confidence;
    
    if (aggregated.failedPages.length > 0) {
        console.warn(
            `extractText: doc ${doc.id} — ${aggregated.failedPages.length}/${pageResults.length} pages failed: [${aggregated.failedPages.join(", ")}]`
        );
    }
    if (aggregated.anyTruncated) {
        console.warn(
            `extractText: doc ${doc.id} — at least one page hit max_tokens=4000 (unexpected for single-page input)`
        );
    }
    
    console.log(`extractText: PDF text extracted via per-page (${extractedText.length} chars, confidence=${ocrConfidence})`);
}
```

Note: the existing `classifyOcrResponse` helper is now only used by the image branch. Keep it; don't delete.

### 5. Image branch — leave it alone

Image branch keeps its current state (single call, `max_tokens: 8000`, `classifyOcrResponse` guard). Single images don't need splitting.

### 6. ARCHITECTURE_STATE.md

Append a section:

```
## Task 1.5f — Page-by-page PDF OCR (2026-05-XX)

extractText PDF branch now splits the PDF into single-page PDFs (pdf-lib),
extracts each page in parallel batches of 5 via Haiku 4.5 with max_tokens=4000,
and stitches outputs with --- Seite N --- boundary markers. Per-page timeout 45s
with retry on 529 (waits 30s, then 90s). Failed pages produce [ERROR: ...]
markers inline so absence is visible, not silent.

Replaces Task 1.5d single-call max_tokens=64000 strategy for PDF input.
Image input still uses single-call extraction.

Expected p50 latency drop from 8+ min to 30s for typical mietverträge.
Predictable Haiku cost linear in pages.

New module: supabase/functions/process-document/page-extraction.ts
New test: src/tests/page-extraction.test.ts (~15-20 assertions)
classifyOcrResponse from Task 1.5d retained for image branch only.
```

### 7. Verify

```bash
npx tsx src/tests/page-extraction.test.ts
npx tsx src/tests/extract-text-truncation.test.ts  # still passes

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
npx tsx src/tests/page-extraction.test.ts

npx tsc --noEmit
```

Expected: all previous counts unchanged, plus ~15-20 new assertions in page-extraction.test.ts. tsc silent.

### 8. Branch + push

```bash
git checkout main && git pull
git checkout -b feature/task-1.5f-page-by-page-ocr

# (implement test FIRST, then helpers, then orchestrator, then wire into extractText)

git add supabase/functions/process-document/index.ts \
        supabase/functions/process-document/page-extraction.ts \
        src/tests/page-extraction.test.ts \
        ARCHITECTURE_STATE.md

git commit -m "feat(ocr): page-by-page PDF extraction with parallelization (Task 1.5f)

Replaces Task 1.5d single-call max_tokens=64000 PDF OCR with per-page
processing. Each page extracted independently via Haiku 4.5 with normal
max_tokens=4000 and per-page timeout/retry. Pages processed in parallel
batches of 5.

Motivation: Task 1.5d fixed silent truncation but introduced 8-15min
latency per multi-page mietvertrag (Lena's 50K-char output was a heavy
streaming response). Lena got 529'd twice in one session. Per-page is
the industry-standard pattern (Google Document AI, AWS Textract).

Architecture:
- splitPdfIntoPages() via pdf-lib (npm:pdf-lib@1.17.1)
- extractPageText() per page with 45s timeout, retry on 529 (30s, 90s waits)
- extractAllPages() parallel batches of 5
- stitchPageOutputs() concatenates with '--- Seite N ---' boundary markers
- aggregateResults() computes overall confidence (90 clean, 60 partial, 0 total failure)
- Failed pages produce [ERROR: page N extraction failed] markers — visible, not silent

Expected p50 latency for typical mietverträge: ~30s (was 8+min).
Expected p95: ~90s.
Cost: predictable, linear in pages, dominated by Haiku output tokens.

The classifyOcrResponse helper from Task 1.5d is retained and used by
the image branch (single-image extraction unchanged).

New test: src/tests/page-extraction.test.ts — covers splitting, stitching,
aggregation, page-failure handling, timeout. Pure (no DB, no API).

Edge Function redeploy required after merge.

Followup: re-queue Lena + Paul + mietverträge after deploy."

git push -u origin feature/task-1.5f-page-by-page-ocr
```

## Deploy runbook (Nils does this after merge)

### 1. Redeploy Edge Function

```bash
ssh federico@100.86.27.51
cd ~/repos/property-management-saas
set -a && source .env.local && set +a
git checkout main && git pull

supabase functions deploy process-document
supabase functions list 2>&1 | grep -E "process-document|NAME" | cat
# Expect version to bump (currently at 38 from Task 1.5d)
```

### 2. Test on Paul first (known-good baseline)

```sql
-- Queue fresh job
INSERT INTO warehouse.processing_jobs (document_id, org_id, status, attempt_count, next_attempt_at, created_at, updated_at)
SELECT d.id, d.org_id, 'queued', 0, NOW(), NOW(), NOW()
FROM warehouse.documents d
WHERE d.id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8'
RETURNING id::text, status;
```

Poll for completion (should be ~30s, not minutes). Verify:

```sql
SELECT 
  d.file_name,
  LENGTH(d.ocr_text) AS ocr_chars,
  d.ocr_confidence,
  CASE WHEN d.ocr_text LIKE '%--- Seite 1 ---%' THEN 'YES' ELSE 'NO' END AS has_page_markers,
  CASE WHEN d.ocr_text ILIKE '%kaution%' THEN 'YES' ELSE 'NO' END AS mentions_kaution
FROM warehouse.documents d
WHERE d.id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8';
```

Expected: ocr_chars similar to or larger than the 28,670 from Task 1.5d (no regression). Page markers present. Kaution mentioned. Confidence 90.

### 3. Now Lena (the harder case)

```sql
UPDATE warehouse.processing_jobs
SET status = 'queued', attempt_count = 0, next_attempt_at = NOW(),
    error_message = NULL, last_stage = NULL, updated_at = NOW()
WHERE document_id = 'f7c3e663-11bf-4b91-947c-9136df9eefae'
  AND status = 'dead_letter';
```

Expected: completes in ~30-60s (vs the multi-minute attempts that 529'd). OCR length comparable to 50K. Kaution present.

### 4. Re-OCR remaining mietverträge

The other 3 mietverträge from the rent roll (Hofmann, Kuru, Dajs) can be batch-queued. Each should complete in seconds-to-tens-of-seconds.

```sql
INSERT INTO warehouse.processing_jobs (document_id, org_id, status, attempt_count, next_attempt_at, created_at, updated_at)
SELECT d.id, d.org_id, 'queued', 0, NOW(), NOW(), NOW()
FROM warehouse.documents d
WHERE d.doc_type = 'mietvertrag'
  AND d.id NOT IN (
    'f7c3e663-11bf-4b91-947c-9136df9eefae',
    'ff52f1a5-b963-4228-b46a-693e8e4821b8'
  )
RETURNING id::text, document_id::text;
```

Poll until all done. Verify each gained page markers and didn't lose data.

### 5. Memory update

After deploy succeeds:
- Note Task 1.5f shipped, Edge Function version
- Note p50 OCR latency on observed mietverträge (rough average)
- Note that Lena re-OCR'd cleanly (or didn't — record the actual)
- Update the "OCR truncation" knowledge in memory: now solved structurally, not via raised cap

## Acceptance gates

- `src/tests/page-extraction.test.ts` exists with ~15-20 assertions, all pass
- Test imports `splitPdfIntoPages`, `stitchPageOutputs`, `aggregateResults` from page-extraction.ts — no React, Prisma, Supabase, Next imports
- extractText PDF branch uses splitPdfIntoPages → extractAllPages → stitchPageOutputs → aggregateResults pipeline
- Per-page timeout = 45s (60s on final retry)
- Concurrency = 5 pages per batch
- Image branch unchanged
- classifyOcrResponse helper from 1.5d still present (used by image branch)
- All regression tests still pass; tsc silent
- ARCHITECTURE_STATE.md updated
- Branch pushed to origin

## Constraints

- Do NOT change the model. Haiku 4.5 stays.
- Do NOT redeploy. Deploy is Nils's manual step.
- Do NOT re-queue any document. Re-queue is Nils's manual step per the runbook.
- Do NOT remove classifyOcrResponse or extract-text-truncation.test.ts — they're still used by the image branch.
- Do NOT change the image branch logic.
- Pipe git commands through `| cat`.

## What this does NOT solve

- Sonnet's kaution miss on Paul (the "absent" trust gap). That's Task 1.5e — independent.
- Mietvertrag claim emission (Task 1.7).
- Human override path (Task 1.8).
- Pipeline-level 529 retry policy (memory #21). Page-level retry helps but isn't the same thing — page-level prevents one doc from killing the worker, pipeline-level prevents the job from going to dead_letter after 3 fast 529s. Both layers want hardening eventually.

## Risk register

| Risk | Mitigation |
|---|---|
| pdf-lib doesn't work cleanly in Deno | Verified by Anthropic API docs + community usage. Alternative: `pdfium-deno` if pdf-lib fails. |
| 5-way concurrency increases 529 rate per doc | Per-page retry handles it. If 529 rate explodes in practice, drop concurrency to 3 (single-line change). |
| Stitching seams confuse Sonnet downstream | Page boundary markers are clearly delimited and use German "Seite N" convention. Sonnet handles structured input well. Verify on real docs post-deploy. |
| Cost increase from per-page overhead | Marginal. Haiku is ~$1/M input tokens. Per-page overhead is the ~50-token system prompt × N pages = negligible at typical 5-15 page mietverträge. |
| Page-by-page loses cross-page context for Sonnet | OCR step doesn't need cross-page context (it just extracts text). Sonnet intelligence step gets the stitched OCR which preserves order and structure. No regression expected. |
