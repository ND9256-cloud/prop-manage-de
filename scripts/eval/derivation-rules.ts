// Derivation-rule registry for table_cell / derived evidence (Task 4.3c-b-1a).
//
// A typed, CLOSED enum of deterministic rules plus a single apply() entry point.
// The integrity principle (non-negotiable): the LLM PROPOSES a table-cell
// derivation_rule; the scorer VALIDATES it. A rule is usable ONLY if it appears
// in this registry — there is no implementation for a free-form string, so an
// unknown/free-form rule is rejected at shape validation (never "trusted").
//
// Pure / deterministic / DB-free / API-free. Each rule maps a RAW OCR token
// (e.g. "1") to the canonical normalized value (e.g. "1.OG"); the scorer then
// checks rule(cell_value_raw) === field.normalized_value. The model-declared
// clean value is never trusted — only the RAW token grounds and the rule
// reproduces.

import { floor_synonym_normalization } from "./metrics.ts";

// The closed set of rule ids. A DerivationRule is exactly one of these — any
// other string is not a derivation rule (isDerivationRule === false).
export const DERIVATION_RULE_IDS = [
  "literal",
  "floor_abbreviation_normalization",
  "geschoss_numeric_to_og",
] as const;

export type DerivationRule = (typeof DERIVATION_RULE_IDS)[number];

export function isDerivationRule(x: unknown): x is DerivationRule {
  return typeof x === "string" && (DERIVATION_RULE_IDS as readonly string[]).includes(x);
}

// literal — the RAW token IS the canonical value verbatim (no transformation).
// Used when a cell already holds the normalized token (e.g. "1.OG" literally in
// the table). Anti-laundering still applies: the scorer grounds the RAW token in
// OCR, so literal("1.OG") only counts if "1.OG" itself grounds.
function literal(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

// geschoss_numeric_to_og — a bare floor-cell token under a floor column to the
// canonical floor token: "1"→"1.OG", "2"→"2.OG", … and the abbreviations
// "EG"/"DG"/"UG" pass through unchanged. The scorer LICENSES this rule only when
// the column is floor-like (column_anchor grounds a configured floor header);
// "1" under "Zimmer"/"Nr." must NOT derive a floor. Unknown token → null.
const GESCHOSS_PASSTHROUGH = new Set(["EG", "DG", "UG"]);

function geschoss_numeric_to_og(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 1 ? `${n}.OG` : null; // "0" is not a floor token
  }
  const up = t.toUpperCase();
  return GESCHOSS_PASSTHROUGH.has(up) ? up : null;
}

// The registry. floor_abbreviation_normalization REUSES the 4.3c-a closed floor
// phrase→token map (floor_synonym_normalization), now shared with the table_cell
// path. Wrapped in an arrow so the binding is read at call time, not at module
// init (metrics.ts ↔ derivation-rules.ts is a deliberate import cycle).
export const DERIVATION_RULES: Record<DerivationRule, (raw: string) => string | null> = {
  literal,
  floor_abbreviation_normalization: (raw) => floor_synonym_normalization(raw),
  geschoss_numeric_to_og,
};

// Deterministic apply: (rule, raw) → canonical token | null. An id outside the
// registry yields null (caller rejects it at shape validation before reaching
// here, but this stays total).
export function applyDerivationRule(rule: DerivationRule, raw: string): string | null {
  const fn = DERIVATION_RULES[rule];
  return fn ? fn(raw) : null;
}

// ── Per-field evidence allow-list ────────────────────────────────────────────
// Which evidence types a field may use, and which derivation rules are allowed
// per type. The table_cell scorer consults this so a field can only reach a
// positive grade through an explicitly permitted (type, rule) pair. unit_ref is
// the only table_cell field today; everything else is unchanged (direct_quote).
export interface FieldEvidencePolicy {
  evidence_types: ReadonlyArray<"direct_quote" | "table_cell" | "derived">;
  // Rules allowed for table_cell evidence on this field.
  table_cell_rules: ReadonlyArray<DerivationRule>;
  // Rules allowed for the 4.3c-a single-source derived path on this field.
  derived_rules: ReadonlyArray<DerivationRule>;
}

export const FIELD_EVIDENCE_POLICY: Record<string, FieldEvidencePolicy> = {
  unit_ref: {
    evidence_types: ["direct_quote", "table_cell", "derived"],
    table_cell_rules: ["literal", "geschoss_numeric_to_og"],
    derived_rules: ["floor_abbreviation_normalization"],
  },
};

export function tableCellAllowed(fieldId: string): boolean {
  return FIELD_EVIDENCE_POLICY[fieldId]?.evidence_types.includes("table_cell") ?? false;
}

export function tableCellRuleAllowed(fieldId: string, rule: DerivationRule): boolean {
  return FIELD_EVIDENCE_POLICY[fieldId]?.table_cell_rules.includes(rule) ?? false;
}
