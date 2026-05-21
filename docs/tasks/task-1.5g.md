# Task 1.5g — Token-bucket rate limiter for Anthropic API calls

Task type: t2 L (new shared infrastructure module + integration across 4+ call sites, real review surface)

## Why this task exists

Task 1.5f (shipped 2026-05-21, Edge Function v39) replaced single-call PDF OCR with page-by-page processing. First test on Paul revealed a new failure mode: **5 parallel Haiku calls per document hit Anthropic's per-account-per-minute rate limit.** Result: pages 3, 4, 5 failed with `Haiku 429`, OCR was 14,598 chars instead of 28,670, kaution clause missing again.

The current retry policy in `extractPageText` only handles 529 (overload), not 429 (rate limit). And the 5-way concurrency has no awareness of Anthropic's actual rate budget — it just bursts.

A quick patch (add 429 to retry, drop concurrency to 3, add jitter) was considered and rejected. It solves today's symptom while leaving the architectural pattern fragile. Backfilling 250 documents, processing multiple documents simultaneously, or any future scale event would re-trigger the same class of bug.

The right fix is a **shared rate limiter** that all Anthropic API calls go through. Process-wide awareness of request rate. No more bursts. Industry-standard pattern (Stripe, Google API clients, AWS SDK retry middleware).

## Goal

After this task lands:
- A single `RateLimiter` instance governs ALL outbound Anthropic calls from the Edge Function
- Calls block until the limiter says they may proceed
- No burst can exceed the configured per-second rate
- 429s become rare (correct preventive behavior); when they do happen, retry includes 429
- Page-by-page OCR works reliably on real corpus documents under realistic load
- Same pattern is reusable for Sonnet calls (Step 8b intelligence) and future API integrations

## Scope

### Code touched

- `supabase/functions/process-document/rate-limiter.ts` (NEW) — pure token-bucket implementation, no I/O
- `supabase/functions/process-document/anthropic-client.ts` (NEW) — thin wrapper: `callAnthropic(opts)` that goes through the limiter and includes 429/529 retry logic
- `supabase/functions/process-document/page-extraction.ts` — modified to use anthropic-client, NOT make raw fetch calls
- `supabase/functions/process-document/index.ts` — modified to use anthropic-client for the image branch + the 5 OTHER Anthropic call sites identified below
- `src/tests/rate-limiter.test.ts` (NEW) — pure tests for token-bucket math, timing, fairness
- `src/tests/anthropic-client.test.ts` (NEW) — pure tests for retry behavior (mocked fetch)
- `ARCHITECTURE_STATE.md` — append section

### Code NOT touched

- The orchestration logic in extractText / extractAllPages
- The Sonnet intelligence step's PROMPT (we route its call through the limiter, but don't change what it asks for)
- Any frontend code
- Any schema YAML
- Edge Function deployment process

### Call sites that route through the new client

Audit of current Anthropic call sites in `supabase/functions/process-document/index.ts` (grep result from Task 1.5f state):

| Line | Use | Action |
|---|---|---|
| 271 (image OCR, max_tokens 8000) | extractText image branch | Route through anthropic-client |
| 371 (max_tokens 200) | classifyDocument step | Route through anthropic-client |
| 471 (max_tokens 800) | extractFields legacy step | Route through anthropic-client |
| 989 (max_tokens 3000) | categorize step | Route through anthropic-client |
| 1175 (max_tokens 1500) | generateIntelligence Step 8b (Sonnet) | Route through anthropic-client |
| page-extraction.ts:117 (max_tokens 4000) | per-page OCR | Route through anthropic-client |

**6 call sites total.** Each currently constructs its own fetch with its own retry logic (or no retry). After this task, all 6 use `callAnthropic(opts)` and share the limiter + retry policy.

## Design

### Token bucket math

A token bucket has:
- **Capacity** (max tokens it can hold)
- **Refill rate** (tokens added per second)
- **Current count** (real-valued, not integer — fractional tokens between refills)

