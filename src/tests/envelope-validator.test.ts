// Comprehensive envelope-validator test against architecture §3.1 and §3.2.
// Covers happy path, all 8 absence_state values, evidence gating, severity
// injection, enum invariants, confidence/validation_status enums, and shape errors.
//
// Run: npx tsx src/tests/envelope-validator.test.ts

import {
  validateEnvelope,
  EnvelopeValidationError,
} from "../../schemas/mietvertrag/generated/envelope_validator";

// --- Test harness (same style as verifiers.test.ts) ---

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

function shouldPass(label: string, envelope: unknown) {
  try {
    validateEnvelope(envelope);
    expect(label, true);
  } catch (err) {
    expect(label, false, (err as Error).message);
  }
}

function shouldThrow(label: string, envelope: unknown, expectedCheck?: string) {
  try {
    validateEnvelope(envelope);
    expect(label, false, "expected EnvelopeValidationError but none thrown");
  } catch (err) {
    if (err instanceof EnvelopeValidationError) {
      if (expectedCheck) {
        expect(label, err.check === expectedCheck, `expected check="${expectedCheck}" got check="${err.check}"`);
      } else {
        expect(label, true);
      }
    } else {
      expect(label, false, `expected EnvelopeValidationError but got ${(err as Error).constructor.name}: ${(err as Error).message}`);
    }
  }
}

// --- Helpers to build field envelopes ---

