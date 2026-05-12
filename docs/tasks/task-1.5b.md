# Task 1.5b — Comprehensive envelope-validator audit and fix

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §3.1 (field-level envelope shape), §3.2 (8 absence states)

Code touched:
- `scripts/gen-schemas.ts` — generator that emits envelope_validator.ts
- `schemas/<doc_type>/generated/envelope_validator.ts` — regenerated outputs (5 files)
- `supabase/functions/process-document/index.ts` — `generateV2Envelope()` function (~line 939)
- `src/tests/envelope-validator.test.ts` — NEW test file

This is a **t2 task** (logic, requires review). It fixes the envelope validator to actually match the architecture spec, and adds a test that prevents future drift. The Task 1.5 smoke test discovered three real bugs by deploying-and-watching — this task catches the remaining bugs (and any future ones) by testing locally instead.

## Context

The dual-path pipeline (Task 1.5) is deployed at Edge Function version 35. Three subsequent fix PRs (#20, #21, #22) corrected absence_state values, removed a spurious severity check, and changed evidence shape from object to array.

Smoke-test status as of pause:
- Lena Everding Mietvertrag re-extraction fails on a fourth validator bug: `evidence` is required unconditionally, but architecture §3.1 says it's required only when `absence_state == "present"`. Lena's `mietende` correctly has `absence_state: "not_applicable"` (open-ended lease) and no evidence; validator wrongly rejects.
- Lena's stuck job is parked at status `dead_letter` to stop the retry cycle.

A full audit of the validator against architecture §3.1 found four issues:

1. **(B) Evidence unconditional requirement** — Validator throws if `evidence` is not a non-empty array, regardless of `absence_state`. Architecture §3.1 says evidence is mandatory ONLY when `absence_state == "present"`. **Must fix.**

2. **(C) Severity is missing from envelope** — Architecture §3.1: "severity is set in schema, **copied into extraction for eval**." PR #21 removed the validator's severity check entirely with the wrong reasoning ("Sonnet can't know"). Correct interpretation: severity isn't extracted by Sonnet; it's copied into the envelope by the pipeline from the schema's `FIELD_DEFS` before validation. **Must fix.**

3. **(D) Check 3 references wrong field** — Validator code: `if (v.value !== undefined && ...)`. The envelope uses `normalized_value`, not `value`. Dead-code path that should be `v.normalized_value`. **Should fix.**

4. **(E) Missing type-checks for architecture-defined enums** — `confidence` (high|medium|low) and `validation_status` (valid|failed_format|failed_verifier|requires_human_review) are defined in §3.1 but not validated. **Nice to fix.**

This brief addresses all four, gated by a comprehensive test that exercises both the happy path and every absence_state case.

## Repo conventions

- npm (not pnpm)
- Deno for Edge Function code (explicit `.ts` extensions on internal imports)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Tests that don't need DB env can run with plain `npx tsx`
- Pipe potentially-paged commands through `| cat`
- Branch protection enforced — do NOT push to main directly

## Decisions made before this task

- **Evidence shape stays as array.** PR #22's choice is correct: a field can have multiple supporting evidence quotes (Kaltmiete in contract body + appendix). Architecture §3.1's table will be updated separately to match. This task does NOT change evidence shape.
- **Severity placement: pipeline injects from FIELD_DEFS.** The pipeline (`generateV2Envelope` in `index.ts`) copies severity from the schema's FIELD_DEFS into each field of the envelope BEFORE calling `validateEnvelope`. The validator then checks severity is present + valid. This keeps schema-metadata-injection as a pipeline responsibility, separate from validation.

## Steps

### 1. Write the test FIRST

Path: `src/tests/envelope-validator.test.ts`

The test imports `validateEnvelope` and `EnvelopeValidationError` from `schemas/mietvertrag/generated/envelope_validator.ts`. It exercises:

- **Happy path full envelope**: all 5 fields present, `absence_state: "present"`, evidence arrays with one entry each, valid normalized_values, severity set per FIELD_DEFS → passes.
- **Open-ended lease (Lena's case)**: mietende with `absence_state: "not_applicable"`, NO evidence, NO normalized_value → passes.
- **Each absence_state value** (8 cases): with appropriate evidence/value combinations per architecture rules → all pass.
- **Evidence required only when present**: `absence_state: "present"` + no evidence → rejected. Any other absence_state + no evidence → passes.
- **Invalid absence_state**: `"unknown_state"` → rejected.
- **Invalid confidence**: `"super-sure"` → rejected. Valid: high/medium/low → accepted.
- **Invalid validation_status**: `"foo"` → rejected. Valid: valid/failed_format/failed_verifier/requires_human_review → accepted.
- **Missing severity**: field with no severity → rejected.
- **Invalid severity**: `"super-critical"` → rejected. Valid: critical/important/nice_to_have → accepted.
- **Wrong evidence shape**: evidence as object (not array), evidence as empty array when present → both rejected.
- **Enum type field**: unit_ref with normalized_value not in enum_values → rejected. Wait — this only applies when absence_state=present.

Use the same assertion style as `src/tests/verifiers.test.ts`: a `passCount` / `failCount` accumulator with `expect(label, condition, detail?)` helper. ~25 assertions total. Exit 1 if any fail.

The test should FAIL on first run against the current validator. That failure documents what the audit found.

Write the test, run it, observe failures. The failures map directly to the validator fixes below.

### 2. Patch `scripts/gen-schemas.ts`

Three changes to the generator's emitted validator template:

**Change 1 — Gate evidence requirement on absence_state:**

Replace:
```typescript
    // Check 1: evidence must exist and be a non-empty array
    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" must have a non-empty evidence array`);
    }
