// Thin wrapper for Anthropic API calls with shared rate limiter + retry.
// Tested in src/tests/anthropic-client.test.ts.

import { RateLimiter } from "./rate-limiter.ts";

// Environment-driven configuration (Deno Edge Function context).
// Safe fallback when running under Node.js (tests).
function getEnv(key: string, fallback: string): string {
    try {
        // deno-lint-ignore no-explicit-any
        const denoEnv = (globalThis as any).Deno?.env?.get(key);
        return denoEnv ?? fallback;
    } catch {
        return fallback;
    }
}

const REQUESTS_PER_SECOND = parseFloat(getEnv("ANTHROPIC_RPS", "0.67"));
const BUCKET_CAPACITY = parseInt(getEnv("ANTHROPIC_BURST", "5"), 10);

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
    callLabel?: string;
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
    const backoffMs = [0, 2000, 8000];

    let lastError: { status: number | null; message: string } = { status: null, message: "" };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (backoffMs[attempt] > 0) {
            await new Promise((r) => setTimeout(r, backoffMs[attempt]));
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

            const isRetryable = response.status === 429 || response.status === 529;
            const isLastAttempt = attempt === maxAttempts - 1;

            if (isRetryable && !isLastAttempt) {
                const retryAfterRaw = response.headers.get("retry-after");
                const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : 0;
                if (retryAfterMs > 0 && attempt + 1 < maxAttempts) {
                    backoffMs[attempt + 1] = Math.max(backoffMs[attempt + 1], retryAfterMs);
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
