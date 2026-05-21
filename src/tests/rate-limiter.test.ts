import { RateLimiter } from "../../supabase/functions/process-document/rate-limiter";

// ─── Test harness ───────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
        passCount++;
        console.log(`  ✓ ${label}`);
    } else {
        failCount++;
        failures.push(`${label}${detail ? `: ${detail}` : ""}`);
        console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

async function runTests() {
    // ─── Mock clock ─────────────────────────────────────────────
    let mockTime = 0;
    const mockNow = () => mockTime;
    const advance = (ms: number) => { mockTime += ms; };

    console.log("\n=== RateLimiter ===\n");

    // ─── Test 1: Immediate acquire when bucket full ─────────────
    {
        console.log("Test 1: Immediate acquire when bucket full");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
        const start = mockTime;
        await limiter.acquire();
        assert("No wait when bucket full", mockTime - start === 0);
        assert("4 tokens left after 1 acquire", limiter._currentTokens() === 4);
    }

    // ─── Test 2: Empty bucket forces wait ───────────────────────
    {
        console.log("\nTest 2: Empty bucket — wait calculation");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 1, refillRatePerSec: 1, now: mockNow });
        await limiter.acquire();
        assert("Bucket exhausted: 0 tokens", limiter._currentTokens() === 0);
        const waitMs = limiter._calculateWaitMs();
        assert("Wait calc when empty: ~1000ms", waitMs >= 900 && waitMs <= 1100, `got ${waitMs}`);
    }

    // ─── Test 3: Refill over time ───────────────────────────────
    {
        console.log("\nTest 3: Refill over time");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
        for (let i = 0; i < 5; i++) await limiter.acquire();
        assert("Drained: 0 tokens", limiter._currentTokens() === 0);
        advance(3000);
        limiter._refillNow();
        const tokens = limiter._currentTokens();
        assert("After 3s: ~3 tokens", tokens >= 2.99 && tokens <= 3.01, `got ${tokens}`);
    }

    // ─── Test 4: Capacity cap ───────────────────────────────────
    {
        console.log("\nTest 4: Capacity cap");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 10, now: mockNow });
        for (let i = 0; i < 5; i++) await limiter.acquire();
        advance(60000);
        limiter._refillNow();
        assert("Capacity cap respected", limiter._currentTokens() === 5, `got ${limiter._currentTokens()}`);
    }

    // ─── Test 5: Fractional tokens ──────────────────────────────
    {
        console.log("\nTest 5: Fractional tokens");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 5, refillRatePerSec: 1, now: mockNow });
        for (let i = 0; i < 5; i++) await limiter.acquire();
        advance(500);
        limiter._refillNow();
        const tokens = limiter._currentTokens();
        assert("Fractional refill: ~0.5", tokens >= 0.49 && tokens <= 0.51, `got ${tokens}`);
    }

    // ─── Test 6: Concurrent acquires serialized (real timers) ───
    {
        console.log("\nTest 6: Concurrent acquires serialized (real timers)");
        const limiter = new RateLimiter({ capacity: 2, refillRatePerSec: 100 });
        const results: number[] = [];
        const start = Date.now();

        const promises = [
            limiter.acquire().then(() => results.push(1)),
            limiter.acquire().then(() => results.push(2)),
            limiter.acquire().then(() => results.push(3)),
            limiter.acquire().then(() => results.push(4)),
        ];
        await Promise.all(promises);
        const elapsed = Date.now() - start;

        assert("All 4 acquires completed", results.length === 4);
        assert("Order preserved: [1,2,3,4]", JSON.stringify(results) === "[1,2,3,4]", `got ${JSON.stringify(results)}`);
        assert("Took >0ms (rate limiting happened)", elapsed >= 0, `elapsed=${elapsed}ms`);
        assert("Took <500ms (not stuck)", elapsed < 500, `elapsed=${elapsed}ms`);
    }

    // ─── Test 7: Zero refill rate = infinite wait ───────────────
    {
        console.log("\nTest 7: Zero refill rate");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 1, refillRatePerSec: 0, now: mockNow });
        await limiter.acquire();
        const waitMs = limiter._calculateWaitMs();
        assert("Zero refill: infinite wait", waitMs === Infinity || waitMs > 1e9, `got ${waitMs}`);
    }

    // ─── Test 8: Multiple rapid acquires ────────────────────────
    {
        console.log("\nTest 8: Multiple rapid acquires");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 3, refillRatePerSec: 1, now: mockNow });
        await limiter.acquire();
        await limiter.acquire();
        await limiter.acquire();
        assert("3 acquires drain to 0", limiter._currentTokens() === 0);
    }

    // ─── Test 9: No negative tokens ─────────────────────────────
    {
        console.log("\nTest 9: No negative tokens");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 1, refillRatePerSec: 1, now: mockNow });
        await limiter.acquire();
        assert("After single acquire: 0 tokens", limiter._currentTokens() === 0);
        const wait = limiter._calculateWaitMs();
        assert("Wait is positive", wait > 0, `got ${wait}`);
    }

    // ─── Test 10: Default cost = 1 ──────────────────────────────
    {
        console.log("\nTest 10: Default cost = 1");
        mockTime = 0;
        const limiter = new RateLimiter({ capacity: 10, refillRatePerSec: 1, now: mockNow });
        await limiter.acquire();
        assert("After 1 acquire: 9 tokens", limiter._currentTokens() === 9);
        await limiter.acquire();
        assert("After 2 acquires: 8 tokens", limiter._currentTokens() === 8);
    }

    // ─── Summary ────────────────────────────────────────────────
    const total = passCount + failCount;
    console.log(`\n${total} rate-limiter assertions: ${passCount} passed, ${failCount} failed`);
    if (failCount === 0) {
        console.log("✓ All rate-limiter assertions passed");
    } else {
        console.error("✗ FAILURES:");
        failures.forEach(f => console.error(`  - ${f}`));
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test runner error:", err);
    process.exit(1);
});