```

With:
```typescript
    // Check 1: evidence is required when absence_state === "present"
    // (architecture §3.1: "Evidence is mandatory unless absence_state is one of the absence states")
    if (v.absence_state === "present") {
      if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
        throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" must have a non-empty evidence array when absence_state == "present"`);
      }
    } else if (v.evidence !== undefined && v.evidence !== null) {
      // If evidence is provided for a non-present field, it must still be a valid array shape
      if (!Array.isArray(v.evidence)) {
        throw new EnvelopeValidationError(fieldId, "evidence", `Field "${fieldId}" evidence must be an array if provided`);
      }
    }
```

**Change 2 — Fix Check 3 to use normalized_value:**

Replace:
```typescript
    // Check 3: enum type validation
    if ((def.type === "enum") && def.enumValues !== null) {
      if (v.value !== undefined && v.value !== null && v.absence_state === undefined) {
        if (typeof v.value !== "string" || !def.enumValues.includes(v.value)) {
          throw new EnvelopeValidationError(fieldId, "enum_value", `Field "${fieldId}" value ${JSON.stringify(v.value)} is not in allowed enum_values: ${JSON.stringify(def.enumValues)}`);
        }
      }
    }
```

With:
```typescript
    // Check 3: enum type validation — applies only when absence_state == "present"
    if ((def.type === "enum") && def.enumValues !== null && v.absence_state === "present") {
      if (typeof v.normalized_value !== "string" || !def.enumValues.includes(v.normalized_value)) {
        throw new EnvelopeValidationError(fieldId, "enum_value", `Field "${fieldId}" normalized_value ${JSON.stringify(v.normalized_value)} is not in allowed enum_values: ${JSON.stringify(def.enumValues)}`);
      }
    }
```

**Change 3 — Add Check 4 (severity) and Check 5 (confidence enum) and Check 6 (validation_status enum):**

Replace the existing comment block:
```typescript
    // NOTE: severity is a schema-level property declared in schema.yaml per field,
    // NOT an extraction-time property. Earlier versions of this validator required
    // the extracted envelope to carry severity redundantly, but Sonnet has no way
    // to know what the schema says — the value would just be copied. Severity is
    // available to downstream consumers via FIELD_DEFS above (keyed by field id).
```

With:
```typescript
    // Check 4: severity must be present and match the schema (architecture §3.1:
    // "copied into extraction for eval"). The pipeline is responsible for copying
    // severity from FIELD_DEFS into each field of the envelope before calling
    // validateEnvelope. The validator confirms it landed correctly.
    if (typeof v.severity !== "string") {
      throw new EnvelopeValidationError(fieldId, "severity", `Field "${fieldId}" must have a string severity (pipeline should inject from FIELD_DEFS)`);
    }
    if (v.severity !== def.severity) {
      throw new EnvelopeValidationError(fieldId, "severity_mismatch", `Field "${fieldId}" severity "${v.severity}" does not match schema-declared severity "${def.severity}"`);
    }

    // Check 5: confidence must be one of the architecture-defined values
    if (v.confidence !== undefined && v.confidence !== null) {
      const validConfidence = ["high", "medium", "low"];
      if (typeof v.confidence !== "string" || !validConfidence.includes(v.confidence)) {
        throw new EnvelopeValidationError(fieldId, "confidence", `Field "${fieldId}" has invalid confidence: ${JSON.stringify(v.confidence)} (must be high | medium | low)`);
      }
    }

    // Check 6: validation_status must be one of the architecture-defined values
    if (v.validation_status !== undefined && v.validation_status !== null) {
      const validStatus = ["valid", "failed_format", "failed_verifier", "requires_human_review"];
      if (typeof v.validation_status !== "string" || !validStatus.includes(v.validation_status)) {
        throw new EnvelopeValidationError(fieldId, "validation_status", `Field "${fieldId}" has invalid validation_status: ${JSON.stringify(v.validation_status)} (must be valid | failed_format | failed_verifier | requires_human_review)`);
      }
    }
