import { monetaryVerbatim } from "../../supabase/functions/process-document/verifiers/monetary-verbatim";
import { enumVerifier } from "../../supabase/functions/process-document/verifiers/enum";
import { dateFormat } from "../../supabase/functions/process-document/verifiers/date-format";
import type { VerifierContext } from "../../supabase/functions/process-document/verifiers/types";

// Helper to build a minimal context for testing
function makeContext(
  ocrText: string,
  fieldSpec: Record<string, unknown>,
  envelope: Record<string, unknown>
): VerifierContext {
  return {
    ocr_text: ocrText,
    field_spec: fieldSpec as VerifierContext["field_spec"],
    field_envelope: envelope as VerifierContext["field_envelope"],
  };
}

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function expect(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passCount++;
    console.log(`  \u2713 ${label}`);
  } else {
    failCount++;
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.error(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// === monetary-verbatim ===

// 1. Value appears verbatim in German format
const ctx1 = makeContext(
  "Die Kaltmiete beträgt 650,00 EUR monatlich.",
  { id: "kaltmiete", type: "money" },
  { absence_state: "present", normalized_value: { amount: 65000, currency: "EUR" } }
);
expect("monetary-verbatim: German format 650,00 found", monetaryVerbatim(ctx1).passes);

// 2. Value appears as integer when whole euro amount
const ctx2 = makeContext(
  "Miete: 650 EUR pro Monat.",
  { id: "kaltmiete", type: "money" },
  { absence_state: "present", normalized_value: { amount: 65000, currency: "EUR" } }
);
expect("monetary-verbatim: integer-only 650 found", monetaryVerbatim(ctx2).passes);

// 3. Value with thousands separator
const ctx3 = makeContext(
  "Kaltmiete: 1.234,56 EUR",
  { id: "kaltmiete", type: "money" },
  { absence_state: "present", normalized_value: { amount: 123456, currency: "EUR" } }
);
expect("monetary-verbatim: thousands-separated 1.234,56 found", monetaryVerbatim(ctx3).passes);

// 4. Value NOT in OCR text — should fail
const ctx4 = makeContext(
  "Some unrelated text without the value.",
  { id: "kaltmiete", type: "money" },
  { absence_state: "present", normalized_value: { amount: 65000, currency: "EUR" } }
);
const r4 = monetaryVerbatim(ctx4);
expect("monetary-verbatim: rejects value not in OCR", !r4.passes, r4.reason);

// 5. absence_state != present → skip
const ctx5 = makeContext(
  "irrelevant",
  { id: "kaltmiete", type: "money" },
  { absence_state: "ambiguous", normalized_value: null }
);
expect("monetary-verbatim: skips when absence_state != present", monetaryVerbatim(ctx5).passes);

// 6. Malformed normalized_value
const ctx6 = makeContext(
  "650",
  { id: "kaltmiete", type: "money" },
  { absence_state: "present", normalized_value: { amount: "not a number" } }
);
expect("monetary-verbatim: rejects malformed normalized_value", !monetaryVerbatim(ctx6).passes);

// === enum ===

// 7. Value in enum_values
const ctx7 = makeContext(
  "",
  { id: "unit_ref", type: "enum", enum_values: ["EG", "1.OG", "DG"] },
  { absence_state: "present", normalized_value: "1.OG" }
);
expect("enum: 1.OG in [EG, 1.OG, DG]", enumVerifier(ctx7).passes);

// 8. Value NOT in enum_values
const ctx8 = makeContext(
  "",
  { id: "unit_ref", type: "enum", enum_values: ["EG", "1.OG", "DG"] },
  { absence_state: "present", normalized_value: "1st floor" }
);
const r8 = enumVerifier(ctx8);
expect("enum: rejects '1st floor' not in enum", !r8.passes, r8.reason);

// 9. Missing enum_values config
const ctx9 = makeContext(
  "",
  { id: "x", type: "enum" }, // no enum_values
  { absence_state: "present", normalized_value: "x" }
);
expect("enum: rejects schema without enum_values", !enumVerifier(ctx9).passes);

// 10. absence_state != present → skip
const ctx10 = makeContext(
  "",
  { id: "unit_ref", type: "enum", enum_values: ["EG"] },
  { absence_state: "ambiguous", normalized_value: null }
);
expect("enum: skips when absence_state != present", enumVerifier(ctx10).passes);

// === date-format ===

// 11. Valid ISO date
const ctx11 = makeContext(
  "",
  { id: "mietbeginn", type: "date" },
  { absence_state: "present", normalized_value: "2024-06-01" }
);
expect("date-format: valid 2024-06-01", dateFormat(ctx11).passes);

// 12. Comma-separated multi-value (the structural error case)
const ctx12 = makeContext(
  "",
  { id: "mietbeginn", type: "date" },
  { absence_state: "present", normalized_value: "2024-09-01,2024-09-19,2024-10-01" }
);
const r12 = dateFormat(ctx12);
expect("date-format: rejects comma-separated dates", !r12.passes, r12.reason);

// 13. Wrong format (DD.MM.YYYY)
const ctx13 = makeContext(
  "",
  { id: "mietbeginn", type: "date" },
  { absence_state: "present", normalized_value: "01.06.2024" }
);
expect("date-format: rejects German format DD.MM.YYYY", !dateFormat(ctx13).passes);

// 14. Invalid calendar date (Feb 31)
const ctx14 = makeContext(
  "",
  { id: "mietbeginn", type: "date" },
  { absence_state: "present", normalized_value: "2024-02-31" }
);
expect("date-format: rejects 2024-02-31 (not real date)", !dateFormat(ctx14).passes);

// 15. absence_state != present → skip
const ctx15 = makeContext(
  "",
  { id: "mietende", type: "date" },
  { absence_state: "not_applicable", normalized_value: null }
);
expect("date-format: skips when absence_state != present", dateFormat(ctx15).passes);

// === Summary ===

console.log(`\nVerifier tests: ${passCount} passed, ${failCount} failed`);

if (failCount > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`\u2713 ${passCount} verifier assertions passed`);
