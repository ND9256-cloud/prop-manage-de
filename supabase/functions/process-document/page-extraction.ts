import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { callAnthropic, AnthropicClientError } from "./anthropic-client.ts";

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
 * Call Haiku for a single page via the shared rate-limited client.
 */
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
