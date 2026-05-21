import { callAnthropic, AnthropicClientError } from "../../supabase/functions/process-document/anthropic-client";

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

// ─── Fetch mock infrastructure ──────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchCallCount = 0;
type MockFetchHandler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
let mockFetchHandler: MockFetchHandler;

function mockFetch(handler: MockFetchHandler) {
    fetchCallCount = 0;
    mockFetchHandler = handler;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCallCount++;
        return mockFetchHandler(url, init);
    }) as typeof fetch;
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

function jsonResponse(body: object, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

const baseOpts = {
    model: "claude-haiku-4-5-20251001" as const,
    maxTokens: 200,
    apiKey: "test-key",
    messages: [{ role: "user" as const, content: "hello" }],
    timeoutMs: 5000,
    callLabel: "test",
};

async function runTests() {
    console.log("\n=== anthropic-client ===\n");

    // ─── Test 1: Success on first try ───────────────────────────
    {
        console.log("Test 1: Success on first try");
        mockFetch(() => Promise.resolve(jsonResponse({
            content: [{ text: "hello world" }],
            stop_reason: "end_turn",
        })));

        const result = await callAnthropic(baseOpts);
        assert("Returns response", result.content?.[0]?.text === "hello world");
        assert("Single fetch call", fetchCallCount === 1, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 2: 429 then 200 → retries, returns success ───────
    {
        console.log("\nTest 2: 429 then 200");
        let callNum = 0;
        mockFetch(() => {
            callNum++;
            if (callNum === 1) {
                return Promise.resolve(jsonResponse({ error: "rate_limited" }, 429));
            }
            return Promise.resolve(jsonResponse({
                content: [{ text: "success after retry" }],
                stop_reason: "end_turn",
            }));
        });

        const result = await callAnthropic(baseOpts);
        assert("Returns success after 429 retry", result.content?.[0]?.text === "success after retry");
        assert("Two fetch calls", fetchCallCount === 2, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 3: 529 then 200 → retries, returns success ───────
    {
        console.log("\nTest 3: 529 then 200");
        let callNum = 0;
        mockFetch(() => {
            callNum++;
            if (callNum === 1) {
                return Promise.resolve(jsonResponse({ error: "overloaded" }, 529));
            }
            return Promise.resolve(jsonResponse({
                content: [{ text: "success after 529" }],
                stop_reason: "end_turn",
            }));
        });

        const result = await callAnthropic(baseOpts);
        assert("Returns success after 529 retry", result.content?.[0]?.text === "success after 529");
        assert("Two fetch calls", fetchCallCount === 2, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 4: 429 x3 → throws AnthropicClientError ──────────
    {
        console.log("\nTest 4: 429 x3 exhausts retries");
        mockFetch(() => Promise.resolve(jsonResponse({ error: "rate_limited" }, 429)));

        try {
            await callAnthropic(baseOpts);
            assert("Should have thrown", false);
        } catch (err) {
            assert("Throws AnthropicClientError", err instanceof AnthropicClientError);
            if (err instanceof AnthropicClientError) {
                assert("Status is 429", err.httpStatus === 429, `got ${err.httpStatus}`);
                assert("attemptsUsed is 3", err.attemptsUsed === 3, `got ${err.attemptsUsed}`);
            }
        }
        assert("Three fetch calls", fetchCallCount === 3, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 5: 400 → throws immediately, no retry ────────────
    {
        console.log("\nTest 5: 400 fails fast");
        mockFetch(() => Promise.resolve(jsonResponse({ error: "bad_request" }, 400)));

        try {
            await callAnthropic(baseOpts);
            assert("Should have thrown", false);
        } catch (err) {
            assert("Throws AnthropicClientError", err instanceof AnthropicClientError);
            if (err instanceof AnthropicClientError) {
                assert("Status is 400", err.httpStatus === 400, `got ${err.httpStatus}`);
                assert("attemptsUsed is 1", err.attemptsUsed === 1, `got ${err.attemptsUsed}`);
            }
        }
        assert("Single fetch call (no retry)", fetchCallCount === 1, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 6: 401 → throws immediately, no retry ────────────
    {
        console.log("\nTest 6: 401 fails fast");
        mockFetch(() => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)));

        try {
            await callAnthropic(baseOpts);
            assert("Should have thrown", false);
        } catch (err) {
            assert("Throws AnthropicClientError", err instanceof AnthropicClientError);
            if (err instanceof AnthropicClientError) {
                assert("Status is 401", err.httpStatus === 401, `got ${err.httpStatus}`);
                assert("attemptsUsed is 1", err.attemptsUsed === 1, `got ${err.attemptsUsed}`);
            }
        }
        assert("Single fetch call (no retry)", fetchCallCount === 1, `got ${fetchCallCount}`);
        restoreFetch();
    }

    // ─── Test 7: Timeout → retries, then throws ────────────────
    {
        console.log("\nTest 7: Timeout → retry then throw");
        mockFetch(() => {
            // Simulate a timeout by returning a promise that never resolves
            // within the AbortController's timeout window
            return new Promise((_resolve, reject) => {
                // The AbortController will abort this, causing an AbortError
                const controller = new AbortController();
                controller.signal.addEventListener("abort", () => {
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                });
                // Never resolve naturally — wait for abort
                setTimeout(() => {
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                }, 100);
            });
        });

        try {
            await callAnthropic({ ...baseOpts, timeoutMs: 50 });
            assert("Should have thrown", false);
        } catch (err) {
            assert("Throws AnthropicClientError", err instanceof AnthropicClientError);
            if (err instanceof AnthropicClientError) {
                assert("Message mentions timeout", err.message.includes("timeout"), `got: ${err.message}`);
                assert("attemptsUsed is 3", err.attemptsUsed === 3, `got ${err.attemptsUsed}`);
            }
        }
        restoreFetch();
    }

    // ─── Test 8: Response body is parsed correctly ──────────────
    {
        console.log("\nTest 8: Response parsing");
        mockFetch(() => Promise.resolve(jsonResponse({
            content: [{ text: "parsed correctly" }],
            stop_reason: "max_tokens",
            id: "msg_123",
        })));

        const result = await callAnthropic(baseOpts);
        assert("stop_reason parsed", result.stop_reason === "max_tokens");
        assert("content text parsed", result.content?.[0]?.text === "parsed correctly");
        restoreFetch();
    }

    // ─── Summary ────────────────────────────────────────────────
    const total = passCount + failCount;
    console.log(`\n${total} anthropic-client assertions: ${passCount} passed, ${failCount} failed`);
    if (failCount === 0) {
        console.log("✓ All anthropic-client assertions passed");
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
