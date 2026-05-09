# Task 0.2 — schemas/ directory and YAML meta-schema

Reference docs: `docs/extraction-v2/extraction-v2-implementation-plan.md` (Task 0.2 section), `docs/extraction-v2/extraction-v2-architecture.md` §7.1, §7.2, §6.4 (consumer contract from Task 0.1). Prior task: `docs/tasks/task-0.1.md` (already shipped — `domain_knowledge/` directory exists, validator at `src/tests/domain-knowledge.test.ts`).

## Repo conventions (do NOT deviate)

- Package manager: **npm** (NOT pnpm, NOT yarn)
- Tests run directly via npx tsx: `npx tsx -r dotenv/config src/tests/<file>.ts`
- Validation library: **zod** (already in dependencies)
- YAML parsing: use whatever Task 0.1 already installed (check `package.json` — likely js-yaml). Do NOT add a second YAML library.
- Pipe potentially-paged commands through `| cat` (git log, etc.)

## Steps

### 1. Create directory

Create `schemas/` at repo root. Create five subdirectories matching the launch-slice doc types from Task 0.1:

- `schemas/mietvertrag/`
- `schemas/wohnungsuebergabeprotokoll/`
- `schemas/mieterhoehung/`
- `schemas/mietvertragsnachtrag/`
- `schemas/kuendigung/`

### 2. Create schemas/_meta_schema.yaml

This file is documentation describing the per-doc-type schema YAML structure. Runtime validation uses a Zod schema in step 4 mirroring this. Top-level fields:

- `doc_type`: string, required, must match the directory name (`schemas/<doc_type>/schema.yaml`)
- `schema_version`: string, required, format `YYYY-MM-DD-vN` (e.g., `2026-05-08-v1`)
- `claim_kind`: enum (`assertion` | `snapshot` | `event` | `reference`), required
- `domain_knowledge_ref`: string, required, must point to existing file (`domain_knowledge/<doc_type>.md`)
- `prompt_fragment_template`: string, required (multiline allowed)
- `fields`: array of field definitions, required, must contain at least one entry

Each `field` entry has:

- `id`: string, required, snake_case
- `german_label`: string, required (display label for the triage UI)
- `severity`: enum (`critical` | `important` | `nice_to_have`), required
- `requiredness`: enum (`required` | `conditional` | `optional`), required
- `condition`: string, required only when `requiredness == "conditional"` (boolean expression referencing other field ids)
- `type`: enum (`string` | `number` | `boolean` | `date` | `money` | `enum` | `enum_extensible` | `structured` | `structured_array`), required
- `enum_values`: array of strings, required only when `type` is `enum` or `enum_extensible`
- `item_schema`: array of `{field, type, required}` definitions, required only when `type` is `structured` or `structured_array`
- `verifier_refs`: array of strings, optional, default `[]`
- `normalization_rule_ref`: string, optional (must match an `id` in the corresponding domain knowledge `normalization_rules` array)
- `description`: string, optional (multiline allowed)
- `used_in_resolvers`: boolean, optional, default `false` (per architecture §10.5 / schemas Section 1 metadata)
- `customer_visible`: boolean, optional, default `true`
- `classification_hints`: string, optional (multiline allowed; only meaningful for fields whose `id` ends in `_typ` or matches a known classification field)

### 3. Create five stub schema files

Each stub has the minimum valid schema. Format example for `schemas/mietvertrag/schema.yaml`:

```
doc_type: mietvertrag
schema_version: "2026-05-08-v1"
claim_kind: assertion
domain_knowledge_ref: domain_knowledge/mietvertrag.md
prompt_fragment_template: |
  TODO: populated in Task 1.1
fields:
  - id: doc_type_marker
    german_label: "Dokumenttyp-Marker (Stub)"
    severity: nice_to_have
    requiredness: optional
    type: string
    description: |
      Placeholder field so the stub validates against the meta-schema's
      "fields must contain at least one entry" rule. Replaced with real
      fields in the per-doc-type tasks.
```

Files to create with these `claim_kind` values (must match the domain knowledge stubs from Task 0.1):

| File | claim_kind | TODO reference |
|---|---|---|
| `schemas/mietvertrag/schema.yaml` | `assertion` | Task 1.1 |
| `schemas/wohnungsuebergabeprotokoll/schema.yaml` | `event` | Task 1.4 |
| `schemas/mieterhoehung/schema.yaml` | `assertion` | Task 2.1 |
| `schemas/mietvertragsnachtrag/schema.yaml` | `reference` | Task 2.1b |
| `schemas/kuendigung/schema.yaml` | `event` | Task 2.4 |

