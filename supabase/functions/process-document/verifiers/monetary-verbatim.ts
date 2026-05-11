import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted monetary amount appears verbatim in the OCR text,
// formatted in either German style (1.234,56) or plain (1234,56 / 1234.56 / 1234).
//
// Rationale: monetary values are high-stakes — a hallucinated amount has direct
// financial consequences. If the value isn't present in the source text, the
// extraction is suspect regardless of the model's confidence rating.

export const monetaryVerbatim: Verifier = (ctx): VerifierResult => {
  const { ocr_text, field_envelope } = ctx;

  // For absence_state != present, this verifier does not apply.
  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  // Extract the amount as a number from normalized_value.
  // normalized_value shape (per prompt_fragment): { amount: <minor units>, currency: "EUR" }
  const nv = field_envelope.normalized_value as
    | { amount?: number; currency?: string }
    | null;

  if (!nv || typeof nv.amount !== "number") {
    return {
      passes: false,
      reason: "normalized_value missing or malformed (expected { amount: number, currency: string })",
    };
  }

  // Convert minor units to a major-unit decimal string.
  // €650.00 in minor units = 65000 → "650,00" (German) or "650.00" (plain)
  const major = nv.amount / 100;

  // Build the candidate string representations we might find in OCR text.
  // German style: 1.234,56 (thousands separator: ., decimal: ,)
  // Plain: 1234,56 or 1234.56 or 1234 (no separator)
  const candidates: string[] = [];

  // German formatted with thousands separator
  candidates.push(germanFormat(major));

  // Plain German (no thousands separator)
  candidates.push(major.toFixed(2).replace(".", ","));

  // Plain integer (when the value is a whole euro amount, the document may omit ",00")
  if (Number.isInteger(major)) {
    candidates.push(String(major));
  }

  // Some documents use US-style "650.00" or "1,234.56" — accept those too.
  candidates.push(major.toFixed(2));
  if (Number.isInteger(major)) {
    candidates.push(major.toFixed(0));
  }

  // Check each candidate against the OCR text.
  for (const candidate of candidates) {
    if (ocr_text.includes(candidate)) {
      return { passes: true };
    }
  }

  return {
    passes: false,
    reason: `extracted monetary value ${major.toFixed(2)} EUR not found verbatim in OCR text (checked: ${candidates.join(", ")})`,
  };
};

// Format a number in German style: thousands separator is ".", decimal is ",".
// e.g., 1234.56 → "1.234,56"; 650 → "650,00"
function germanFormat(major: number): string {
  const fixed = major.toFixed(2); // "1234.56"
  const [intPart, decPart] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withThousands},${decPart}`;
}
