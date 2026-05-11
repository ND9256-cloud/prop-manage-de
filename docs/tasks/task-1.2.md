# Task 1.2 — Schema: `mietvertrag/schema.yaml` (launch fields only)

Reference docs (in repo):
- `docs/extraction-v2/extraction-v2-implementation-plan.md` Task 1.2 section
- `docs/extraction-v2/extraction-v2-architecture.md` §3.1 (field-level envelope), §6.4 (consumer contract)
- `schemas/_meta_schema.yaml` (the spec this YAML must conform to)
- `scripts/validate-schemas.ts` (runtime Zod validator — authoritative)
- `domain_knowledge/mietvertrag.md` (the just-shipped Task 1.1 content)

This is a **t2 task** (logic, requires review). It populates the first real per-doc-type schema. The output drives prompt construction, field labels, and envelope validation for Mietvertrag extraction in Phase 1+.

**Important context**: this is the FIRST populated schema. All five doc-type schema.yaml files are currently 16-line stubs with a single placeholder field. There is no in-repo reference to pattern-match against. Read the meta-schema and Task 1.1 mietvertrag.md carefully before writing.

## Scope: launch slice only

Five fields. Do NOT add more, even if domain knowledge declares them. The other three (`nebenkostenvorauszahlung`, `kaution`, `landlord_identity`) are deferred to Phase 2 per the implementation plan.

After this PR merges, the `Generated files fresh` CI check will print 3 WARN lines (one per deferred field — they're declared in domain knowledge's `fields_governed` but not yet in schema). Those warnings are expected.

## Repo conventions (do NOT deviate)

- Package manager: **npm** (NOT pnpm — the implementation plan mentions pnpm but this repo uses npm)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- YAML library: **js-yaml** (already declared)
- Validation: **Zod** (already declared; validator lives in `scripts/validate-schemas.ts`)
- Generator: `npm run gen:schemas` and `npm run gen:schemas:check`
- Pipe potentially-paged commands through `| cat`
- Do NOT push directly to main. Branch protection requires PR workflow.

## Steps

### 1. Replace the stub

Path: `schemas/mietvertrag/schema.yaml`

The current file has a placeholder `doc_type_marker` field. Replace ENTIRELY with the real schema.

Top-level structure (per meta-schema):

```yaml
doc_type: mietvertrag
schema_version: "2026-05-11-v1"
claim_kind: assertion
domain_knowledge_ref: domain_knowledge/mietvertrag.md

prompt_fragment_template: |
  (multiline Sonnet instructions — see step 3)

fields:
  - id: kaltmiete
    ...
  - id: unit_ref
    ...
  - id: tenant_identity
    ...
  - id: mietbeginn
    ...
  - id: mietende
    ...
```

Bump `schema_version` to today's date with `-v1` suffix (e.g., `2026-05-11-v1`).

### 2. Field definitions

Five fields, each conforming to the meta-schema's field-entry structure.

**Field 1: `kaltmiete`**

```yaml
- id: kaltmiete
  german_label: "Kaltmiete"
  severity: critical
  requiredness: required
  type: money
  verifier_refs:
    - monetary-verbatim
  normalization_rule_ref: kaltmiete_excludes_nebenkosten
  description: |
    Die monatliche Grundmiete (base rent), excluding Nebenkosten/Betriebskosten.
    Always a monthly amount in EUR. Synonyms: Grundmiete, Nettomiete,
    Nettokaltmiete. Do NOT extract if the contract uses Bruttomiete or
    Inklusivmiete terminology — those bundle Nebenkosten and the Kaltmiete
    component cannot be cleanly separated; set absence_state: ambiguous.
  used_in_resolvers: true
  customer_visible: true
```

**Field 2: `unit_ref`**

```yaml
- id: unit_ref
  german_label: "Einheit"
  severity: critical
  requiredness: required
  type: enum
  enum_values:
    - "EG"
    - "1.OG"
    - "2.OG"
    - "3.OG"
    - "4.OG"
    - "DG"
    - "Keller"
    - "Souterrain"
  verifier_refs:
    - enum
  description: |
    Normalized unit reference (Geschoss/floor identifier). Map common
    variants: "Erdgeschoss" → "EG"; "1. Obergeschoss" → "1.OG";
    "Dachgeschoss" → "DG". Extract from the filled-in unit field of the
    lease, NOT from template boilerplate or page headers (Paul case:
    template carried wrong address; only the filled-in fields are
    authoritative). If multiple units appear and the contract is for
    one specific unit, extract that one; if genuinely ambiguous, set
    absence_state: ambiguous.
  used_in_resolvers: true
  customer_visible: true
```

**Field 3: `tenant_identity`**