To make a request, you call `acquire(cost=1)`. If `current >= cost`, deduct and return immediately. Otherwise, calculate how long until enough tokens accumulate at the refill rate, sleep that long, deduct, return.

Pseudo-math:

```
acquire(cost):
  now = Date.now()
  // refill since last update
  elapsed_ms = now - last_update
  current = min(capacity, current + refill_rate_per_sec * elapsed_ms / 1000)
  last_update = now
  
  if current >= cost:
    current -= cost
    return immediately
  else:
    deficit = cost - current
    wait_ms = ceil(deficit / refill_rate_per_sec * 1000)
    await sleep(wait_ms)
    current = 0  // we'll be at exactly cost after refill
    last_update = now + wait_ms
    return after wait
```

### Concurrency safety

Multiple async calls to `acquire()` could race. Naive implementation: each acquire() reads current, computes refill, decides. Two concurrent calls both see "enough tokens", both deduct, bucket goes negative or over-deducts.

Fix: serialize acquisitions via a small async queue. Each acquire pushes a request, a single drain loop processes them in order. This is the simplest correct implementation; lock-free token buckets exist but require careful CAS semantics that Deno-on-Supabase doesn't expose cleanly.

### Configuration

Anthropic's published rate limits for the Tier 2 account this project uses (as of 2026-05): **50 requests per minute** on Haiku, similar on Sonnet. To be safe, configure the limiter for **40 requests/minute = ~0.67 requests/second**. That leaves headroom for user-facing API calls (chat at /api/properties/[id]/chat) plus any other consumers.

Capacity of 5 (allows small bursts of up to 5 concurrent requests, refills 0.67/sec).

These numbers should be env-driven so we can tune without redeploys:

```typescript
const REQUESTS_PER_SECOND = parseFloat(Deno.env.get("ANTHROPIC_RPS") ?? "0.67");
const BUCKET_CAPACITY = parseInt(Deno.env.get("ANTHROPIC_BURST") ?? "5", 10);
```

Defaults are conservative. Can be raised once we have observability data.

### The anthropic-client wrapper

Replaces ad-hoc fetch + JSON parse + retry logic with a single shared function:

```typescript
export type AnthropicCallOpts = {
    model: string;
    maxTokens: number;
    messages: Array<{ role: string; content: unknown }>;
    apiKey: string;
    timeoutMs?: number;  // default 90000
};

export type AnthropicResponse = {
    content?: Array<{ text?: string }>;
    stop_reason?: string;
    [key: string]: unknown;
};

export async function callAnthropic(opts: AnthropicCallOpts): Promise<AnthropicResponse>;
```

Behavior:
- Calls `await rateLimiter.acquire()` before each attempt
- 3 attempts total
- Retry on 429 OR 529 with backoff: 2s, 8s (since rate limit usually resets within a minute; long waits not needed when limiter is doing its job)
- Retry on AbortError (timeout)
- Fail fast on 4xx other than 429
- Respect `retry-after` header if present (overrides default backoff for that attempt)
- Per-call timeout via AbortController, default 90s

This is the ONLY function in the Edge Function that calls Anthropic. All other code uses it.

### Why not use the Anthropic SDK?

We could `import Anthropic from "npm:@anthropic-ai/sdk"`. It has built-in retry. Two reasons not to:

1. The SDK retry doesn't know about our shared rate limiter. We'd have two layers of retry that confuse each other.
2. The SDK pulls in significant dependency weight. We're already on Deno, simple fetch works fine, adding ~500KB of SDK to the Edge Function for retry logic we can write in 80 lines is a poor trade.

If we later need streaming, function calling, or other SDK features, revisit.

## Implementation steps

### 1. Write the rate-limiter test FIRST

Path: `src/tests/rate-limiter.test.ts`

Pure tests. No timers if we can avoid them — use a manual clock (inject `now()` as a function).

