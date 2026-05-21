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
                    // refillRate is 0 — don't lock the event loop
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
        if (elapsedMs <= 0) return;
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