```

### 3. Regenerate

```bash
npm run gen:schemas
```

All 5 generated validators (kuendigung, mieterhoehung, mietvertrag, mietvertragsnachtrag, wohnungsuebergabeprotokoll) get the new validator code.

### 4. Patch `supabase/functions/process-document/index.ts`

In `generateV2Envelope()`, after JSON parsing and BEFORE `v2Config.validate(envelopeFields)`, inject severity from the schema into each field of the envelope.

Look for the existing line near the validator call:

```typescript
  // 4. Validate envelope shape.
  const validation = v2Config.validate(envelopeFields);
```

(Or however it's structured — find where the parsed JSON is about to be validated.)

Before that validation, inject severity:

```typescript
  // Inject schema-declared severity into each field of the envelope (architecture §3.1:
  // "copied into extraction for eval"). Sonnet doesn't know what the schema says; the
  // pipeline copies severity from FIELD_DEFS so the validator can confirm it's correct.
  for (const [fieldId, fieldEnvelope] of Object.entries(envelopeFields)) {
    if (fieldEnvelope && typeof fieldEnvelope === "object") {
      const fieldDef = v2Config.fieldSpecs[fieldId]; // or wherever the schema fieldSpecs live
      if (fieldDef && (fieldDef as any).severity) {
        (fieldEnvelope as Record<string, unknown>).severity = (fieldDef as any).severity;
      }
    }
  }
```

NOTE: this requires `v2Config` (or `V2_PROMPTS[docType]`) to carry the severity per field. Currently `fieldSpecs` in V2_PROMPTS only has `id, type, enum_values?`. Add severity to those fieldSpec entries, mirroring schema.yaml. Look at the existing definition:

```typescript
fieldSpecs: {
  kaltmiete: { id: "kaltmiete", type: "money" },
  unit_ref: { id: "unit_ref", type: "enum", enum_values: [...] },
  ...
}
```

Update to:

```typescript
fieldSpecs: {
  kaltmiete: { id: "kaltmiete", type: "money", severity: "critical" },
  unit_ref: { id: "unit_ref", type: "enum", enum_values: [...], severity: "critical" },
  tenant_identity: { id: "tenant_identity", type: "structured", severity: "critical" },
  mietbeginn: { id: "mietbeginn", type: "date", severity: "critical" },
  mietende: { id: "mietende", type: "date", severity: "important" },
}
```

The severity values come from `schemas/mietvertrag/schema.yaml`.

Also update the `FieldSpec` type if necessary so TypeScript accepts the severity field.

### 5. ARCHITECTURE_STATE.md

Append a section documenting:

- Task 1.5b validator audit completed
- Three of four bugs in the original validator now fixed; fourth (evidence shape: array vs §3.1's object) intentionally kept as array
- Pipeline now injects severity from FIELD_DEFS before validation per architecture §3.1
- `src/tests/envelope-validator.test.ts` covers the validator against all 8 absence_state cases + enum invariants

### 6. Verify

```bash
# The new test — should now PASS (failed before patches)
npx tsx src/tests/envelope-validator.test.ts