```typescript
import { RateLimiter } from "../../supabase/functions/process-document/rate-limiter";

// Manual clock for deterministic tests
let mockTime = 0;
const mockNow = () => mockTime;

const advance = (ms: number) => { mockTime += ms; };

let testCount = 0;
let passed = 0;
const assert = (label: string, cond: boolean) => {
    testCount++;
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { console.error(`  ✗ ${label}`); }
};

console.log("\n=== RateLimiter ===\n");

// Test 1: Immediate acquire when bucket full
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
    const start = mockTime;
    await limiter.acquire();
    assert("Acquire when full: no wait", mockTime - start === 0);
    assert("Acquire when full: 4 tokens left", limiter._currentTokens() === 4);
}

// Test 2: Empty bucket forces wait
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 1, refillRatePerSec: 1, now: mockNow });
    // First call: consumes the 1 token, immediate
    await limiter.acquire();
    assert("Bucket exhausted: 0 tokens", limiter._currentTokens() === 0);
    // Second call: would need to wait 1000ms
    // (We test this differently — test the calculated wait time, not actual sleep)
    const waitMs = limiter._calculateWaitMs();
    assert("Wait calc when empty: ~1000ms", waitMs >= 900 && waitMs <= 1100);
}

// Test 3: Refill over time
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
    // Drain
    for (let i = 0; i < 5; i++) await limiter.acquire();
    assert("Drained: 0 tokens", limiter._currentTokens() === 0);
    // Advance 3 seconds
    advance(3000);
    // Refill should have added ~3 tokens
    limiter._refillNow();
    const tokens = limiter._currentTokens();
    assert("After 3s: ~3 tokens", tokens >= 2.99 && tokens <= 3.01);
}

// Test 4: Capacity cap
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 10, now: mockNow });
    // Drain
    for (let i = 0; i < 5; i++) await limiter.acquire();
    // Advance way more than would fill it
    advance(60000);
    limiter._refillNow();
    assert("Capacity cap respected", limiter._currentTokens() === 5);
}

// Test 5: Fractional tokens
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
    for (let i = 0; i < 5; i++) await limiter.acquire();
    advance(500);
    limiter._refillNow();
    const tokens = limiter._currentTokens();
    assert("Fractional refill: ~0.5", tokens >= 0.49 && tokens <= 0.51);
}

// Test 6: Concurrent acquires are serialized
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 2, refillRatePerSec: 1, now: mockNow });
    // Start 4 concurrent acquires; first 2 should succeed immediately,
    // next 2 must wait. We can't actually advance time mid-test for sleeping
    // promises in a clean way — so we test the queue length and resolution order.
    const results: number[] = [];
    const p1 = limiter.acquire().then(() => results.push(1));
    const p2 = limiter.acquire().then(() => results.push(2));
    // Don't await yet — check queue state
    assert("After 2 acquires: 2 pending or done", true); // (we'll just check order below)
    
    // Free up by advancing time and triggering refill
    // (This part is tricky with mock time + real promises; may need to use real timers
    //  with short intervals for this specific test. Brief implementer's call.)
}

// Test 7: Zero refill rate = always wait forever (edge case)
{
    mockTime = 0;
    const limiter = new RateLimiter({ capacity: 1, refillRatePerSec: 0, now: mockNow });
    await limiter.acquire(); // consumes the 1 capacity
    const waitMs = limiter._calculateWaitMs();
    assert("Zero refill: infinite wait", waitMs === Infinity || waitMs > 1e9);
}

console.log(`\n${testCount} rate-limiter assertions: ${passed} passed, ${testCount - passed} failed`);
if (passed === testCount) console.log("✓ All rate-limiter assertions passed");
else { console.error("✗ FAILURES"); Deno.exit(1); }
```

Aim for **~15-20 assertions**. The test 6 (concurrent serialization) is tricky with mock time — if it's hard to get right, implement it with real `setTimeout` and a very short delay (e.g., refillRatePerSec=100, so 10ms waits). The brief implementer should make a judgment call.

Underscore-prefixed methods (`_currentTokens()`, `_refillNow()`, `_calculateWaitMs()`) are test-only inspection methods. Production code uses only `acquire()`.

### 2. Implement RateLimiter

