// Production derivation-rule registry + per-field evidence allow-list
// (Task 4.3c-b-ii-A).
//
// This is the PRODUCTION mirror of the scorer-side registry in
// scripts/eval/derivation-rules.ts. The eval tree and the Next.js app are
// separate module worlds (different tsconfig scopes; the eval tree is excluded
// from `tsc --noEmit`), so the closed enum of rule ids and the per-field policy
// are duplicated here — value-identical to the eval source — rather than shared
// by import. They MUST stay in sync (the eval drift/table-cell tests pin the
// eval copy; this copy is pinned by src/tests/evidence/validate-evidence.test.ts).
//
// Unlike the eval registry, the production side carries NO apply() functions:
// the production validator checks SHAPE only (never grounding), so it needs to
// know which rule ids exist and which (field, type, rule) pairs are permitted —
// it never reproduces a normalized value. Teaching the extractor to EMIT
// table_cell evidence is the separate next task (4.3c-b-ii-B).

// The closed set of rule ids. A DerivationRule is exactly one of these — any
// other string is not a derivation rule (isDerivationRule === false), so a
// free-form rule string is rejected at shape validation.
export const DERIVATION_RULE_IDS = [
  "literal",
  "floor_abbreviation_normalization",
  "geschoss_numeric_to_og",
] as const;

export type DerivationRule = (typeof DERIVATION_RULE_IDS)[number];

export function isDerivationRule(x: unknown): x is DerivationRule {
  return typeof x === "string" && (DERIVATION_RULE_IDS as readonly string[]).includes(x);
}

// ── Per-field evidence allow-list ────────────────────────────────────────────
// Which evidence types a field may carry, and which derivation rules are allowed
// for table_cell evidence on that field. unit_ref is the only table_cell field
// today; every other field is unchanged (direct_quote only).
export interface FieldEvidencePolicy {
  evidence_types: ReadonlyArray<"direct_quote" | "table_cell" | "derived">;
  // Rules allowed for table_cell evidence on this field.
  table_cell_rules: ReadonlyArray<DerivationRule>;
}

export const FIELD_EVIDENCE_POLICY: Record<string, FieldEvidencePolicy> = {
  unit_ref: {
    evidence_types: ["direct_quote", "table_cell", "derived"],
    table_cell_rules: ["literal", "geschoss_numeric_to_og"],
  },
};

// Fields not in the policy carry direct_quote only — the byte-unchanged default.
const DEFAULT_EVIDENCE_TYPES: ReadonlyArray<"direct_quote"> = ["direct_quote"];

export function allowedEvidenceTypes(fieldId: string): ReadonlyArray<string> {
  return FIELD_EVIDENCE_POLICY[fieldId]?.evidence_types ?? DEFAULT_EVIDENCE_TYPES;
}

export function evidenceTypeAllowed(
  fieldId: string,
  evidenceType: "direct_quote" | "table_cell",
): boolean {
  return allowedEvidenceTypes(fieldId).includes(evidenceType);
}

export function tableCellRuleAllowed(fieldId: string, rule: DerivationRule): boolean {
  return FIELD_EVIDENCE_POLICY[fieldId]?.table_cell_rules.includes(rule) ?? false;
}