# Full regression
npx tsc --noEmit
npm run gen:schemas:check
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx src/tests/v2-claim-store-migration.test.ts
npx tsx src/tests/v2-extraction-envelope-migration.test.ts
npx tsx src/tests/verifiers.test.ts
npx tsx src/tests/verifiers-no-model-identifiers.test.ts
```

Expected:
- envelope-validator.test.ts passes with all assertions green
- All previous regression suites still pass
- tsc silent

### 7. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.5b-validator-audit

# (write test, patch generator, patch index.ts, regenerate, update ARCHITECTURE_STATE.md, verify)

git add scripts/gen-schemas.ts \
        schemas/kuendigung/generated/envelope_validator.ts \
        schemas/mieterhoehung/generated/envelope_validator.ts \
        schemas/mietvertrag/generated/envelope_validator.ts \
        schemas/mietvertragsnachtrag/generated/envelope_validator.ts \
        schemas/wohnungsuebergabeprotokoll/generated/envelope_validator.ts \
        supabase/functions/process-document/index.ts \
        src/tests/envelope-validator.test.ts \
        ARCHITECTURE_STATE.md

git commit -m "fix(validator): comprehensive audit + test against architecture §3.1 (Task 1.5b)

Task 1.5 smoke test surfaced three validator bugs over four iterations.
Audit found four total. This PR fixes all of them in one round, gated
by a new test that catches future drift.

Bug B (FIXED) — evidence unconditional requirement.
Original validator required non-empty evidence on every field regardless
of absence_state. Architecture §3.1 says evidence is required ONLY when
absence_state == 'present'. Lena Everding's mietende (open-ended lease,
absence_state: not_applicable) correctly has no evidence; original
validator wrongly rejected. Fixed: evidence check now gated on
absence_state.

Bug C (FIXED) — severity missing from envelope.
PR #21 removed the severity check entirely on the reasoning that
'Sonnet can't know'. That was wrong: architecture §3.1 says severity
is 'set in schema, copied into extraction for eval' — the pipeline
should COPY severity from FIELD_DEFS into the envelope, not ask Sonnet
to produce it. Fixed: generateV2Envelope now injects severity from
v2Config.fieldSpecs[fieldId].severity before validation; validator
re-checks the injection landed correctly.

Bug D (FIXED) — Check 3 referenced wrong field.
Validator's enum check referenced v.value (no such field in envelope)
instead of v.normalized_value. Dead-code path. Fixed.

Bug E (PARTIAL) — missing checks for architecture-defined enums.
Added checks for confidence (high|medium|low) and validation_status
(valid|failed_format|failed_verifier|requires_human_review).

NEW: src/tests/envelope-validator.test.ts. ~25 assertions covering
happy path, all 8 absence_state values, evidence gating, severity
injection, enum invariants, and shape errors. Test fails on the
pre-patch validator; passes on the patched one. Prevents future drift.

Bug A NOT changed — evidence-as-array (PR #22) kept. Architecture §3.1
table shows evidence as object; this is the one place the implementation
intentionally diverges. Array form supports multi-quote evidence (e.g.,
Kaltmiete appearing in contract body AND appendix). Architecture doc to
be updated separately to reflect array shape.

Edge Function redeploy required after merge. See
docs/runbooks/task-1.5-deploy-runbook.md (re-use the same procedure;
Lena's job is parked as dead_letter, will need DELETE + re-queue to
trigger a fresh smoke test against the patched code)."

git push -u origin feature/task-1.5b-validator-audit
```

Report back the branch URL + the test outputs (before + after the patches).

## Acceptance gates (verify before reporting completion)

- `src/tests/envelope-validator.test.ts` exists and passes with all assertions green (paste the output line `✓ N envelope-validator assertions passed`)
- The test was run BEFORE the patches and showed the expected failures (paste a few lines of that output too — proves the test is meaningful, not toothless)
- All 5 generated validators regenerated with the new checks
- `generateV2Envelope` in `index.ts` injects severity from fieldSpecs before validation
- All `V2_PROMPTS.mietvertrag.fieldSpecs` entries have a `severity` property matching schema.yaml
- All regression tests still pass (schemas, domain-knowledge, claim-store, envelope migration, verifiers, model-identifier scan)
- tsc --noEmit silent
- ARCHITECTURE_STATE.md updated
- Branch pushed to origin

## Constraints

- Do NOT change the evidence shape back to object. Stays as array.
- Do NOT redeploy the Edge Function. Deploy is Nils's manual step after merge.
- Do NOT trigger re-extraction of any document.
- Do NOT modify the legacy code path for non-v2 doc types.
- Do NOT skip writing the test before the patches. The point is to prove the test catches the bugs.
- Pipe git commands through `| cat`.

## Reminder

Lena's processing job is parked as `dead_letter`. After this PR merges and Nils redeploys the Edge Function, Nils will need to run:

```sql
UPDATE warehouse.processing_jobs
SET status = 'queued', updated_at = NOW(), error_message = NULL
WHERE id = '6bf3c024-71ae-4db9-8335-626d305e1d37';
```

to re-trigger Lena's smoke test against the patched code. That's not in your scope — it's part of the deploy runbook.
