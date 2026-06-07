// German provenance rendering for evidence (Task 4.3c-b-ii-A).
//
// renderEvidence(evidence) → a human-readable GERMAN source string for the
// provenance click-through. The UI is German-only. direct_quote renders the
// quote unchanged (byte-for-byte the prior behavior); table_cell renders a
// readable cell reference instead of a blank quote.

import type { Evidence } from "./types";
import { isTableCellEvidence } from "./types";

export function renderEvidence(evidence: Evidence): string {
  if (isTableCellEvidence(evidence)) {
    const tc = evidence.table_cell;
    const col = tc.column_anchor?.quote ?? "";
    const raw = tc.cell_value_raw ?? "";
    const page = evidence.page ?? "";
    if (tc.row_anchor?.quote) {
      return `Tabellenzelle — Zeile [${tc.row_anchor.quote}], Spalte [${col}], Rohwert [${raw}], Seite ${page}`;
    }
    return `Tabellenzelle — Spalte [${col}], Rohwert [${raw}], Seite ${page}`;
  }
  // direct_quote (default): the quote, unchanged.
  return evidence.quote;
}