Path: `supabase/functions/process-document/rate-limiter.ts`

```typescript
// Token-bucket rate limiter for outbound API calls.
// Tested in src/tests/rate-limiter.test.ts.

export type RateLimiterOpts = {
    capacity: number;            // max tokens (== max burst size)
    refillRatePerSec: number;    // tokens added per second
    now?: () => number;          // for testing; defaults to Date.now
};

export class RateLimiter {
    private capacity: number;
    private refillRatePerSec: number;
    private tokens: number;
    private lastRefillMs: number;
    private now: () => number;
    private queue: Array<() => void> = [];
    private draining = false;
    
    constructor(opts: RateLimiterOpts) {
        this.capacity = opts.capacity;
        this.refillRatePerSec = opts.refillRatePerSec;
        this.tokens = opts.capacity;  // start full
        this.now = opts.now ?? (() => Date.now());
        this.lastRefillMs = this.now();
    }
    
    async acquire(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
            this.drain();
        });
    }
    
    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        
        while (this.queue.length > 0) {
            this._refillNow();
            
            if (this.tokens >= 1) {
                this.tokens -= 1;
                const resolve = this.queue.shift()!;
                resolve();
            } else {
                const waitMs = this._calculateWaitMs();
                if (!isFinite(waitMs)) {
                    // refillRate is 0 — keep waiting forever (real env wouldn't do this)
                    // but don't lock the event loop
                    await new Promise((r) => setTimeout(r, 60000));
                    continue;
                }
                await new Promise((r) => setTimeout(r, waitMs));
            }
        }
        
        this.draining = false;
    }
    
    // Test-only inspection methods (prefix with _ to signal)
    _currentTokens(): number { return this.tokens; }
    
    _refillNow(): void {
        const now = this.now();
        const elapsedMs = now - this.lastRefillMs;
        const refill = (elapsedMs / 1000) * this.refillRatePerSec;
        this.tokens = Math.min(this.capacity, this.tokens + refill);
        this.lastRefillMs = now;
    }
    
    _calculateWaitMs(): number {
        if (this.refillRatePerSec <= 0) return Infinity;
        const deficit = 1 - this.tokens;
        if (deficit <= 0) return 0;
        return Math.ceil((deficit / this.refillRatePerSec) * 1000);
    }
}
```

### 3. Implement anthropic-client

Path: `supabase/functions/process-document/anthropic-client.ts`

