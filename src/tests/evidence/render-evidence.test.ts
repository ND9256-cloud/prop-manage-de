// renderEvidence German provenance rendering (Task 4.3c-b-ii-A).
//
// direct_quote → the quote, unchanged. table_cell ± row_anchor → the German
// "Tabellenzelle — …" string wired into the provenance click-through.
//
// Run: npx tsx src/tests/evidence/render-evidence.test.ts

import assert from "node:assert/strict";
import { renderEvidence } from "../../lib/evidence/render.ts";
import type { Evidence } from "../../lib/evidence/types.ts";

let assertions = 0;
function eq(a: unknown, b: unknown, msg: string) {
  assertions++;
  assert.equal(a, b, msg);
}

// --- direct_quote (evidence_type absent ⇒ direct_quote) ---
const dqImplicit: Evidence = { quote: "Kaltmiete beträgt 650,00 EUR", page: 1 };
eq(
  renderEvidence(dqImplicit),
  "Kaltmiete beträgt 650,00 EUR",
  "direct_quote (implicit) renders the quote unchanged",
);

const dqExplicit: Evidence = { evidence_type: "direct_quote", quote: "Erdgeschoss", page: 1 };
eq(
  renderEvidence(dqExplicit),
  "Erdgeschoss",
  "direct_quote (explicit) renders the quote unchanged",
);

// --- table_cell WITH row_anchor ---
const tcWithRow: Evidence = {
  evidence_type: "table_cell",
  page: 2,
  table_cell: {
    row_anchor: { quote: "Lena Everding", anchor_type: "tenant_name" },
    column_anchor: { quote: "Geschoss" },
    cell_value_raw: "1",
    derivation_rule: "geschoss_numeric_to_og",
  },
};
eq(
  renderEvidence(tcWithRow),
  "Tabellenzelle — Zeile [Lena Everding], Spalte [Geschoss], Rohwert [1], Seite 2",
  "table_cell with row_anchor renders the full German row/column/raw/page string",
);

// --- table_cell WITHOUT row_anchor ---
const tcNoRow: Evidence = {
  evidence_type: "table_cell",
  page: 3,
  table_cell: {
    column_anchor: { quote: "Geschoss" },
    cell_value_raw: "1",
    derivation_rule: "geschoss_numeric_to_og",
  },
};
eq(
  renderEvidence(tcNoRow),
  "Tabellenzelle — Spalte [Geschoss], Rohwert [1], Seite 3",
  "table_cell without row_anchor omits the Zeile segment",
);

console.log(`✓ render-evidence.test.ts: ${assertions} assertions passed`);
