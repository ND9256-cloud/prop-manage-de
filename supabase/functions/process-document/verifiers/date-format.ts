import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted date is:
// 1. A single value (NOT a comma-separated list of dates — that's a structural error)
// 2. Parses as a valid ISO 8601 date (YYYY-MM-DD)
// 3. Represents a real calendar date (not 2024-02-31)
//
// Rationale: extraction errors on date fields often produce concatenated multi-value
// strings (e.g., "2024-01-01,2024-02-01") instead of a single date. Such strings may
// look valid in isolation but break downstream date arithmetic.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dateFormat: Verifier = (ctx): VerifierResult => {
  const { field_envelope } = ctx;

  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  const nv = field_envelope.normalized_value;
  if (typeof nv !== "string") {
    return {
      passes: false,
      reason: `normalized_value must be a string for date fields (got ${typeof nv})`,
    };
  }

  // Reject comma-separated multi-value strings.
  if (nv.includes(",")) {
    return {
      passes: false,
      reason: `date field contains comma — expected a single ISO date, got "${nv}"`,
    };
  }

  // Reject anything not in YYYY-MM-DD format.
  if (!ISO_DATE_RE.test(nv)) {
    return {
      passes: false,
      reason: `date "${nv}" does not match ISO 8601 format YYYY-MM-DD`,
    };
  }

  // Parse and confirm it's a real calendar date.
  // Using Date.parse + round-trip check rejects things like 2024-02-31.
  const parsed = new Date(nv);
  if (Number.isNaN(parsed.getTime())) {
    return { passes: false, reason: `date "${nv}" is not a valid calendar date` };
  }

  // Round-trip: 2024-02-31 parses to 2024-03-02, which would round-trip to a
  // different string. Reject if the round-trip differs.
  const roundTrip = parsed.toISOString().slice(0, 10);
  if (roundTrip !== nv) {
    return {
      passes: false,
      reason: `date "${nv}" is not a real calendar date (round-trips to ${roundTrip})`,
    };
  }

  return { passes: true };
};