```yaml
- id: tenant_identity
  german_label: "Mieter"
  severity: critical
  requiredness: required
  type: structured
  item_schema:
    - field: name
      type: string
      required: true
    - field: is_legal_entity
      type: boolean
      required: true
    - field: legal_form
      type: string
      required: false
  description: |
    The tenant party to the lease. For natural persons, name is the full
    name as written (first + last). For legal entities (GmbH, UG, AG, eG,
    GbR), set is_legal_entity: true and populate legal_form (e.g., "GmbH").
    The legal_form distinction is operationally important: a legal-entity
    tenant signals a Gewerbemietvertrag risk (commercial lease misclassified
    as residential — see gewerbe_misclassification gotcha in domain knowledge).
    For Mietgemeinschaft (multiple tenants on one lease), extract the first
    named tenant; multi-tenant handling is Phase 2.
  used_in_resolvers: true
  customer_visible: true
```

**Field 4: `mietbeginn`**

```yaml
- id: mietbeginn
  german_label: "Mietbeginn"
  severity: critical
  requiredness: required
  type: date
  verifier_refs:
    - date-format
  description: |
    The date the lease takes effect. Format must be ISO 8601 (YYYY-MM-DD).
    Original document typically shows German format (DD.MM.YYYY); normalize.
    This is rarely missing in a Mietvertrag — if it appears missing,
    re-read the document carefully before setting absence_state: absent.
  used_in_resolvers: true
  customer_visible: true
```

**Field 5: `mietende`**

```yaml
- id: mietende
  german_label: "Mietende"
  severity: important
  requiredness: optional
  type: date
  verifier_refs:
    - date-format
  description: |
    The date the lease ends, if fixed-term. Most German residential leases
    are unbefristet (open-ended) — in that case, set absence_state:
    not_applicable rather than omitting the field. The presence/absence
    pattern matters: "the lease has no end date because it's open-ended"
    is different information from "the document doesn't tell us." Format:
    ISO 8601 (YYYY-MM-DD).
  used_in_resolvers: false
  customer_visible: true
```

