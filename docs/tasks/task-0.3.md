# Task 0.3 — Generator scaffolding (Phase 1 outputs only)

Reference docs: `docs/extraction-v2/extraction-v2-implementation-plan.md` (Task 0.3 section), `docs/extraction-v2/extraction-v2-architecture.md` §7.1, §7.2. Prior tasks: `docs/tasks/task-0.1.md`, `docs/tasks/task-0.2.md` (both shipped). The validator from Task 0.2 (`scripts/validate-schemas.ts`) is reused here as a precondition check.

This is a **t2 task** (logic, requires review). It introduces a generator that writes machine-consumed code into the repo, so generated outputs must be deterministic, deny-listed from manual edits, and CI-enforced.

## Repo conventions (do NOT deviate)

- Package manager: **npm** (NOT pnpm, NOT yarn)
- Tests run via npx tsx: `npx tsx -r dotenv/config src/tests/<file>.ts`
- Validation library: **zod** (now declared as devDependency per the fix-up commit `332d0aa`)
- YAML parsing: **js-yaml** (`^4.1.1`, already a direct dependency)
- TypeScript: 5.x, target Next.js's existing tsconfig
- No husky in this repo. Do NOT install it. Do NOT add a `.husky/` directory. The pre-commit hook from the v2 plan is **OUT OF SCOPE for Task 0.3** — replaced by a CI gate (step 6 below).
- Pipe potentially-paged commands through `| cat`

## Critical: dependency hygiene

Before importing ANY library, verify it is declared in `package.json` (NOT just present in `node_modules` as a transitive dependency). The Task 0.1/0.2 fix-up commit `332d0aa` was needed because zod was used in code but only present transitively. Do not repeat that pattern.

For Task 0.3, the libraries needed are:
- `js-yaml` — already a direct dependency
- `zod` — now a direct devDependency
- `node:fs`, `node:path`, `node:crypto` — Node built-ins, no install needed

If any other library is reached for, install it with `npm install --save-dev <pkg>` and verify it appears in `package.json` BEFORE importing it in code.

## Critical: Deno compatibility for generated outputs

The `prompt_fragment.ts` and `envelope_validator.ts` generated files are imported by the Supabase Edge Function (`supabase/functions/process-document/index.ts`), which runs **Deno**, not Node. This means:

