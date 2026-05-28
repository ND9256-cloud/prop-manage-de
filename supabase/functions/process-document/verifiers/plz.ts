// PLZ (German postal code) verifier — architecture §10.
//
// Checks an extracted German address PLZ against a static lookup of all valid
// 5-digit German postal codes, each mapped to its Bundesland. Two failure modes:
//   1. The PLZ is not a valid German postal code (e.g. the hallucinated "36270")
//   2. The PLZ is valid but its Bundesland contradicts the expected Bundesland
//      for the address (when an expected Bundesland is known)
//
// On failure the verifier downgrades confidence to "low" and sets
// validation_status to "requires_human_review" (§10 — the Kuru case).
//
// PROVIDER-AGNOSTIC (§9.3): this file references field semantics only. It must
// contain no model-specific identifiers. The CI scan
// (verifiers-no-model-identifiers.test.ts) enforces this.

import type { Verifier, VerifierResult } from "./types.ts";
import plzBundesland from "../../../../data/plz-bundesland.json" with { type: "json" };

const PLZ_TABLE: Record<string, string> = plzBundesland as Record<string, string>;

export interface PlzCheckResult {
  ok: boolean;
  reason: "valid" | "not_found" | "bundesland_mismatch";
  plz: string;
  found_bundesland: string | null;
  expected_bundesland: string | null;
}

// Pure core — no I/O, fully deterministic. Easy to unit-test in isolation.
export function checkPlz(
  rawPlz: string,
  expectedBundesland?: string | null
): PlzCheckResult {
  const plz = (rawPlz ?? "").trim();

  // Must be exactly 5 digits.
  if (!/^\d{5}$/.test(plz)) {
    return {
      ok: false,
      reason: "not_found",
      plz,
      found_bundesland: null,
      expected_bundesland: expectedBundesland ?? null,
    };
  }

  const found = PLZ_TABLE[plz] ?? null;
  if (found === null) {
    return {
      ok: false,
      reason: "not_found",
      plz,
      found_bundesland: null,
      expected_bundesland: expectedBundesland ?? null,
    };
  }

  if (
    expectedBundesland != null &&
    expectedBundesland.trim() !== "" &&
    normalize(found) !== normalize(expectedBundesland)
  ) {
    return {
      ok: false,
      reason: "bundesland_mismatch",
      plz,
      found_bundesland: found,
      expected_bundesland: expectedBundesland,
    };
  }

  return {
    ok: true,
    reason: "valid",
    plz,
    found_bundesland: found,
    expected_bundesland: expectedBundesland ?? null,
  };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, "");
}

// Extracts a 5-digit PLZ from a free-form German address string.
// German addresses place the PLZ before the city: "Korbacher Str. 132, 34270 Schauenburg".
export function extractPlz(address: string): string | null {
  if (!address) return null;
  const m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// Rich wrapper exposed for direct callers (resolvers, tests). The dispatcher in
// the Edge Function uses the Verifier-conforming export below; the §10 downgrade
// (confidence "low" + validation_status "requires_human_review") is applied by
// the dispatcher when passes === false.

export interface PlzVerifierInput {
  /** The extracted address field value (free-form string). */
  value: string;
  /** Optional expected Bundesland for cross-checking (e.g. from the property). */
  expectedBundesland?: string | null;
}

export interface PlzVerifierOutput {
  validation_status: "valid" | "requires_human_review";
  confidence_override: "low" | null;
  detail: string | null;
}

export function plzVerifier(input: PlzVerifierInput): PlzVerifierOutput {
  const plz = extractPlz(input.value);

  // No PLZ present in the address → nothing to verify (not a failure).
  if (plz === null) {
    return { validation_status: "valid", confidence_override: null, detail: null };
  }

  const result = checkPlz(plz, input.expectedBundesland ?? null);

  if (result.ok) {
    return { validation_status: "valid", confidence_override: null, detail: null };
  }

  const detail =
    result.reason === "not_found"
      ? `PLZ ${result.plz} is not a valid German postal code`
      : `PLZ ${result.plz} maps to ${result.found_bundesland}, expected ${result.expected_bundesland}`;

  return {
    validation_status: "requires_human_review",
    confidence_override: "low",
    detail,
  };
}

// Verifier-conforming adapter registered in verifiers/index.ts under "plz".
// Pulls the address string from normalized_value (fallback raw_value) and
// returns the shipped { passes, reason } shape so the dispatcher applies the
// standard downgrade path.
export const plzFieldVerifier: Verifier = (ctx): VerifierResult => {
  const { field_envelope } = ctx;
  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }
  const value =
    typeof field_envelope.normalized_value === "string"
      ? field_envelope.normalized_value
      : typeof field_envelope.raw_value === "string"
        ? field_envelope.raw_value
        : "";
  const out = plzVerifier({ value });
  if (out.validation_status === "valid") return { passes: true };
  return { passes: false, reason: out.detail ?? "PLZ check failed" };
};
