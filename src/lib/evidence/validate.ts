// Evidence shape + per-field allowed-type validator (Task 4.3c-b-ii-A).
//
// SHAPE only — NEVER grounding. This decides whether an evidence object is a
// VALID carrier for a given field; it does NOT check the quote against OCR or
// reproduce a derived value (that is the eval scorer's job).
//
// Rules:
//   - direct_quote (evidence_type absent or "direct_quote"): a non-empty string
//     `quote` is mandatory. (Byte-unchanged from the prior "evidence present"
//     expectation — a direct_quote with no quote was never a usable carrier.)
//   - table_cell: page present + column_anchor.quote + cell_value_raw +
//     derivation_rule (a registered DerivationRule) present; row_anchor optional
//     but, if present, must carry a non-empty quote.
//   - per-field allow-list: the evidence type must be permitted for the field
//     (unit_ref adds table_cell; every other field is direct_quote only), and a
//     table_cell rule must be allowed for that field.

import type { Evidence } from "./types";
import {
  isDerivationRule,
  evidenceTypeAllowed,
  tableCellRuleAllowed,
} from "./derivation-rules";

export interface EvidenceValidationResult {
  valid: boolean;
  // Populated only when valid === false.
  reason?: string;
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

// The carrier-level evidence type of an object: direct_quote when the tag is
// absent or "direct_quote", table_cell when explicitly tagged. Anything else is
// an unknown discriminant.
function evidenceTypeOf(e: Evidence): "direct_quote" | "table_cell" | "unknown" {
  const tag = (e as { evidence_type?: unknown }).evidence_type;
  if (tag === undefined || tag === null || tag === "direct_quote") return "direct_quote";
  if (tag === "table_cell") return "table_cell";
  return "unknown";
}

/**
 * Validate ONE evidence object as a carrier for `fieldId`. Returns
 * { valid, reason }. Never throws on malformed input.
 */
export function validateEvidence(fieldId: string, evidence: unknown): EvidenceValidationResult {
  if (typeof evidence !== "object" || evidence === null) {
    return { valid: false, reason: "evidence must be a non-null object" };
  }

  const e = evidence as Evidence;
  const type = evidenceTypeOf(e);

  if (type === "unknown") {
    return {
      valid: false,
      reason: `unknown evidence_type ${JSON.stringify((e as { evidence_type?: unknown }).evidence_type)}`,
    };
  }

  // Per-field allowed evidence types.
  if (!evidenceTypeAllowed(fieldId, type)) {
    return {
      valid: false,
      reason: `evidence_type "${type}" is not allowed for field "${fieldId}"`,
    };
  }

  if (type === "direct_quote") {
    const q = (e as { quote?: unknown }).quote;
    if (!nonEmptyString(q)) {
      return { valid: false, reason: "direct_quote evidence requires a non-empty quote" };
    }
    return { valid: true };
  }

  // type === "table_cell"
  const tc = (e as { table_cell?: unknown }).table_cell;
  const page = (e as { page?: unknown }).page;

  if (typeof page !== "number") {
    return { valid: false, reason: "table_cell evidence requires a numeric page" };
  }
  if (typeof tc !== "object" || tc === null) {
    return { valid: false, reason: "table_cell evidence requires a table_cell object" };
  }

  const cell = tc as Record<string, unknown>;

  const columnAnchor = cell.column_anchor as { quote?: unknown } | undefined;
  if (!columnAnchor || !nonEmptyString(columnAnchor.quote)) {
    return { valid: false, reason: "table_cell requires column_anchor.quote" };
  }
  if (!nonEmptyString(cell.cell_value_raw)) {
    return { valid: false, reason: "table_cell requires a non-empty cell_value_raw" };
  }
  if (!isDerivationRule(cell.derivation_rule)) {
    return {
      valid: false,
      reason: `table_cell derivation_rule ${JSON.stringify(cell.derivation_rule)} is not a registered rule`,
    };
  }
  if (!tableCellRuleAllowed(fieldId, cell.derivation_rule)) {
    return {
      valid: false,
      reason: `derivation_rule "${cell.derivation_rule}" is not allowed for field "${fieldId}"`,
    };
  }

  // row_anchor is optional, but if present must carry a non-empty quote.
  if (cell.row_anchor !== undefined && cell.row_anchor !== null) {
    const rowAnchor = cell.row_anchor as { quote?: unknown };
    if (!nonEmptyString(rowAnchor.quote)) {
      return { valid: false, reason: "table_cell row_anchor, when present, requires a non-empty quote" };
    }
  }

  return { valid: true };
}

export function isValidEvidence(fieldId: string, evidence: unknown): boolean {
  return validateEvidence(fieldId, evidence).valid;
}