- Generated files MUST use explicit `.ts` extensions in any `import` statements (e.g., `import { foo } from "./other.ts"` — NOT `from "./other"`)
- Generated files MUST NOT use `node:` prefixed imports (`node:fs`, `node:crypto`, etc.) — these don't exist in Deno
- Generated files MUST NOT use Node-specific globals (`process.env`, `__dirname`, etc.). The generator script itself runs in Node and CAN use these; the generator's outputs must not.
- Generated files SHOULD be self-contained (no runtime dependencies beyond Deno's standard library). If a runtime dependency is needed, declare it explicitly and verify it works in Deno.

The generator script (`scripts/gen-schemas.ts`) runs in Node. Only its outputs need to be Deno-compatible.

## Steps

### 1. Create scripts/gen-schemas.ts

A Node CLI that reads all `schemas/<doc_type>/schema.yaml`, validates them via the existing `scripts/validate-schemas.ts` (re-use its exported validator function — do not duplicate the Zod schema), and writes Phase 1 outputs to `schemas/<doc_type>/generated/`.

CLI signature:

```
npx tsx scripts/gen-schemas.ts          # generate all
npx tsx scripts/gen-schemas.ts --check  # generate to memory, compare to disk, exit non-zero on diff (for CI)
npx tsx scripts/gen-schemas.ts --doc-type mietvertrag  # generate one doc type
```

Behavior:

- Validate every input schema first via `scripts/validate-schemas.ts`. If validation fails, exit 1 with the validator's error message.
- For each schema, compute outputs deterministically (same input → byte-identical output, regardless of run order or system clock).
- Write outputs to `schemas/<doc_type>/generated/<filename>`.
- Each generated file starts with a header comment:
  ```
  // DO NOT EDIT — generated from schemas/<doc_type>/schema.yaml
  // Generator: scripts/gen-schemas.ts
  // Schema version: <schema_version from input>
  // Run `npm run gen:schemas` to regenerate.
  ```
- After writing all outputs, log `✓ Generated outputs for N doc types`.

### 2. Phase 1 outputs (only — Phase 2 and 3 are deferred)

For each doc type, write three files into `schemas/<doc_type>/generated/`:

**File A — `prompt_fragment.ts`**

A Deno-compatible TypeScript module exporting the prompt fragment for Step 8b (Sonnet structured-output prompt). Per architecture §7.2:

```typescript
// DO NOT EDIT — generated from schemas/mietvertrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-08-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `<prompt_fragment_template content from schema.yaml, with field instructions interpolated>`;

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "mietvertrag";
```

For the stubs (which currently have only the `doc_type_marker` placeholder field), the prompt fragment is essentially the `prompt_fragment_template` string from the schema with a minimal "extract the placeholder field" instruction appended. The real per-field instructions come in tasks 1.1, 1.4, 2.1, 2.1b, 2.4 when the schemas gain real fields.

For now, the stub schemas have `prompt_fragment_template: "TODO: populated in Task X.Y"`. The generated `prompt_fragment.ts` reflects exactly this — it is a placeholder pending real prompt content. The generator must NOT invent prompt content; it must propagate what the schema declares.

**File B — `field_labels.json`**

A JSON file mapping `field.id` → `german_label` for all fields in the schema. Used by the triage overlay (which is Node-side, not Deno, so JSON is fine).

```json
{
  "schema_version": "2026-05-08-v1",
  "doc_type": "mietvertrag",
  "labels": {
    "doc_type_marker": "Dokumenttyp-Marker (Stub)"
  }
}
```

**File C — `envelope_validator.ts`**

A Deno-compatible TypeScript module exporting a minimal envelope validator. Per architecture §7.2 Phase 1, the validator must reject:

1. Values with no `evidence` field (or empty evidence array)
2. Values with an invalid `absence_state` (must be one of: `not_present`, `not_applicable`, `present_but_unreadable`, `present_but_unknown_value`, `present_but_low_confidence`, `contradicted`, `ambiguous`, `not_extracted_in_this_run`)
3. Values where the field type is `enum` but the value is not in the schema's `enum_values`
4. Values missing the `severity` field

The validator does NOT use Zod (Deno doesn't ship Zod by default and we want zero runtime deps for Edge Function code). Hand-write the validation logic as plain TypeScript. Throw `EnvelopeValidationError` (defined in the file) on any failure with a clear message identifying which field and which check failed.

```typescript
// DO NOT EDIT — generated from schemas/mietvertrag/schema.yaml
// ...header comment...

export class EnvelopeValidationError extends Error {
  constructor(public field: string, public check: string, message: string) {
    super(message);
  }
}

export function validateEnvelope(envelope: unknown): void {
  // ... hand-written checks per the rules above ...
}

export const SCHEMA_VERSION = "2026-05-08-v1";
export const DOC_TYPE = "mietvertrag";
```

For the stub schemas (one placeholder field), the validator is minimal — it knows about one field and its type. As schemas gain real fields, the generator regenerates `envelope_validator.ts` with the new field set.

### 3. Add npm script

In `package.json`, add to the `scripts` block:

```
"gen:schemas": "tsx scripts/gen-schemas.ts",
"gen:schemas:check": "tsx scripts/gen-schemas.ts --check"
```

(Use `tsx` not `npx tsx` in the script — once it's an npm script, npm resolves `tsx` from local `node_modules/.bin`.)

### 4. Run the generator and commit the generated files

Run `npm run gen:schemas`. Verify:

- `schemas/<doc_type>/generated/` directory created for all 5 doc types
- Each contains 3 files: `prompt_fragment.ts`, `field_labels.json`, `envelope_validator.ts`
- All files have the "DO NOT EDIT" header
- Re-running `npm run gen:schemas` produces no diff (deterministic output)

Commit the generated files. They are part of the source tree, not gitignored. The CI gate in step 6 enforces that they stay in sync with their source schemas.

### 5. Add a .gitattributes entry

Create or extend `.gitattributes` at repo root to mark generated files as such (helps GitHub diffs, doesn't affect functionality):

```
schemas/*/generated/** linguist-generated=true
```

### 6. Add CI workflow gate (replaces the husky pre-commit hook from the original plan)

Create `.github/workflows/generated-files-fresh.yml`:

```yaml
name: Generated files fresh

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Verify generated files match schemas
        run: npm run gen:schemas:check
```

The `--check` flag in step 1 makes the generator exit non-zero if disk content differs from generated content. Any commit that modifies a `schemas/<doc_type>/schema.yaml` without re-running the generator fails this gate.

### 7. Update ARCHITECTURE_STATE.md

Extend the existing v2 section with:

- `schemas/<doc_type>/generated/` directories exist (one per launch-slice doc type)
- Three generated files per doc type: `prompt_fragment.ts`, `field_labels.json`, `envelope_validator.ts`
- Generator at `scripts/gen-schemas.ts` (CLI: `npm run gen:schemas`, check mode: `npm run gen:schemas:check`)
- CI gate at `.github/workflows/generated-files-fresh.yml` enforces that generated files stay in sync with source schemas
- Phase 2 outputs (JSON Schema, Zod schemas) and Phase 3 outputs (TypeScript types, eval rubric, emitter stubs) are deferred per architecture §7.2 — added when consumers exist

### 8. Verify

Run all checks:

```
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts  # regression
npx tsx -r dotenv/config src/tests/schemas.test.ts            # regression
npm run gen:schemas                                           # generate fresh outputs
npm run gen:schemas:check                                     # confirm no diff
ls schemas/mietvertrag/generated/ | cat                       # verify outputs exist
```

Expected:
- Both regression tests still pass
- `npm run gen:schemas` exits 0 with `✓ Generated outputs for 5 doc types`
- `npm run gen:schemas:check` exits 0 with the same message (no diff)
- The generated/ directory shows 3 files

### 9. Commit and push

Commit message: `v2: add generator scaffolding for Phase 1 outputs (Task 0.3)`

Push to main.

## Acceptance gates (verify before reporting completion)

- `ls schemas/mietvertrag/generated/ | cat` shows: `envelope_validator.ts`, `field_labels.json`, `prompt_fragment.ts`
- Same for the other 4 doc types
- `head -3 schemas/mietvertrag/generated/prompt_fragment.ts` shows the "DO NOT EDIT" header
- `npm run gen:schemas` exits 0 with `✓ Generated outputs for 5 doc types`
- `npm run gen:schemas:check` exits 0 (no diff after regenerating)
- Both regression tests still pass: `domain-knowledge.test.ts` and `schemas.test.ts`
- `cat package.json | grep gen:schemas` shows the new scripts
- `.github/workflows/generated-files-fresh.yml` exists
- `ARCHITECTURE_STATE.md` change is in the commit
- `git log -1 --stat | cat` shows the commit landed with all expected files

## Constraints

- Do NOT edit the generated files manually. The generator is the source of truth. If output looks wrong, fix the generator or the source schema.
- Do NOT use Zod or any other validator library inside the generated `envelope_validator.ts`. Hand-write the checks. Edge Function runtime is Deno; minimize runtime deps.
- Do NOT use `node:` prefixed imports inside generated files. Generator script CAN use them (it runs in Node).
- Do NOT install husky or add `.husky/`. The CI gate replaces the pre-commit hook.
- Do NOT install ajv or any second validation library. Generator script reuses zod from Task 0.2's validator.
- Do NOT skip the `--check` mode of the generator. The CI gate depends on it.
- Do NOT create real prompt fragments or real envelope validation logic. The schemas have stub fields only; the generator must propagate what the schema declares, not invent content.
- Do NOT use pnpm or yarn. This repo uses npm.
- When running git or other potentially-paged commands, pipe through `| cat`.
- Before importing ANY new library, verify it is in `package.json` (not just `node_modules`). If missing, install with `npm install --save-dev <pkg>` first.
