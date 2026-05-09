# Task 0.1 — domain_knowledge/ directory and front-matter schema

**Reference docs:** `docs/extraction-v2/extraction-v2-implementation-plan.md` (Task 0.1 section), `docs/extraction-v2/extraction-v2-architecture.md` §6.3, §6.4, §5.5.2, §5.5.3.

## Repo conventions (do NOT deviate)

- Package manager: **npm** (NOT pnpm, NOT yarn)
- Tests run directly via npx tsx, not via a `test` script: `npx tsx -r dotenv/config src/tests/<file>.ts`
- Validation library: **zod** (already in dependencies — do NOT add ajv)
- YAML parsing: js-yaml or gray-matter — check `package.json` and use whichever is already installed; if neither, install **js-yaml** via npm

## Steps

### 1. Create directory
Create `domain_knowledge/` at repo root.

### 2. Create domain_knowledge/_schema.yaml
This file is documentation describing the front-matter meta-schema. Runtime validation uses a Zod schema in step 5 mirroring this. Fields:

- `doc_type`: string, required, must match filename without `.md`
- `default_claim_kind`: enum (`assertion` | `snapshot` | `event` | `reference`), required
- `last_updated`: ISO 8601 date string, required
- `legal_grounding`: array of `{statute: string, description: string}`, optional, default `[]`
- `fields_governed`: array of strings, optional, default `[]`
- `normalization_rules`: array of `{id: string, field: string, description: string}`, optional, default `[]`
- `gotchas`: array of `{id: string, description: string, behavior?: object, real_failure_reference?: string}`, optional, default `[]`
- `adversarial_fixtures_required`: array of strings, optional, default `[]`
- `closes`: array of `{target_predicate: string, target_subject_pattern: string, close_mode: enum, when: string, valid_to_source: string, match_requirements: object, blocker_check?: array}`, optional, default `[]`
  - `close_mode` enum values: `close_overlapping_only` | `close_overlapping_and_future` | `close_overlapping_and_supersede_future` (per architecture §5.5.3)

### 3. Create domain_knowledge/README.md
Explain the consumer contract per architecture §6.4:

- The front-matter is consumed by emitters, verifiers, and the transaction applier (typed via Zod schema)
- The prose body below the front-matter is reference for humans, not parsed
- Every field listed in `fields_governed` must appear as a `field.id` in the corresponding `schemas/<doc_type>/schema.yaml` (cross-validated by CI in Task 0.2)
- Every gotcha id must be referenced from at least one adversarial fixture or verifier (CI-checked starting in Phase 1; soft until those exist)
- The `closes` array is read by the transaction applier (architecture §5.5) — `close_mode` declarations here drive applier behavior

### 4. Create five stub files
Each with empty but valid front-matter and a one-line body comment. Stub format example for `mietvertrag.md`:

```
---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding: []
fields_governed: []
normalization_rules: []
gotchas: []
adversarial_fixtures_required: []
closes: []
---

<!-- TODO: populated in Task 1.1 -->
```

Files to create:

| File | default_claim_kind | TODO reference |
|---|---|---|
| `domain_knowledge/mietvertrag.md` | `assertion` | Task 1.1 |
| `domain_knowledge/wohnungsuebergabeprotokoll.md` | `event` | Task 1.4 |
| `domain_knowledge/mieterhoehung.md` | `assertion` | Task 2.1 |
| `domain_knowledge/mietvertragsnachtrag.md` | `reference` | Task 2.1b |
| `domain_knowledge/kuendigung.md` | `event` | Task 2.4 |

### 5. Create src/tests/domain-knowledge.test.ts

The test must:

- Define a Zod schema mirroring `domain_knowledge/_schema.yaml` (the YAML file is documentation; Zod is the runtime validator)
- Read every `domain_knowledge/*.md` file (skip `_schema.yaml` and `README.md`)
- Parse front-matter using js-yaml or gray-matter (whichever is in `package.json`)
- Validate parsed front-matter against the Zod schema
- Assert `doc_type` matches filename without `.md`
- Throw on any validation failure with a clear message identifying which file and which field
- Log `✓ N domain knowledge files validated` on success
- Be runnable via: `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts`

### 6. Update ARCHITECTURE_STATE.md
Add a section "v2 domain knowledge layer" noting:

- `domain_knowledge/` directory exists
- 5 stub files present (one per launch-slice doc type)
- Front-matter Zod validator in `src/tests/domain-knowledge.test.ts`
- Validator currently runs manually; CI integration is part of Task 0.2

### 7. Verify
Run: `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts`

Expected output: `✓ 5 domain knowledge files validated`

### 8. Commit and push
Commit message: `v2: add domain_knowledge/ directory + front-matter validator (Task 0.1)`

Push to main.

## Acceptance gates (verify before reporting completion)

- `ls domain_knowledge/` shows: `_schema.yaml`, `README.md`, `mietvertrag.md`, `wohnungsuebergabeprotokoll.md`, `mieterhoehung.md`, `mietvertragsnachtrag.md`, `kuendigung.md`
- `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts` exits 0 with `✓ 5 domain knowledge files validated`
- `git log -1 --stat | cat` shows the commit landed with all expected files (note: pipe through `cat` to avoid pager)
- `ARCHITECTURE_STATE.md` change is in the commit

## Constraints

- Do NOT skip the validator test. The validator IS the deliverable. A directory of stubs without a working validator means Task 0.2 cannot depend on this task being done correctly.
- Do NOT install ajv. Use zod (already in dependencies).
- Do NOT use pnpm or yarn. This repo uses npm.
- When running git or other potentially-paged commands, pipe through `| cat` to avoid getting stuck in `less`.
