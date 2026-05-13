// triage-document-shape.test.ts — locks the renderer contract for extraction-display.ts
// Pure function tests: no DB, no dotenv needed.
// Run: npx tsx src/tests/triage-document-shape.test.ts

import { buildDisplayRows, DisplayRow } from "../lib/extraction-display";

// --- Test harness (same style as verifiers.test.ts / envelope-validator.test.ts) ---

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
    console.error(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// --- Purity gate: extraction-display.ts must NOT import react/prisma/supabase/next ---
import * as fs from "fs";
import * as path from "path";
const src = fs.readFileSync(
  path.resolve(__dirname, "../lib/extraction-display.ts"),
  "utf-8"
);

console.log("\n=== Triage Document Shape Test Suite ===\n");

console.log("--- Purity gate ---");
expect(
  "No react import",
  !src.match(/from\s+['"]react['"]/),
  "extraction-display.ts imports react"
);
expect(
  "No prisma import",
  !src.match(/from\s+['"].*prisma['"]/),
  "extraction-display.ts imports prisma"
);
expect(
  "No supabase import",
  !src.match(/from\s+['"].*supabase['"]/),
  "extraction-display.ts imports supabase"
);
expect(
  "No next import",
  !src.match(/from\s+['"]next\b/),
  "extraction-display.ts imports next"
);

// --- v2 envelope helpers ---

function v2Field(overrides: Record<string, unknown> = {}) {
  return {
    raw_value: "650,00 EUR",
    normalized_value: { amount: 65000, currency: "EUR" },
    evidence: [{ quote: "Kaltmiete betr\u00e4gt 650,00 EUR", page: 1, bbox: null }],
    confidence: "high",
    absence_state: "present",
    validation_status: "valid",
    severity: "critical",
    ...overrides,
  };
}

// --- 1. Lena's exact v2 envelope (Mietvertrag) ---
console.log("\n--- 1. Lena\u2019s v2 Mietvertrag envelope ---");
{
  const envelope: Record<string, unknown> = {
    kaltmiete: v2Field({
      raw_value: "650,00 EUR",
      normalized_value: { amount: 65000, currency: "EUR" },
      severity: "critical",
    }),
    unit_ref: v2Field({
      raw_value: "1. Obergeschoss",
      normalized_value: "1.OG",
      evidence: [{ quote: "1. Obergeschoss", page: 1, bbox: null }],
      severity: "critical",
    }),
    tenant_identity: v2Field({
      raw_value: "Lena Everding",
      normalized_value: { name: "Everding, Lena", is_legal_entity: false },
      evidence: [{ quote: "Lena Everding", page: 1, bbox: null }],
      severity: "critical",
    }),
    mietbeginn: v2Field({
      raw_value: "01.04.2025",
      normalized_value: "2025-04-01",
      evidence: [{ quote: "01.04.2025", page: 1, bbox: null }],
      severity: "critical",
    }),
    mietende: {
      raw_value: null,
      normalized_value: null,
      absence_state: "not_applicable",
      confidence: "high",
      validation_status: "valid",
      severity: "important",
    },
  };

  const rows = buildDisplayRows({ kind: "v2", envelope, docType: "mietvertrag" });

  // not_applicable → omitted, so expect 4 rows
  expect("1a. Lena v2 returns 4 rows (mietende omitted)", rows.length === 4, `got ${rows.length}`);

  const ids = rows.map((r) => r.fieldId);
  expect("1b. Has kaltmiete row", ids.includes("kaltmiete"));
  expect("1c. Has unit_ref row", ids.includes("unit_ref"));
  expect("1d. Has tenant_identity row", ids.includes("tenant_identity"));
  expect("1e. Has mietbeginn row", ids.includes("mietbeginn"));
  expect("1f. No mietende row (not_applicable)", !ids.includes("mietende"));

  const kaltmiete = rows.find((r) => r.fieldId === "kaltmiete")!;
  expect("1g. Kaltmiete display = '650,00 EUR'", kaltmiete.display === "650,00 EUR", `got '${kaltmiete.display}'`);
  expect("1h. Kaltmiete label = 'Kaltmiete'", kaltmiete.label === "Kaltmiete", `got '${kaltmiete.label}'`);
  expect("1i. Kaltmiete editable = false (v2)", kaltmiete.editable === false);

  const unit = rows.find((r) => r.fieldId === "unit_ref")!;
  expect("1j. Einheit display = '1.OG'", unit.display === "1.OG", `got '${unit.display}'`);
  expect("1k. Einheit label = 'Einheit'", unit.label === "Einheit", `got '${unit.label}'`);

  const tenant = rows.find((r) => r.fieldId === "tenant_identity")!;
  expect("1l. Mieter display = 'Everding, Lena'", tenant.display === "Everding, Lena", `got '${tenant.display}'`);
  expect("1m. Mieter label = 'Mieter'", tenant.label === "Mieter", `got '${tenant.label}'`);

  const beginn = rows.find((r) => r.fieldId === "mietbeginn")!;
  expect("1n. Mietbeginn display = '01.04.2025'", beginn.display === "01.04.2025", `got '${beginn.display}'`);
  expect("1o. Mietbeginn label = 'Mietbeginn'", beginn.label === "Mietbeginn", `got '${beginn.label}'`);
}

// --- 2. v2 envelope with mietende present ---
console.log("\n--- 2. v2 with mietende present ---");
{
  const envelope: Record<string, unknown> = {
    kaltmiete: v2Field({ severity: "critical" }),
    unit_ref: v2Field({ raw_value: "EG", normalized_value: "EG", severity: "critical" }),
    tenant_identity: v2Field({
      raw_value: "Max Mustermann",
      normalized_value: { name: "Mustermann, Max", is_legal_entity: false },
      severity: "critical",
    }),
    mietbeginn: v2Field({ raw_value: "01.01.2020", normalized_value: "2020-01-01", severity: "critical" }),
    mietende: v2Field({
      raw_value: "31.12.2025",
      normalized_value: "2025-12-31",
      evidence: [{ quote: "31.12.2025", page: 2, bbox: null }],
      severity: "important",
    }),
  };

  const rows = buildDisplayRows({ kind: "v2", envelope, docType: "mietvertrag" });
  expect("2a. Returns 5 rows when mietende present", rows.length === 5, `got ${rows.length}`);
  const mietende = rows.find((r) => r.fieldId === "mietende")!;
  expect("2b. Mietende display = '31.12.2025'", mietende.display === "31.12.2025", `got '${mietende.display}'`);
  expect("2c. Mietende label = 'Mietende'", mietende.label === "Mietende", `got '${mietende.label}'`);
}

// --- 3. v2 envelope with absence_state="absent" on kaltmiete ---
console.log("\n--- 3. v2 with absent kaltmiete ---");
{
  const envelope: Record<string, unknown> = {
    kaltmiete: {
      raw_value: null,
      normalized_value: null,
      absence_state: "absent",
      confidence: "high",
      validation_status: "valid",
      severity: "critical",
    },
    unit_ref: v2Field({ raw_value: "EG", normalized_value: "EG", severity: "critical" }),
    tenant_identity: v2Field({
      raw_value: "Test",
      normalized_value: { name: "Test", is_legal_entity: false },
      severity: "critical",
    }),
    mietbeginn: v2Field({ raw_value: "01.01.2020", normalized_value: "2020-01-01", severity: "critical" }),
    mietende: { raw_value: null, normalized_value: null, absence_state: "not_applicable", confidence: "high", validation_status: "valid", severity: "important" },
  };

  const rows = buildDisplayRows({ kind: "v2", envelope, docType: "mietvertrag" });
  // absent renders with placeholder, not_applicable omitted → 4 rows
  expect("3a. Returns 4 rows (absent kaltmiete shown, mietende omitted)", rows.length === 4, `got ${rows.length}`);
  const kaltmiete = rows.find((r) => r.fieldId === "kaltmiete")!;
  expect(
    "3b. Absent kaltmiete shows placeholder",
    kaltmiete.display === "\u2014 (nicht im Dokument)",
    `got '${kaltmiete.display}'`
  );
  expect("3c. Absent kaltmiete absenceState = 'absent'", kaltmiete.absenceState === "absent");
}

// --- 4. Legacy extraction (Rechnung shape) ---
console.log("\n--- 4. Legacy Rechnung fields ---");
{
  const extractedFields: Record<string, unknown> = {
    amount: "1234.56",
    vendor_name: "Stadtwerke Kassel",
    invoice_date: "2025-03-15",
  };

  const rows = buildDisplayRows({ kind: "legacy", extractedFields, docType: "rechnung" });
  expect("4a. Legacy Rechnung returns 3 rows", rows.length === 3, `got ${rows.length}`);

  const amount = rows.find((r) => r.fieldId === "amount")!;
  expect("4b. Betrag label", amount.label === "Betrag", `got '${amount.label}'`);
  expect("4c. Betrag display formatted", amount.display === "1.234,56 EUR", `got '${amount.display}'`);
  expect("4d. Legacy rows are editable", amount.editable === true);

  const vendor = rows.find((r) => r.fieldId === "vendor_name")!;
  expect("4e. Lieferant label", vendor.label === "Anbieter", `got '${vendor.label}'`);
  expect("4f. Lieferant display", vendor.display === "Stadtwerke Kassel", `got '${vendor.display}'`);

  const date = rows.find((r) => r.fieldId === "invoice_date")!;
  expect("4g. Datum label", date.label === "Datum", `got '${date.label}'`);
  expect("4h. Datum display formatted", date.display === "15.03.2025", `got '${date.display}'`);
}

// --- 5. Legacy extraction (lease shape) ---
console.log("\n--- 5. Legacy lease fields ---");
{
  const extractedFields: Record<string, unknown> = {
    rent_cold: "650",
    lease_start: "2025-04-01",
  };

  const rows = buildDisplayRows({ kind: "legacy", extractedFields, docType: "mietvertrag" });
  expect("5a. Legacy lease returns 2 rows", rows.length === 2, `got ${rows.length}`);

  const rent = rows.find((r) => r.fieldId === "rent_cold")!;
  expect("5b. Kaltmiete label", rent.label === "Kaltmiete", `got '${rent.label}'`);
  expect("5c. Kaltmiete display formatted", rent.display === "650,00 EUR", `got '${rent.display}'`);

  const start = rows.find((r) => r.fieldId === "lease_start")!;
  expect("5d. Mietbeginn label", start.label === "Mietbeginn", `got '${start.label}'`);
  expect("5e. Mietbeginn display formatted", start.display === "01.04.2025", `got '${start.display}'`);
}

// --- 6. Unknown v2 docType → empty array ---
console.log("\n--- 6. Unknown v2 docType ---");
{
  const rows = buildDisplayRows({ kind: "v2", envelope: {}, docType: "unknown_type" });
  expect("6a. Unknown v2 docType returns empty array", rows.length === 0, `got ${rows.length}`);
}

// --- 7. Legacy with empty fields ---
console.log("\n--- 7. Legacy empty fields ---");
{
  const rows = buildDisplayRows({ kind: "legacy", extractedFields: {} });
  expect("7a. Empty legacy fields returns empty array", rows.length === 0, `got ${rows.length}`);
}

// ===================== SUMMARY =====================

console.log(`\n--- Results ---`);
console.log(`  ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  console.log("");
  process.exit(1);
} else {
  console.log(`\n\u2713 ${passCount} triage-document-shape assertions passed\n`);
}
