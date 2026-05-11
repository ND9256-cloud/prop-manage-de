# Task 1.3 — Deterministic verifiers (Mietvertrag launch fields)

Reference docs (in repo):
- `docs/extraction-v2/extraction-v2-implementation-plan.md` Task 1.3 section
- `docs/extraction-v2/extraction-v2-architecture.md` §9.3 (verifier provider-agnosticism), §10 (deterministic verifiers — read this in full)
- `schemas/mietvertrag/schema.yaml` (the forward-reference targets: `monetary-verbatim`, `enum`, `date-format`)
- `domain_knowledge/mietvertrag.md` normalization_rules

This is a **t2 task** (logic, requires review). It creates the three deterministic verifiers referenced by `schemas/mietvertrag/schema.yaml`. After this lands, the schema's `verifier_refs` array stops being a forward reference and points to working code that runs inside the Edge Function pipeline.

## Architectural rule (read this carefully)

Verifiers are **pure, model-agnostic functions**. They validate extracted values against field semantics (OCR presence, format rules, enum membership), NOT against one model's known failure patterns.

Per architecture §9.3, there is a CI check that scans verifier source files for model identifiers (`sonnet`, `gpt`, `gemini`, `claude`, `haiku`, etc.). Any match in `supabase/functions/process-document/verifiers/*.ts` files fails the build. The rationale: when the production model changes, verifiers must keep catching real issues; verifiers tuned to one model's quirks become stale.

Do NOT mention any model name in verifier source. Do NOT include comments like "this catches the Haiku case where..." Use semantic descriptions: "comma-separated multi-value strings are not valid date inputs" rather than "Haiku sometimes returns comma-separated dates."

## Repo conventions (do NOT deviate)

- Package manager: **npm**
- Edge Function runtime: **Deno** — import syntax requires explicit `.ts` extension on internal imports
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Type safety: all verifier inputs/outputs are typed
- Pipe potentially-paged commands through `| cat`
- Do NOT push directly to main. Branch protection requires PR workflow.

## Steps

### 1. Create the verifier interface and directory

Path: `supabase/functions/process-document/verifiers/types.ts`

```typescript
// Verifier contract (architecture §10).
// All verifiers are pure functions. No LLM calls. No model identifiers.
// They validate extracted field values against semantic rules.

export interface VerifierContext {
  // The OCR text of the source document — passed for verifiers that need
  // to confirm the extracted value appears verbatim in the source.
  ocr_text: string;

  // The schema field definition for which this verifier was invoked.
  // Contains: id, type, enum_values (if applicable), normalization_rule_ref, etc.
  field_spec: FieldSpec;

  // The extracted value envelope (per architecture §3.1).
  // Verifiers may read raw_value, normalized_value, evidence, etc.
  field_envelope: FieldEnvelope;
}

export interface FieldSpec {
  id: string;
  type: string;
  enum_values?: string[];
  // Other meta-schema fields included for completeness;
  // individual verifiers reference only what they need.
  [key: string]: unknown;
}

export interface FieldEnvelope {
  raw_value: unknown;
  normalized_value: unknown;
  evidence?: { quote: string; page?: number; bbox?: unknown };
  confidence?: string;
  absence_state: string;
  validation_status?: string;
  [key: string]: unknown;
}

export interface VerifierResult {
  passes: boolean;
  reason?: string; // populated only when passes == false
}

export type Verifier = (ctx: VerifierContext) => VerifierResult;
```

### 2. Verifier 1 — `monetary-verbatim.ts`

Path: `supabase/functions/process-document/verifiers/monetary-verbatim.ts`

```typescript
import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted monetary amount appears verbatim in the OCR text,
// formatted in either German style (1.234,56) or plain (1234,56 / 1234.56 / 1234).
//
// Rationale: monetary values are high-stakes — a hallucinated amount has direct
// financial consequences. If the value isn't present in the source text, the
// extraction is suspect regardless of the model's confidence rating.

export const monetaryVerbatim: Verifier = (ctx): VerifierResult => {
  const { ocr_text, field_envelope } = ctx;

  // For absence_state != present, this verifier does not apply.
  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  // Extract the amount as a number from normalized_value.
  // normalized_value shape (per prompt_fragment): { amount: <minor units>, currency: "EUR" }
  const nv = field_envelope.normalized_value as
    | { amount?: number; currency?: string }
    | null;

  if (!nv || typeof nv.amount !== "number") {
    return {
      passes: false,
      reason: "normalized_value missing or malformed (expected { amount: number, currency: string })",
    };
  }

  // Convert minor units to a major-unit decimal string.
  // €650.00 in minor units = 65000 → "650,00" (German) or "650.00" (plain)
  const major = nv.amount / 100;

  // Build the candidate string representations we might find in OCR text.
  // German style: 1.234,56 (thousands separator: ., decimal: ,)
  // Plain: 1234,56 or 1234.56 or 1234 (no separator)
  const candidates: string[] = [];

  // German formatted with thousands separator
  candidates.push(germanFormat(major));

  // Plain German (no thousands separator)
  candidates.push(major.toFixed(2).replace(".", ","));

  // Plain integer (when the value is a whole euro amount, the document may omit ",00")
  if (Number.isInteger(major)) {
    candidates.push(String(major));
  }

  // Some documents use US-style "650.00" or "1,234.56" — accept those too.
  candidates.push(major.toFixed(2));
  if (Number.isInteger(major)) {
    candidates.push(major.toFixed(0));
  }

  // Check each candidate against the OCR text.
  for (const candidate of candidates) {
    if (ocr_text.includes(candidate)) {
      return { passes: true };
    }
  }

  return {
    passes: false,
    reason: `extracted monetary value ${major.toFixed(2)} EUR not found verbatim in OCR text (checked: ${candidates.join(", ")})`,
  };
};

// Format a number in German style: thousands separator is ".", decimal is ",".
// e.g., 1234.56 → "1.234,56"; 650 → "650,00"
function germanFormat(major: number): string {
  const fixed = major.toFixed(2); // "1234.56"
  const [intPart, decPart] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withThousands},${decPart}`;
}
```

### 3. Verifier 2 — `enum.ts`

Path: `supabase/functions/process-document/verifiers/enum.ts`

```typescript
import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted normalized_value matches one of the field's enum_values.
//
// Rationale: enum fields exist because we've already enumerated the valid options.
// A normalized_value outside the enum is a normalization failure (either the
// extraction didn't apply the mapping, or the field shouldn't have been extracted).