Field ordering in the file: kaltmiete, unit_ref, tenant_identity, mietbeginn, mietende (matches the brief's order; readers will scan top-down).

### 3. `prompt_fragment_template`

Multiline string. This is the part of the Sonnet system prompt that instructs the model on these specific fields. The generator (`scripts/gen-schemas.ts`) wraps this into the full prompt at runtime.

```yaml
prompt_fragment_template: |
  ## Mietvertrag — extract the following fields

  For each field, return:
  - raw_value: verbatim text from the document
  - normalized_value: typed canonical form (see per-field instructions)
  - evidence: { quote: <verbatim quote>, page: <number>, bbox: null }
  - confidence: high | medium | low
  - absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
  - validation_status: valid (set this; verifiers run separately)

  Evidence is MANDATORY when absence_state == present. Do not set a value without an evidence quote.

  ### kaltmiete (Kaltmiete — base rent, monthly, EUR)

  Extract ONLY the base rent excluding Nebenkosten. Accept synonyms: Grundmiete, Nettomiete, Nettokaltmiete.
  REJECT (set absence_state: ambiguous) if the contract uses Bruttomiete, Inklusivmiete, or Warmmiete — these bundle operating costs and the Kaltmiete component is not separately stated.
  normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 65000, currency: "EUR" } for €650.00.

  ### unit_ref (Einheit — normalized floor/position identifier)

  Extract from the filled-in unit specification, NOT from template boilerplate or headers.
  Normalize to one of: EG, 1.OG, 2.OG, 3.OG, 4.OG, DG, Keller, Souterrain.
  Common mappings: "Erdgeschoss" → EG; "1. Obergeschoss" → 1.OG; "Dachgeschoss" → DG.
  If multiple units are listed (a single lease covering multiple units), extract the unit the lease primarily concerns; if genuinely ambiguous, set absence_state: ambiguous.

  ### tenant_identity (Mieter — the tenant party)

  Extract the tenant as written on the contract.
  normalized_value: { name: <full name as written>, is_legal_entity: <bool>, legal_form: <optional string for entities> }.
  Legal-entity indicators: GmbH, UG, AG, eG, GbR, KG, OHG appearing in the name. Set is_legal_entity: true and populate legal_form with the matching abbreviation.
  For multiple co-tenants (Mietgemeinschaft), extract the first named tenant only.

  ### mietbeginn (Mietbeginn — lease start date)

  Extract the date the lease takes effect.
  normalized_value: ISO 8601 (YYYY-MM-DD). Source is typically DD.MM.YYYY — normalize.
  If the contract specifies "ab Übergabe" or similar without a concrete date, set absence_state: ambiguous.

  ### mietende (Mietende — lease end date, optional)

  Most German residential leases are open-ended (unbefristet). For those, set absence_state: not_applicable. NOT absence_state: absent — the difference is meaningful.
  If the contract specifies a fixed end date (Befristung), extract it. Format: ISO 8601 (YYYY-MM-DD).
```

### 4. Generate the outputs

After writing the schema YAML, run:

```bash
npm run gen:schemas
```

This produces (regenerates, since the directory already exists with stub outputs):
- `schemas/mietvertrag/generated/prompt_fragment.ts`
- `schemas/mietvertrag/generated/field_labels.json`
- `schemas/mietvertrag/generated/envelope_validator.ts`

The generator handles all three; you don't write them by hand.

### 5. Verify

```bash
npm run gen:schemas:check
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsc --noEmit
```

Expected:
- `npm run gen:schemas:check` exits 0. Three WARN lines for the deferred fields (`nebenkostenvorauszahlung`, `kaution`, `landlord_identity`). Summary: `✓ Generated outputs for 5 doc types (3 warnings)`.
- `schemas.test.ts` exits 0 with `✓ 5 schemas validated (3 warnings) (5 expected)`.
- `domain-knowledge.test.ts` exits 0 with `✓ 5 domain knowledge files validated`.
- `tsc` silent.

If any of those fail, fix and re-run. Do not skip verification.

### 6. Verifier forward references

The schema references three verifiers (`monetary-verbatim`, `enum`, `date-format`) that don't exist yet — Task 1.3 will create them. The implementation plan explicitly says "CI allows forward references during Phase 1." If the validator complains about missing verifier files, that's a real check the meta-schema enforces, and means we need to update the validator OR create stub verifier files.

If the validator complains: check `scripts/validate-schemas.ts` for the `verifier_refs` validation logic. If it requires the files to exist, add a forward-reference allowlist comment or create empty stubs at `supabase/functions/process-document/verifiers/{monetary-verbatim,enum,date-format}.ts` that just export a function returning `{ passes: true }`. Document the stub status with a `// TODO: real implementation in Task 1.3` comment.

Most likely the validator does NOT check verifier existence (just records the references), in which case nothing extra is needed.

### 7. Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.2-mietvertrag-schema

# (edit and verify)

git add schemas/mietvertrag/schema.yaml schemas/mietvertrag/generated/
git commit -m "v2: populate mietvertrag schema launch fields (Task 1.2)

Adds five launch-slice fields per implementation plan: kaltmiete,
unit_ref, tenant_identity, mietbeginn, mietende. Schema version
2026-05-11-v1. Generated prompt_fragment.ts, field_labels.json, and
envelope_validator.ts via npm run gen:schemas.

Deferred fields (nebenkostenvorauszahlung, kaution, landlord_identity)
remain declared in domain knowledge fields_governed; they surface as
warnings until their schema entries land in Phase 2.

References monetary-verbatim, enum, and date-format verifiers — these
are forward references; verifier implementations land in Task 1.3."

git push -u origin feature/task-1.2-mietvertrag-schema
```

Report back the branch URL. Nils will open the PR and merge after CI passes.

## Acceptance gates (verify before reporting completion)

- `schemas/mietvertrag/schema.yaml` has exactly 5 entries in `fields` (kaltmiete, unit_ref, tenant_identity, mietbeginn, mietende) — no more, no less
- Schema validates against the Zod schema in `scripts/validate-schemas.ts`
- `domain_knowledge_ref: domain_knowledge/mietvertrag.md` present and correct
- `prompt_fragment_template` is multiline and contains per-field instructions
- `claim_kind: assertion` (matches domain knowledge default_claim_kind)
- Schema version bumped to today's date
- `npm run gen:schemas` regenerates all three output files in `schemas/mietvertrag/generated/`
- `npm run gen:schemas:check` exits 0 with 3 warnings (for the 3 deferred fields)
- `schemas.test.ts` passes
- `domain-knowledge.test.ts` passes
- `tsc --noEmit` silent
- Branch pushed to origin

## Constraints

- Do NOT add fields beyond the 5 launch slice. The other 3 in domain knowledge `fields_governed` are Phase 2.
- Do NOT modify `domain_knowledge/mietvertrag.md` (it's the source of truth for what fields exist conceptually).
- Do NOT modify `schemas/_meta_schema.yaml` (the meta-schema is locked).
- Do NOT modify `scripts/validate-schemas.ts` unless verifier forward references genuinely fail. If you must modify, explain why in the commit message.
- Do NOT touch the other four doc-type schemas (kuendigung, mieterhoehung, mietvertragsnachtrag, wohnungsuebergabeprotokoll). They have their own Phase 1+ tasks.
- Do NOT push directly to main. Use feature branch + PR workflow.
- Pipe git commands through `| cat`.