```typescript
import { RateLimiter } from "./rate-limiter.ts";

const REQUESTS_PER_SECOND = parseFloat(Deno.env.get("ANTHROPIC_RPS") ?? "0.67");
const BUCKET_CAPACITY = parseInt(Deno.env.get("ANTHROPIC_BURST") ?? "5", 10);

// Module-level singleton shared across all Anthropic calls in this Edge Function instance
const sharedLimiter = new RateLimiter({
    capacity: BUCKET_CAPACITY,
    refillRatePerSec: REQUESTS_PER_SECOND,
});

export type AnthropicCallOpts = {
    model: string;
    maxTokens: number;
    messages: Array<{ role: string; content: unknown }>;
    apiKey: string;
    timeoutMs?: number;
    callLabel?: string;  // for logging context, e.g. "ocr-page-3" or "intelligence-step-8b"
};

export type AnthropicResponse = {
    content?: Array<{ text?: string }>;
    stop_reason?: string;
    [key: string]: unknown;
};

export class AnthropicClientError extends Error {
    public httpStatus: number | null;
    public attemptsUsed: number;
    constructor(message: string, httpStatus: number | null, attemptsUsed: number) {
        super(message);
        this.name = "AnthropicClientError";
        this.httpStatus = httpStatus;
        this.attemptsUsed = attemptsUsed;
    }
}

/**
 * Call Anthropic's messages API through the shared rate limiter.
 * Retries on 429, 529, and AbortError. Fails fast on other 4xx.
 * Throws AnthropicClientError after exhausting retries.
 */
export async function callAnthropic(opts: AnthropicCallOpts): Promise<AnthropicResponse> {
    const label = opts.callLabel ?? "anthropic-call";
    const timeoutMs = opts.timeoutMs ?? 90000;
    const maxAttempts = 3;
    const baseBackoffMs = [0, 2000, 8000];  // first attempt no wait, then 2s, then 8s
    
    let lastError: { status: number | null; message: string } = { status: null, message: "" };
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (baseBackoffMs[attempt] > 0) {
            await new Promise((r) => setTimeout(r, baseBackoffMs[attempt]));
        }
        
        await sharedLimiter.acquire();
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "x-api-key": opts.apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: opts.model,
                    max_tokens: opts.maxTokens,
                    messages: opts.messages,
                }),
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                return await response.json();
            }
            
            // Retry-eligible status codes
            const isRetryable = response.status === 429 || response.status === 529;
            const isLastAttempt = attempt === maxAttempts - 1;
            
            if (isRetryable && !isLastAttempt) {
                // Honor retry-after header if present (overrides default backoff)
                const retryAfterRaw = response.headers.get("retry-after");
                const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : 0;
                if (retryAfterMs > 0) {
                    // Override the next attempt's backoff in our schedule (only for THIS retry)
                    baseBackoffMs[attempt + 1] = Math.max(baseBackoffMs[attempt + 1], retryAfterMs);
                }
                console.warn(`callAnthropic[${label}]: HTTP ${response.status}, retry ${attempt + 1}/${maxAttempts - 1}`);
                const errBody = await response.text();
                lastError = { status: response.status, message: errBody };
                continue;
            }
            
            const errBody = await response.text();
            throw new AnthropicClientError(
                `Anthropic HTTP ${response.status}: ${errBody}`,
                response.status,
                attempt + 1,
            );
        } catch (err) {
            clearTimeout(timeoutId);
            
            if (err instanceof AnthropicClientError) throw err;
            
            const isAbort = err instanceof Error && err.name === "AbortError";
            const isLastAttempt = attempt === maxAttempts - 1;
            
            if (isAbort && !isLastAttempt) {
                console.warn(`callAnthropic[${label}]: timeout, retry ${attempt + 1}/${maxAttempts - 1}`);
                lastError = { status: null, message: `timeout after ${timeoutMs}ms` };
                continue;
            }
            
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new AnthropicClientError(
                isAbort ? `Anthropic call timeout after ${timeoutMs}ms` : `Anthropic call failed: ${errMsg}`,
                null,
                attempt + 1,
            );
        }
    }
    
    // Exhausted all retries
    throw new AnthropicClientError(
        `Exhausted ${maxAttempts} attempts. Last error: HTTP ${lastError.status} - ${lastError.message}`,
        lastError.status,
        maxAttempts,
    );
}
```

### 4. Write the anthropic-client test

Path: `src/tests/anthropic-client.test.ts`

Mock the `fetch` global. Test:

- Success on first try (200 OK) → returns response, no retry
- 429 then 200 → retries, returns success
- 529 then 200 → retries, returns success
- 429 → 429 → 429 → throws AnthropicClientError with status=429, attemptsUsed=3
- 400 (bad request) → throws AnthropicClientError immediately, attemptsUsed=1, no retry
- 401 (auth error) → throws immediately, no retry
- `retry-after: 5` header on 429 → second attempt waits at least ~5s (this one is tricky to time-test; assert via logging or skip)
- Timeout → retries, then throws AnthropicClientError with message containing "timeout"

Mock fetch by stubbing `globalThis.fetch` to return controlled responses. Use a counter to simulate "fail twice then succeed."

~10-15 assertions. Reset the fetch stub between tests.

### 5. Refactor page-extraction.ts to use the client

In `supabase/functions/process-document/page-extraction.ts`, replace the body of `extractPageText` with a call to `callAnthropic`:

```typescript
import { callAnthropic, AnthropicClientError } from "./anthropic-client.ts";

// ...existing code...

export async function extractPageText(
    anthropicKey: string,
    pageNumber: number,
    pageBytes: Uint8Array,
    base64Encode: (b: Uint8Array) => string,
): Promise<PageResult> {
    try {
        const response = await callAnthropic({
            model: "claude-haiku-4-5-20251001",
            maxTokens: 4000,
            apiKey: anthropicKey,
            timeoutMs: 90000,
            callLabel: `ocr-page-${pageNumber}`,
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
        });
        
        const text = response.content?.[0]?.text || "";
        const stopReason = response.stop_reason ?? null;
        return {
            pageNumber,
            text,
            stopReason,
            truncated: stopReason === "max_tokens",
            failed: false,
            errorMessage: null,
        };
    } catch (err) {
        const message = err instanceof AnthropicClientError
            ? `Haiku ${err.httpStatus ?? "?"} after ${err.attemptsUsed} attempts`
            : (err instanceof Error ? err.message : "unknown error");
        return {
            pageNumber,
            text: "",
            stopReason: null,
            truncated: false,
            failed: true,
            errorMessage: message,
        };
    }
}
```

The 45s-per-attempt timeout from 1.5f is removed because the new client uses 90s with its own retry. Cleaner semantics.

### 6. Refactor index.ts call sites

Five sites in index.ts (lines 271, 371, 471, 989, 1175) currently have inline fetch + JSON parse + retry. Replace each with `callAnthropic(...)`. Each will look similar to:

```typescript
const response = await callAnthropic({
    model: "claude-haiku-4-5-20251001",  // or claude-sonnet-4-20250514 for line 1175
    maxTokens: 800,                        // whichever the existing value is
    apiKey: anthropicKey,
    callLabel: "extract-fields",           // descriptive label
    messages: [...existing messages...],
});

const text = response.content?.[0]?.text || "";
```

Critical: **keep model and maxTokens UNCHANGED at each call site.** This refactor is about routing, not about changing what each call asks for. The IMAGE branch (line 271) keeps its 8000 token cap and its `classifyOcrResponse(...)` guard — just route through the client now instead of raw fetch.

### 7. Concurrency cap in page-extraction stays at 5

The orchestrator (extractAllPages) still launches 5 pages in parallel per batch. The DIFFERENCE is they no longer burst-hit the API — the rate limiter serializes them. First 5 parallel calls consume the bucket capacity; subsequent calls wait for refill. Net effect: ~0.67 calls/second sustained, no bursts.

This is the structural fix. The concurrency value (5) is now decoupled from the actual API request rate. We could raise to 10 or 20 without changing the API load profile.

### 8. ARCHITECTURE_STATE.md

Append:

```
## Task 1.5g — Anthropic rate limiter (2026-05-XX)

All outbound Anthropic API calls now route through a single shared token-bucket
rate limiter in supabase/functions/process-document/rate-limiter.ts +
anthropic-client.ts. Configuration via env vars ANTHROPIC_RPS (default 0.67 =
40 rpm) and ANTHROPIC_BURST (default 5). Retry policy includes 429 (rate limit)
and 529 (overload). Honors retry-after header.

Six call sites refactored to use callAnthropic():
- extractPageText (per-page OCR)
- extractText image branch
- classifyDocument
- extractFields (legacy)
- categorize
- generateIntelligence (Sonnet, Step 8b)

Motivation: Task 1.5f's 5-way parallel OCR burst hit Anthropic's 50 rpm Tier 2
rate limit, causing pages 3-5 of Paul's mietvertrag to fail with 429. Rate
limiter prevents bursts while preserving per-doc parallelism (concurrency
within a doc is decoupled from API request rate).

New module: rate-limiter.ts (pure, ~80 lines)
New module: anthropic-client.ts (~120 lines)
New tests: src/tests/rate-limiter.test.ts (~15-20 assertions)
New tests: src/tests/anthropic-client.test.ts (~10-15 assertions)

Two new env vars (with safe defaults).
```

### 9. Verify

