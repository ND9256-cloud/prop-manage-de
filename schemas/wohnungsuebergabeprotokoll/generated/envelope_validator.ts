// DO NOT EDIT — generated from schemas/wohnungsuebergabeprotokoll/schema.yaml
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

    // Check 1: evidence is required when absence_state === "present"
    // (architecture §3.1: "Evidence is mandatory unless absence_state is one of the absence states")
    if (v.absence_state === "present") {
      if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
        throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" must have a non-empty evidence array when absence_state == "present"`);
      }
    } else if (v.evidence !== undefined && v.evidence !== null) {
      // If evidence is provided for a non-present field, it must still be a valid array shape
      if (!Array.isArray(v.evidence)) {
        throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" evidence must be an array if provided`);
      }
    }

    // Check 2: absence_state validity (if present)
    if (v.absence_state !== undefined && v.absence_state !== null) {
      if (typeof v.absence_state !== "string" || !VALID_ABSENCE_STATES.includes(v.absence_state)) {
        throw new EnvelopeValidationError(fieldId, "absence_state", `Field "${fieldId}" has invalid absence_state: ${JSON.stringify(v.absence_state)}`);
      }
    }

    // Check 3: enum type validation — applies only when absence_state == "present"
    if ((def.type === "enum") && def.enumValues !== null && v.absence_state === "present") {
      if (typeof v.normalized_value !== "string" || !def.enumValues.includes(v.normalized_value)) {
        throw new EnvelopeValidationError(fieldId, "enum_value", `Field "${fieldId}" normalized_value ${JSON.stringify(v.normalized_value)} is not in allowed enum_values: ${JSON.stringify(def.enumValues)}`);
      }
    }

    // Check 4: severity must be present and match the schema (architecture §3.1:
    // "copied into extraction for eval"). The pipeline is responsible for copying
    // severity from FIELD_DEFS into each field of the envelope before calling
    // validateEnvelope. The validator confirms it landed correctly.
    if (typeof v.severity !== "string") {
      throw new EnvelopeValidationError(fieldId, "severity", `Field "${fieldId}" must have a string severity (pipeline should inject from FIELD_DEFS)`);
    }
    if (v.severity !== def.severity) {
      throw new EnvelopeValidationError(fieldId, "severity_mismatch", `Field "${fieldId}" severity "${v.severity}" does not match schema-declared severity "${def.severity}"`);
    }

    // Check 5: confidence must be one of the architecture-defined values
    if (v.confidence !== undefined && v.confidence !== null) {
      const validConfidence = ["high", "medium", "low"];
      if (typeof v.confidence !== "string" || !validConfidence.includes(v.confidence)) {
        throw new EnvelopeValidationError(fieldId, "confidence", `Field "${fieldId}" has invalid confidence: ${JSON.stringify(v.confidence)} (must be high | medium | low)`);
      }
    }

    // Check 6: validation_status must be one of the architecture-defined values
    if (v.validation_status !== undefined && v.validation_status !== null) {
      const validStatus = ["valid", "failed_format", "failed_verifier", "requires_human_review"];
      if (typeof v.validation_status !== "string" || !validStatus.includes(v.validation_status)) {
        throw new EnvelopeValidationError(fieldId, "validation_status", `Field "${fieldId}" has invalid validation_status: ${JSON.stringify(v.validation_status)} (must be valid | failed_format | failed_verifier | requires_human_review)`);
      }
    }
  }
}

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "wohnungsuebergabeprotokoll";
