// Production evidence contract (Task 4.3c-b-ii-A) — carry + validate + render
// table_cell evidence in the production envelope, backward-compatible with
// direct_quote. No emission yet (that is 4.3c-b-ii-B).

export type {
  Evidence,
  EvidenceQuote,
  TableCellEvidence,
  TableCell,
  RowAnchor,
  ColumnAnchor,
} from "./types";
export { isTableCellEvidence } from "./types";

export type { DerivationRule, FieldEvidencePolicy } from "./derivation-rules";
export {
  DERIVATION_RULE_IDS,
  isDerivationRule,
  FIELD_EVIDENCE_POLICY,
  allowedEvidenceTypes,
  evidenceTypeAllowed,
  tableCellRuleAllowed,
} from "./derivation-rules";

export type { EvidenceValidationResult } from "./validate";
export { validateEvidence, isValidEvidence } from "./validate";

export { renderEvidence } from "./render";
