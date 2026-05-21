import { PDFDocument } from "npm:pdf-lib@1.17.1";

// ─── Types ──────────────────────────────────────────────────────

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

// ─── Pure helpers ───────────────────────────────────────────────

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

// ─── Orchestrators (impure — network calls) ─────────────────────

/**
 * Call Haiku for a single page with retry + timeout.
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
                    max_tokens: 4000,
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
