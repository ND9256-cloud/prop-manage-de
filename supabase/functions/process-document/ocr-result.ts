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
    const confidence = truncated ? 60 : nominalConfidence;
    return { text, confidence, truncated, stopReason };
}