export const enumVerifier: Verifier = (ctx): VerifierResult => {
  const { field_spec, field_envelope } = ctx;

  // For absence_state != present, this verifier does not apply.
  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  const enumValues = field_spec.enum_values;
  if (!enumValues || enumValues.length === 0) {
    return {
      passes: false,
      reason: "enum verifier invoked on field without enum_values (schema misconfiguration)",
    };
  }

  const nv = field_envelope.normalized_value;
  if (typeof nv !== "string") {
    return {
      passes: false,
      reason: `normalized_value must be a string for enum fields (got ${typeof nv})`,
    };
  }

  if (!enumValues.includes(nv)) {
    return {
      passes: false,
      reason: `normalized_value "${nv}" not in enum_values [${enumValues.join(", ")}]`,
    };
  }

  return { passes: true };
};
```

### 4. Verifier 3 — `date-format.ts`

Path: `supabase/functions/process-document/verifiers/date-format.ts`

```typescript
import type { Verifier, VerifierResult } from "./types.ts";

// Verifies that the extracted date is:
// 1. A single value (NOT a comma-separated list of dates — that's a structural error)
// 2. Parses as a valid ISO 8601 date (YYYY-MM-DD)
// 3. Represents a real calendar date (not 2024-02-31)
//
// Rationale: extraction errors on date fields often produce concatenated multi-value
// strings (e.g., "2024-01-01,2024-02-01") instead of a single date. Such strings may
// look valid in isolation but break downstream date arithmetic.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dateFormat: Verifier = (ctx): VerifierResult => {
  const { field_envelope } = ctx;

  if (field_envelope.absence_state !== "present") {
    return { passes: true };
  }

  const nv = field_envelope.normalized_value;
  if (typeof nv !== "string") {
    return {
      passes: false,
      reason: `normalized_value must be a string for date fields (got ${typeof nv})`,
    };
  }

  // Reject comma-separated multi-value strings.
  if (nv.includes(",")) {
    return {
      passes: false,
      reason: `date field contains comma — expected a single ISO date, got "${nv}"`,
    };
  }

  // Reject anything not in YYYY-MM-DD format.
  if (!ISO_DATE_RE.test(nv)) {
    return {
      passes: false,
      reason: `date "${nv}" does not match ISO 8601 format YYYY-MM-DD`,
    };
  }

  // Parse and confirm it's a real calendar date.
  // Using Date.parse + round-trip check rejects things like 2024-02-31.
  const parsed = new Date(nv);
  if (Number.isNaN(parsed.getTime())) {
    return { passes: false, reason: `date "${nv}" is not a valid calendar date` };
  }

  // Round-trip: 2024-02-31 parses to 2024-03-02, which would round-trip to a
  // different string. Reject if the round-trip differs.
  const roundTrip = parsed.toISOString().slice(0, 10);
  if (roundTrip !== nv) {
    return {
      passes: false,
      reason: `date "${nv}" is not a real calendar date (round-trips to ${roundTrip})`,
    };
  }

  return { passes: true };
};
```

### 5. Registry — `index.ts`

Path: `supabase/functions/process-document/verifiers/index.ts`

```typescript
import type { Verifier } from "./types.ts";
import { monetaryVerbatim } from "./monetary-verbatim.ts";
import { enumVerifier } from "./enum.ts";
import { dateFormat } from "./date-format.ts";

// Verifier registry keyed by the verifier_ref strings used in schemas.
// Schema fields declare verifier_refs: ["monetary-verbatim"] and the
// pipeline looks up the implementation here.

export const VERIFIERS: Record<string, Verifier> = {
  "monetary-verbatim": monetaryVerbatim,
  "enum": enumVerifier,
  "date-format": dateFormat,
};

