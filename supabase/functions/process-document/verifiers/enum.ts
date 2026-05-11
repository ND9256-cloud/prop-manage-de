import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted normalized_value matches one of the field's enum_values.
//
// Rationale: enum fields exist because we've already enumerated the valid options.
// A normalized_value outside the enum is a normalization failure (either the
// extraction didn't apply the mapping, or the field shouldn't have been extracted).

export const enumVerifier: Verifier = (ctx): VerifierResult => {
  const { field_spec, field_envelope } = ctx;

  // For absence_state != present, this verifier does not apply.
  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  const enumValues = field_spec.enum_values;
  if (!enumValues || enumValues.length === 0) {
    return {
      passes: false,
      reason: "enum verifier invoked on field without enum_values (schema misconfiguration)",
    };
  }

  const nv = field_envelope.normalized_value;
  if (typeof nv !== "string") {
    return {
      passes: false,
      reason: `normalized_value must be a string for enum fields (got ${typeof nv})`,
    };
  }

  if (!enumValues.includes(nv)) {
    return {
      passes: false,
      reason: `normalized_value "${nv}" not in enum_values [${enumValues.join(", ")}]`,
    };
  }

  return { passes: true };
};
