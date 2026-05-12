// DO NOT EDIT — generated from schemas/mietvertragsnachtrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-08-v1
// Run `npm run gen:schemas` to regenerate.

export class EnvelopeValidationError extends Error {
  constructor(public field: string, public check: string, message: string) {
    super(message);
    this.name = "EnvelopeValidationError";
  }
}

const VALID_ABSENCE_STATES: ReadonlyArray<string> = ["present","absent","illegible","ambiguous","contradicted","not_applicable","inferred","requires_human_review"];

const FIELD_DEFS: Record<string, { type: string; severity: string; enumValues: string[] | null }> = {
  "doc_type_marker": {
    type: "string",
    severity: "nice_to_have",
    enumValues: null,
  }
};

export function validateEnvelope(envelope: unknown): void {
  if (typeof envelope !== "object" || envelope === null) {
    throw new EnvelopeValidationError("_root", "type", "Envelope must be a non-null object");
  }

  const env = envelope as Record<string, unknown>;

  for (const [fieldId, def] of Object.entries(FIELD_DEFS)) {
    const value = env[fieldId];
    if (value === undefined || value === null) {
      continue; // field not present in envelope — OK, requiredness is not enforced here
    }

    if (typeof value !== "object" || value === null) {
      throw new EnvelopeValidationError(fieldId, "shape", `Field "${fieldId}" value must be an object`);
    }

    const v = value as Record<string, unknown>;

    // Check 1: evidence must exist and be a non-empty array
    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" must have a non-empty evidence array`);
    }

    // Check 2: absence_state validity (if present)
    if (v.absence_state !== undefined && v.absence_state !== null) {
      if (typeof v.absence_state !== "string" || !VALID_ABSENCE_STATES.includes(v.absence_state)) {
        throw new EnvelopeValidationError(fieldId, "absence_state", `Field "${fieldId}" has invalid absence_state: ${JSON.stringify(v.absence_state)}`);
      }
    }

    // Check 3: enum type validation
    if ((def.type === "enum") && def.enumValues !== null) {
      if (v.value !== undefined && v.value !== null && v.absence_state === undefined) {
        if (typeof v.value !== "string" || !def.enumValues.includes(v.value)) {
          throw new EnvelopeValidationError(fieldId, "enum_value", `Field "${fieldId}" value ${JSON.stringify(v.value)} is not in allowed enum_values: ${JSON.stringify(def.enumValues)}`);
        }
      }
    }

    // NOTE: severity is a schema-level property declared in schema.yaml per field,
    // NOT an extraction-time property. Earlier versions of this validator required
    // the extracted envelope to carry severity redundantly, but Sonnet has no way
    // to know what the schema says — the value would just be copied. Severity is
    // available to downstream consumers via FIELD_DEFS above (keyed by field id).
  }
}

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "mietvertragsnachtrag";