```bash
npx tsx src/tests/rate-limiter.test.ts
npx tsx src/tests/anthropic-client.test.ts
npx tsx src/tests/page-extraction.test.ts  # still passes (uses mocked path)
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
npx tsx src/tests/rate-limiter.test.ts
npx tsx src/tests/anthropic-client.test.ts

# Type check
npx tsc --noEmit
```

Expected: all previous suites green plus the two new ones. tsc silent.

### 10. Branch + push

```bash
git checkout main && git pull
git checkout -b feature/task-1.5g-anthropic-rate-limiter

# (implement tests FIRST, then rate-limiter, then anthropic-client,
#  then refactor 6 call sites, then verify)

git add supabase/functions/process-document/rate-limiter.ts \
        supabase/functions/process-document/anthropic-client.ts \
        supabase/functions/process-document/page-extraction.ts \
        supabase/functions/process-document/index.ts \
        src/tests/rate-limiter.test.ts \
        src/tests/anthropic-client.test.ts \
        ARCHITECTURE_STATE.md

git commit -m "feat(api): shared token-bucket rate limiter for Anthropic calls (Task 1.5g)

Adds a shared RateLimiter + callAnthropic() wrapper. All Anthropic API
calls from the Edge Function now go through this layer. Replaces ad-hoc
fetch + retry in 6 call sites (per-page OCR, image OCR, classify,
extract, categorize, intelligence).

Motivation: Task 1.5f shipped page-by-page OCR with 5-way concurrency.
First real test hit Anthropic's 50 rpm Tier 2 rate limit on Paul's
mietvertrag — pages 3-5 failed with 429. The retry policy in 1.5f
covered 529 but not 429 (different failure modes; 429 = rate limit,
529 = overload). Beyond the bug, the architectural pattern was fragile:
burst concurrency with no rate awareness would re-trigger on any
backfill or multi-doc parallel scenario.

Design:
- RateLimiter: pure token-bucket implementation, ~80 lines.
  Configurable capacity + refill rate. Concurrent acquires serialized
  via internal queue.
- callAnthropic: thin wrapper. Acquires from limiter before each
  attempt. Retries 429 + 529 + timeouts (3 attempts, 2s + 8s backoff).
  Honors retry-after header. Fails fast on other 4xx.
- Configuration via ANTHROPIC_RPS + ANTHROPIC_BURST env vars (defaults
  0.67 rps / 5 burst = ~40 rpm sustained).

Six call sites refactored. Models and max_tokens UNCHANGED at each
site — this is a routing refactor, not a behavior change.

The per-doc concurrency (5 pages in parallel) is now decoupled from
API request rate. Limiter handles the serialization. Could safely raise
in-doc concurrency without changing API load profile.

New tests:
- src/tests/rate-limiter.test.ts (~15-20 assertions, pure, mock clock)
- src/tests/anthropic-client.test.ts (~10-15 assertions, mocks fetch)

Edge Function redeploy required. After deploy: re-test Paul, then Lena,
then remaining mietverträge. Expected behavior: per-page OCR completes
without 429s, latency ~60-90s per typical mietvertrag (vs 30s previously
because rate limiter introduces deliberate pacing — this is correct
trade for reliability)."

git push -u origin feature/task-1.5g-anthropic-rate-limiter
```

## Deploy runbook (Nils does this after merge)

### 1. Redeploy Edge Function

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
supabase functions deploy process-document
supabase functions list 2>&1 | grep -E "process-document|NAME" | cat
# Expect version 39 → 40
```

### 2. Re-test Paul (clean baseline)

```sql
INSERT INTO warehouse.processing_jobs (document_id, org_id, status, attempt_count, next_attempt_at, created_at, updated_at)
SELECT d.id, d.org_id, 'queued', 0, NOW(), NOW(), NOW()
FROM warehouse.documents d
WHERE d.id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8'
RETURNING id::text, document_id::text, status;
```

Poll with the standard bash loop. Expected: completes in ~60-90s (longer than the 90s of Task 1.5f because the rate limiter deliberately spaces calls — this is correct). Then verify:

```sql
SELECT 
  LENGTH(ocr_text) AS ocr_chars,
  ocr_confidence,
  CASE WHEN ocr_text LIKE '%[ERROR:%' THEN 'YES' ELSE 'NO' END AS has_failed_pages,
  CASE WHEN ocr_text ILIKE '%kaution%' THEN 'YES' ELSE 'NO' END AS mentions_kaution