### 4. Create the validator

Create `scripts/validate-schemas.ts`. Must export a function (so tests can import it) and also be runnable as a CLI script (`npx tsx scripts/validate-schemas.ts` exits 0 on success, non-zero on failure).

The validator performs four checks per `schemas/<doc_type>/schema.yaml`:

**Check A — meta-schema validity:** parse YAML, validate against the Zod schema mirroring `schemas/_meta_schema.yaml`. All required fields present, all enums valid, `requiredness: conditional` fields have a `condition`, `type: enum` fields have `enum_values`, `type: structured` fields have `item_schema`.

**Check B — directory and filename consistency:** the `doc_type` field must match the parent directory name. The file must be at `schemas/<doc_type>/schema.yaml` exactly.

**Check C — cross-reference to domain knowledge:** the `domain_knowledge_ref` field must point to a file that exists. Read that domain knowledge file, parse its front-matter. The schema's `claim_kind` must match the domain knowledge's `default_claim_kind`. Every entry in the domain knowledge's `fields_governed` array must appear as a `field.id` in the schema's `fields` array.

  Note: the stubs from Task 0.1 have empty `fields_governed`, so this check is currently soft (passes when `fields_governed` is empty). When real fields are populated in Phase 1+, the check becomes load-bearing.

**Check D — normalization_rule_ref integrity:** any field with a `normalization_rule_ref` value must reference an `id` in the domain knowledge file's `normalization_rules` array.

  Same softness as Check C: stubs have empty arrays, soft for now.

The validator must report which file and which check failed. Logs `✓ N schemas validated` on success.

### 5. Create src/tests/schemas.test.ts

The test must:

- Import the validator from `scripts/validate-schemas.ts`
- Run it against every `schemas/<doc_type>/schema.yaml`
- Throw on any validation failure
- Log `✓ N schemas validated (5 expected)` on success
- Be runnable via: `npx tsx -r dotenv/config src/tests/schemas.test.ts`

### 6. Update ARCHITECTURE_STATE.md

Add a section "v2 schemas layer" (or extend the existing "v2 domain knowledge layer" section) noting:

- `schemas/` directory exists with 5 doc-type subdirectories
- Each has a stub `schema.yaml` validating against the meta-schema
- Validator at `scripts/validate-schemas.ts` (importable + CLI)
- Test at `src/tests/schemas.test.ts` runs the validator
- Cross-validation against domain knowledge: claim_kind match, fields_governed coverage, normalization_rule_ref integrity. Currently soft because stubs have empty arrays — becomes load-bearing in Phase 1+.

### 7. Verify

Run all three checks:

```
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx scripts/validate-schemas.ts
```

Expected output:
- Test 1: `✓ 5 domain knowledge files validated` (unchanged from Task 0.1)
- Test 2: `✓ 5 schemas validated (5 expected)`
- CLI run: `✓ 5 schemas validated`

### 8. Commit and push

Commit message: `v2: add schemas/ directory + meta-schema validator + cross-ref checks (Task 0.2)`

Push to main.

## Acceptance gates (verify before reporting completion)

- `ls schemas/ | cat` shows: `_meta_schema.yaml`, `kuendigung/`, `mieterhoehung/`, `mietvertrag/`, `mietvertragsnachtrag/`, `wohnungsuebergabeprotokoll/`
- `ls schemas/mietvertrag/` shows: `schema.yaml` (and same for the other four subdirs)
- `npx tsx -r dotenv/config src/tests/schemas.test.ts` exits 0 with `✓ 5 schemas validated`
- `npx tsx scripts/validate-schemas.ts` (CLI mode) exits 0 with the same message
- `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts` still passes (no regression in Task 0.1)
- `git log -1 --stat | cat` shows the commit landed with all expected files
- `ARCHITECTURE_STATE.md` change is in the commit

## Constraints

- Do NOT modify Task 0.1 deliverables. The domain knowledge stubs and their validator are stable. Task 0.2 reads from them but does not change them.
- Do NOT skip the cross-reference checks (Checks C and D). The whole point of the meta-schema is to enforce consistency between domain knowledge and schemas. Even if the checks are currently soft (empty arrays), the validation logic must exist and be tested.
- Do NOT install ajv or any second validation library. Use zod.
- Do NOT use pnpm or yarn. This repo uses npm.
- Do NOT create real fields in the stubs. The stubs have one placeholder field (`doc_type_marker`) so they validate. Real fields are added in tasks 1.1, 1.4, 2.1, 2.1b, 2.4.
- When running git or other potentially-paged commands, pipe through `| cat`.
