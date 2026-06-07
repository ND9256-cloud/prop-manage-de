// Evidence shape + per-field allowed-type validator (Task 4.3c-b-ii-A).
//
// SHAPE only, never grounding: valid table_cell accepts; a missing required
// field rejects; a disallowed type for a field rejects; unit_ref allows
// table_cell; direct_quote requires a quote; free-form / disallowed rules reject.
//
// Run: npx tsx src/tests/evidence/validate-evidence.test.ts

import assert from "node:assert/strict";
import { validateEvidence } from "../../lib/evidence/validate.ts";

let assertions = 0;
function accepts(field: string, ev: unknown, label: string) {
  assertions++;
  const r = validateEvidence(field, ev);
  assert.equal(r.valid, true, `${label} (unexpected reject: ${r.reason})`);
}
function rejects(field: string, ev: unknown, label: string) {
  assertions++;
  const r = validateEvidence(field, ev);
  assert.equal(r.valid, false, `${label} (expected reject but accepted)`);
}

const validTableCell = (overrides: Record<string, unknown> = {}) => ({
  evidence_type: "table_cell",
  page: 2,
  table_cell: {
    row_anchor: { quote: "Lena Everding", anchor_type: "tenant_name" },
    column_anchor: { quote: "Geschoss" },
    cell_value_raw: "1",
    derivation_rule: "geschoss_numeric_to_og",
    ...overrides,
  },
});

// --- direct_quote ---
accepts("kaltmiete", { quote: "650,00 EUR", page: 1 }, "direct_quote (implicit) with quote accepts");
accepts("kaltmiete", { evidence_type: "direct_quote", quote: "650" }, "direct_quote (explicit) with quote accepts");
rejects("kaltmiete", { evidence_type: "direct_quote" }, "direct_quote without quote rejects");
rejects("kaltmiete", { quote: "   " }, "direct_quote with blank quote rejects");

// --- table_cell happy path on the only field that allows it ---
accepts("unit_ref", validTableCell(), "valid table_cell on unit_ref accepts");
accepts(
  "unit_ref",
  { evidence_type: "table_cell", page: 3, table_cell: { column_anchor: { quote: "Geschoss" }, cell_value_raw: "1", derivation_rule: "literal" } },
  "valid table_cell WITHOUT row_anchor accepts (row_anchor optional)",
);

// --- per-field allowed evidence types ---
rejects("kaltmiete", validTableCell(), "table_cell on a non-unit_ref field (kaltmiete) rejects (disallowed type)");
rejects("mietbeginn", validTableCell(), "table_cell on mietbeginn rejects (disallowed type)");

// --- missing required table_cell fields ---
rejects("unit_ref", { evidence_type: "table_cell", table_cell: { column_anchor: { quote: "Geschoss" }, cell_value_raw: "1", derivation_rule: "literal" } }, "table_cell missing page rejects");
rejects("unit_ref", validTableCell({ column_anchor: { quote: "" } }), "table_cell missing column_anchor.quote rejects");
rejects("unit_ref", validTableCell({ column_anchor: undefined }), "table_cell missing column_anchor rejects");
rejects("unit_ref", validTableCell({ cell_value_raw: "" }), "table_cell missing cell_value_raw rejects");
rejects("unit_ref", validTableCell({ derivation_rule: undefined }), "table_cell missing derivation_rule rejects");

// --- derivation_rule integrity ---
rejects("unit_ref", validTableCell({ derivation_rule: "made_up_rule" }), "free-form derivation_rule rejects");
rejects("unit_ref", validTableCell({ derivation_rule: "floor_abbreviation_normalization" }), "registered-but-not-allowed-for-field rule rejects");

// --- row_anchor, when present, must carry a quote ---
rejects("unit_ref", validTableCell({ row_anchor: { quote: "", anchor_type: "x" } }), "table_cell row_anchor with blank quote rejects");

// --- malformed / unknown discriminant ---
rejects("unit_ref", null, "null evidence rejects");
rejects("unit_ref", { evidence_type: "weird" }, "unknown evidence_type rejects");

console.log(`✓ validate-evidence.test.ts: ${assertions} assertions passed`);