function presentField(overrides: Record<string, unknown> = {}) {
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

function absentField(absenceState: string, severity: string, overrides: Record<string, unknown> = {}) {
  return {
    raw_value: null,
    normalized_value: null,
    absence_state: absenceState,
    confidence: "high",
    validation_status: "valid",
    severity,
    ...overrides,
  };
}

// Full happy-path envelope: all 5 mietvertrag fields present
function fullEnvelope(): Record<string, Record<string, unknown>> {
  return {
    kaltmiete: presentField({ severity: "critical" }),
    unit_ref: presentField({
      raw_value: "Erdgeschoss",
      normalized_value: "EG",
      evidence: [{ quote: "Erdgeschoss", page: 1, bbox: null }],
      severity: "critical",
    }),
    tenant_identity: presentField({
      raw_value: "Lena Everding",
      normalized_value: { name: "Lena Everding", is_legal_entity: false },
      evidence: [{ quote: "Lena Everding", page: 1, bbox: null }],
      severity: "critical",
    }),
    mietbeginn: presentField({
      raw_value: "01.07.2020",
      normalized_value: "2020-07-01",
      evidence: [{ quote: "01.07.2020", page: 1, bbox: null }],
      severity: "critical",
    }),
    mietende: absentField("not_applicable", "important"),
  };
}

// ===================== TESTS =====================

console.log("\n=== Envelope Validator Test Suite ===\n");

// --- 1. Happy path ---
console.log("--- Happy path ---");
shouldPass("1. Full happy-path envelope passes", fullEnvelope());

// --- 2. Lena's case: open-ended lease ---
console.log("\n--- Lena\u2019s case (Bug B) ---");
shouldPass("2. mietende not_applicable with no evidence passes", fullEnvelope());

// --- 3. Each absence_state value ---
console.log("\n--- All 8 absence_state values ---");
const absenceStates = [
  "present", "absent", "illegible", "ambiguous",
  "contradicted", "not_applicable", "inferred", "requires_human_review",
];
for (const state of absenceStates) {
  const env = fullEnvelope();
  if (state === "present") {
    // present needs evidence
    env.mietende = presentField({
      raw_value: "31.12.2025",
      normalized_value: "2025-12-31",
      evidence: [{ quote: "31.12.2025", page: 2, bbox: null }],
      severity: "important",
    });
  } else {
    env.mietende = absentField(state, "important");
  }
  shouldPass(`3-${state}. mietende with absence_state="${state}" passes`, env);
}

// --- 4. Evidence gating (Bug B) ---
console.log("\n--- Evidence gating ---");
{
  // present + no evidence → rejected
  const env = fullEnvelope();
  env.kaltmiete = presentField({ evidence: undefined, severity: "critical" });
  shouldThrow("4a. present + no evidence → rejected", env, "evidence");
}
{
  // present + empty evidence array → rejected
  const env = fullEnvelope();
  env.kaltmiete = presentField({ evidence: [], severity: "critical" });
  shouldThrow("4b. present + empty evidence → rejected", env, "evidence");
}
{
  // non-present + no evidence → accepted
  const env = fullEnvelope();
  env.mietende = absentField("absent", "important");
  shouldPass("4c. absent + no evidence → accepted", env);
}

// --- 5. Invalid absence_state ---
console.log("\n--- Invalid absence_state ---");
{
  const env = fullEnvelope();
  env.mietende = absentField("unknown_state", "important");
  shouldThrow("5. invalid absence_state 'unknown_state' → rejected", env, "absence_state");
}

// --- 6. Confidence enum (Bug E) ---
console.log("\n--- Confidence enum ---");
{
  const env = fullEnvelope();
  env.kaltmiete = presentField({ confidence: "super-sure", severity: "critical" });
  shouldThrow("6a. invalid confidence 'super-sure' → rejected", env, "confidence");
}
for (const valid of ["high", "medium", "low"]) {
  const env = fullEnvelope();
  env.kaltmiete = presentField({ confidence: valid, severity: "critical" });
  shouldPass(`6b-${valid}. confidence="${valid}" accepted`, env);
}

// --- 7. Validation_status enum (Bug E) ---
console.log("\n--- Validation_status enum ---");
{
  const env = fullEnvelope();
  env.kaltmiete = presentField({ validation_status: "foo", severity: "critical" });
  shouldThrow("7a. invalid validation_status 'foo' → rejected", env, "validation_status");
}
for (const valid of ["valid", "failed_format", "failed_verifier", "requires_human_review"]) {
  const env = fullEnvelope();
  env.kaltmiete = presentField({ validation_status: valid, severity: "critical" });
  shouldPass(`7b-${valid}. validation_status="${valid}" accepted`, env);
}

// --- 8. Severity (Bug C) ---
console.log("\n--- Severity ---");
{
  const env = fullEnvelope();
  env.kaltmiete = presentField({ severity: undefined });
  shouldThrow("8a. missing severity → rejected", env, "severity");
}
{
  const env = fullEnvelope();
  env.kaltmiete = presentField({ severity: "super-critical" });
  shouldThrow("8b. invalid severity 'super-critical' → rejected", env, "severity_mismatch");
}
for (const valid of ["critical", "important", "nice_to_have"]) {
  // Only critical matches the schema for kaltmiete; others should fail severity_mismatch
  const env = fullEnvelope();
  env.kaltmiete = presentField({ severity: valid });
  if (valid === "critical") {
    shouldPass(`8c-${valid}. severity="${valid}" on kaltmiete accepted`, env);
  } else {
    shouldThrow(`8c-${valid}. severity="${valid}" on kaltmiete (schema says critical) → mismatch`, env, "severity_mismatch");
  }
}

// --- 9. Evidence shape ---
console.log("\n--- Evidence shape ---");
{
  // evidence as object (not array) when present → rejected
  const env = fullEnvelope();
  env.kaltmiete = presentField({
    evidence: { quote: "Kaltmiete 650", page: 1, bbox: null },
    severity: "critical",
  });
  shouldThrow("9a. evidence as object (not array) when present → rejected", env, "evidence");
}

// --- 10. Enum type validation (Bug D) ---
console.log("\n--- Enum validation (Bug D: normalized_value, not value) ---");
{
  // unit_ref with invalid normalized_value when present → rejected
  const env = fullEnvelope();
  env.unit_ref = presentField({
    raw_value: "Penthouse",
    normalized_value: "Penthouse",
    evidence: [{ quote: "Penthouse", page: 1, bbox: null }],
    severity: "critical",
  });
  shouldThrow("10a. enum field with invalid normalized_value → rejected", env, "enum_value");
}
{
  // unit_ref with valid normalized_value → accepted
  const env = fullEnvelope();
  env.unit_ref = presentField({
    raw_value: "1. Obergeschoss",
    normalized_value: "1.OG",
    evidence: [{ quote: "1. Obergeschoss", page: 1, bbox: null }],
    severity: "critical",
  });
  shouldPass("10b. enum field with valid normalized_value → accepted", env);
}
{
  // enum field with absence_state != present should not check normalized_value
  const env = fullEnvelope();
  env.unit_ref = absentField("ambiguous", "critical");
  shouldPass("10c. enum field with absence_state=ambiguous skips enum check", env);
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
  console.log(`\n\u2713 ${passCount} envelope-validator assertions passed\n`);
}