export type { Verifier, VerifierResult, VerifierContext, FieldSpec, FieldEnvelope } from "./types.ts";
```

### 6. Unit tests

Path: `src/tests/verifiers.test.ts`

Cover positive and negative cases for each verifier. Single test file, not subdirectory (the implementation plan suggests `src/tests/verifiers/` but a single file is fine given there are only three verifiers).

```typescript
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
```

### 7. CI check for model-identifier scanning

Per architecture §9.3, add a script that scans verifier source files for model identifiers and fails if any are found. The implementation plan calls for "CI test"; the simplest implementation is a test file that's run by `npx tsx` alongside other tests.

Path: `src/tests/verifiers-no-model-identifiers.test.ts`

```typescript
import * as fs from "fs";
import * as path from "path";

const VERIFIER_DIR = path.resolve(
  __dirname,
  "../../supabase/functions/process-document/verifiers"
);

// Model identifiers that must NEVER appear in verifier source.
// Verifiers must be model-agnostic per architecture §9.3.
const FORBIDDEN_TOKENS = [
  "sonnet",
  "haiku",
  "opus",
  "gpt",
  "gemini",
  "claude",
  "llama",
  "mistral",
];

function scanFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
  const found: string[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

const files = fs
  .readdirSync(VERIFIER_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(VERIFIER_DIR, f));

let violations = 0;
for (const file of files) {
  const found = scanFile(file);
  if (found.length > 0) {
    console.error(
      `\u2717 ${path.basename(file)} contains forbidden model identifier(s): ${found.join(", ")}`
    );
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\nVerifier source files must be model-agnostic (architecture §9.3). Remove model identifiers from the above files.`
  );
  process.exit(1);
}

console.log(`\u2713 ${files.length} verifier files scanned, no model identifiers found`);
```

### 8. Verify

```bash
# Verifier tests
npx tsx src/tests/verifiers.test.ts

# Model-identifier scan
npx tsx src/tests/verifiers-no-model-identifiers.test.ts

# Regression suite
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx src/tests/v2-claim-store-migration.test.ts
npx tsx src/tests/v2-extraction-envelope-migration.test.ts
npm run gen:schemas:check
npx tsc --noEmit
```

Expected:
- Verifier tests: `✓ 15 verifier assertions passed`
- Model-identifier scan: `✓ 5 verifier files scanned, no model identifiers found` (the 5 files are types.ts, monetary-verbatim.ts, enum.ts, date-format.ts, index.ts)
- All regression tests still pass
- `tsc` silent

### 9. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.3-verifiers

# (write the files and verify)

git add supabase/functions/process-document/verifiers/ src/tests/verifiers.test.ts src/tests/verifiers-no-model-identifiers.test.ts
git commit -m "v2: deterministic verifiers for Mietvertrag launch fields (Task 1.3)

Three pure functions backing the verifier_refs declared in
schemas/mietvertrag/schema.yaml:

- monetary-verbatim: extracted monetary value must appear verbatim
  in OCR text (German or plain formatting accepted)
- enum: normalized_value must match field_spec.enum_values
- date-format: ISO 8601 single-value calendar date (rejects
  comma-separated multi-value strings; rejects DD.MM.YYYY)

Architecture: §10. All verifiers are model-agnostic per §9.3 — a
companion test scans verifier source for model identifiers and fails
CI if any appear.

15 unit-test assertions covering positive and negative cases per
verifier, including absence_state skip behavior."

git push -u origin feature/task-1.3-verifiers
```

Report back the branch URL. Nils opens the PR and merges after CI passes.

## Acceptance gates (verify before reporting completion)

- `supabase/functions/process-document/verifiers/` directory exists with: `types.ts`, `monetary-verbatim.ts`, `enum.ts`, `date-format.ts`, `index.ts`
- `src/tests/verifiers.test.ts` exists with 15 assertions and exits 0 (prints `✓ 15 verifier assertions passed`)
- `src/tests/verifiers-no-model-identifiers.test.ts` exists and exits 0 (prints `✓ 5 verifier files scanned, no model identifiers found`)
- No file in `supabase/functions/process-document/verifiers/` contains any of: `sonnet`, `haiku`, `opus`, `gpt`, `gemini`, `claude`, `llama`, `mistral` (case-insensitive)
- All regression tests still pass
- `tsc --noEmit` silent
- Branch pushed to origin

## Constraints

- Verifiers are PURE FUNCTIONS. No imports of LLM clients, no fetch calls, no side effects.
- No model-specific code paths. No comments referencing model behaviors. Use semantic descriptions only.
- Do NOT make the schema reference more than the three verifier_refs already declared. New verifiers (PLZ check, arithmetic consistency, etc.) come in their own future tasks.
- Do NOT modify `schemas/mietvertrag/schema.yaml` (its verifier_refs are already correct).
- Do NOT modify the validator to enforce verifier-file existence. Forward references are allowed.
- Do NOT push directly to main. Use feature branch + PR workflow.
- Pipe git commands through `| cat`.
