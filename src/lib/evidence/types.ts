// Production evidence union (Task 4.3c-b-ii-A).
//
// Mirrors the scorer-side union in scripts/eval/types.ts so the production
// envelope can CARRY and shape-VALIDATE the same evidence the eval harness
// grounds. Backward compatible: the discriminant `evidence_type` is OPTIONAL —
// when absent the entry IS a direct_quote, so every existing { quote, page,
// bbox } field is byte-for-byte unchanged and still valid.
//
// This task only adds the capability to carry/validate/render table_cell.
// Teaching the extractor to EMIT it is the separate next task (4.3c-b-ii-B);
// row_anchor is OPTIONAL here (4.3c-b-1b-i made it conditional scorer-side).

import type { DerivationRule } from "./derivation-rules";

export interface EvidenceQuote {
  evidence_type?: "direct_quote";
  quote: string;
  page?: number | null;
  bbox?: unknown;
}

// Row/column anchors carry the model's CITED header/row text plus an optional
// model-declared canonical. Shape-validation never trusts the canonical; the
// scorer (eval) grounds the quote and validates the canonical against OCR.
export interface RowAnchor {
  quote: string;
  anchor_type: string;
  canonical?: string;
}

export interface ColumnAnchor {
  quote: string;
  canonical?: string;
}

// A proposed table cell. cell_value_raw is the RAW OCR token (e.g. "1"), carried
// SEPARATELY from the field's normalized value; the scorer reproduces the
// normalized value via derivation_rule. row_anchor is optional (only required
// for grade 3 when a multi-row block must be disambiguated — Task 4.3c-b-1b-i).
export interface TableCell {
  row_anchor?: RowAnchor;
  column_anchor: ColumnAnchor;
  cell_value_raw: string;
  derivation_rule: DerivationRule;
}

export interface TableCellEvidence {
  evidence_type: "table_cell";
  page?: number | null;
  table_cell: TableCell;
}

export type Evidence = EvidenceQuote | TableCellEvidence;

// Discriminates the optional-tagged union (default → direct_quote). Mirrors the
// eval-side isTableCell so production and scorer agree on routing.
export function isTableCellEvidence(e: Evidence): e is TableCellEvidence {
  return (e as { evidence_type?: string }).evidence_type === "table_cell";
}