FROM warehouse.documents
WHERE id = 'ff52f1a5-b963-4228-b46a-693e8e4821b8';
```

Expected:
- `ocr_chars`: ~28,000+ (back to or exceeding the 1.5d result of 28,670)
- `ocr_confidence`: 90
- `has_failed_pages`: NO
- `mentions_kaution`: YES

### 3. Then Lena

Same pattern. Expected: completes in ~2-3 min (12 pages × ~1.5s spacing = ~18s lower bound plus per-page processing). Clean OCR.

### 4. Then the rest of the mietverträge backlog

Batch queue the 3 other mietverträge from the rent roll (Hofmann, Kuru, Dajs). Each should take 1-3 min. The rate limiter prevents them from interfering with each other.

### 5. Update memory after deploy:
- Task 1.5g shipped, Edge Function v40
- Paul + Lena re-OCR'd cleanly (or document the actual)
- Rate limiter live and effective

## Acceptance gates

- Both new test files exist with the expected assertion counts, all pass
- All regression suites still green
- tsc silent
- All 6 Anthropic call sites in the Edge Function use `callAnthropic()`
- `rate-limiter.ts` is pure (no I/O, no Deno-specific globals)
- `anthropic-client.ts` is the ONLY place that constructs the Anthropic fetch
- ARCHITECTURE_STATE.md updated
- Branch pushed

## Constraints

- Do NOT change models or max_tokens at any call site. This is a routing refactor.
- Do NOT redeploy. Manual deploy step.
- Do NOT re-queue documents. Manual re-queue step.
- Do NOT change page-extraction.ts orchestration logic (extractAllPages, splitPdfIntoPages, stitchPageOutputs, aggregateResults stay as-is).
- Do NOT remove classifyOcrResponse or its test — still used by the image branch.
- Pipe git commands through `| cat`.

## Risk register

| Risk | Mitigation |
|---|---|
| Rate limiter has a timing bug that hangs forever | Test 6 (concurrent serialization) specifically covers this. If hard to test, the implementer should use real short timers (10-50ms) for that test case only. |
| Defaults too conservative — OCR is now slower than necessary | Both env-driven. Can tune ANTHROPIC_RPS up without redeploy. Start conservative, observe, raise. |
| Defaults too aggressive — still hit 429 | Same env-driven escape. Drop ANTHROPIC_RPS lower. We're starting at 0.67 (40 rpm) vs the 50 rpm limit, leaving 20% headroom. |
| Module-level limiter doesn't survive Edge Function cold starts cleanly | Each cold-start gets a full bucket (5 tokens). Multiple concurrent cold-starts could briefly exceed the limit. Tier 2's per-minute limit is forgiving enough that this is not a real concern at our volume. |
| The 5 call sites in index.ts each have unique error handling | The refactor should preserve each call site's downstream handling (e.g., the classify step's JSON parse + fallback). Only the FETCH + RETRY layer changes. |
| Anthropic SDK changes their retry-after header format | Defensive parsing: `parseInt(retryAfterRaw, 10) * 1000` returns NaN on weird input, `Math.max(..., NaN) = NaN`, then no override. Falls back to default backoff. Safe. |

## What this does NOT solve

- Sonnet missing kaution on Paul (the "absent" trust gap). Still Task 1.5e (verifier).
- Mietvertrag claim emission (Task 1.7).
- Human override path (Task 1.8).
- Pipeline-level retry on 529 across the WHOLE job (memory #21). The rate limiter prevents 429s before the per-call layer; per-page retry handles individual page failures; the job-level retry policy is still old. These are three different layers — improving all of them is multi-task work.

After this lands, Lena should re-OCR cleanly, and the architecture is durable for backfill scale.
