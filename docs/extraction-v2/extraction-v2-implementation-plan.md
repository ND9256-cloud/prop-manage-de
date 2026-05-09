# Extraction v2 — Implementation Plan

**Status:** Pass 1 architecture locked. This document sequences implementation.
**Owner:** Nils.
**Scope:** Sequenced task list for the v2 launch slice (architecture §22). Each task ships via Discord `!claude !t1/!t2` and has explicit acceptance criteria.
**Date:** 2026-05-08.

---

## How to use this document

Each task is sized to ship in one Claude Code invocation. Tasks are ordered by dependency. **Do not skip ahead.** Tasks are tagged:

- **`t1`** — visual / scaffolding / test-only changes. Low review burden; ship and verify.
- **`t2`** — logic, data, schema, or pipeline changes. Requires review before deploy. Default to t2 if unsure.

Each task has:
- **Depends on:** what must ship before this task starts
- **Blocks:** which downstream tasks need this one
- **Acceptance criteria:** the testable definition of done
- **Files touched:** the surface area
- **Estimate:** rough Claude Code session time (S = <30min, M = 30-90min, L = 90min+)

**Discord task length limit:** ~1500 chars. Long tasks get pasted as a file path reference (e.g., "execute the task in `docs/tasks/task-12.md`"), with the actual brief in the repo.

**Verification rule:** Claude Code self-reports completion unreliably. After every task, you (or the next task) must run the actual code, not read completion reports.

**Architecture references:** every task cites the architecture section it implements. If a task seems to deviate from the architecture, the architecture wins; rewrite the task.

---

## The launch slice (architecture §22)

Reproduced here for grounding. Tasks in this document deliver this and only this:

1. v2 envelope table
2. Single-pass Sonnet extraction for **Mietvertrag** and **Wohnungsübergabeprotokoll**
3. Deterministic verifiers for critical fields in those two doc types
4. Claim emission for `kaltmiete`, `tenant_active`, `ownership_transfer`
5. Transactional closure-intent application
6. `rent_for_unit` resolver
7. Composer core + `rent_roll` module
8. Triage dual-read (v2 envelope + legacy `extracted_fields` with badge)
9. Fixture tests for Weber, Hofmann, Paul, Kuru, Everding cases
10. Discord regression alert from local/CI eval run

**Explicitly deferred from launch slice:**
- Gated public dashboard (architecture §13.3) → post-launch
- Full generator output suite (architecture §7.2 Phases 2-3) → as consumers exist
- Versicherungspolice resolver and Mietvertrag deep schema beyond launch fields → Phase 2
- 100-doc/type gold set → grows from triage corrections (active learning, §14)
- Non-Anthropic provider integration → when eval evidence justifies
- NKA → 60 days post-launch (architecture §17.2)

---

## Phase 0 — Foundations (Week 1, ~5 tasks)

Before any v2 work touches the pipeline, the foundation tables and types must exist. Phase 0 is pure infrastructure: schemas, migrations, type packages. Nothing customer-facing changes until Phase 1.

### Task 0.1 — `domain_knowledge/` directory and front-matter schema

**Depends on:** none
**Blocks:** 0.2, 1.1, 1.4
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- `domain_knowledge/` directory created at repo root
- `domain_knowledge/_schema.yaml` defines the front-matter schema (architecture §6.3): `doc_type`, `default_claim_kind`, `last_updated`, `legal_grounding[]`, `fields_governed[]`, `normalization_rules[]`, `gotchas[]`, `adversarial_fixtures_required[]`, `closes[]` (closure declarations from §5.5.2)
- `domain_knowledge/README.md` explains the consumer contract (architecture §6.4)
- Two stub files: `domain_knowledge/mietvertrag.md` and `domain_knowledge/wohnungsuebergabeprotokoll.md` with empty but valid front-matter
- CI test in `src/tests/domain-knowledge.test.ts` validates every `domain_knowledge/*.md` file's front-matter against `_schema.yaml`
- Test fails if any front-matter is invalid

**Files touched:** `domain_knowledge/`, `src/tests/domain-knowledge.test.ts`

**Notes:** The two domain knowledge files are populated in tasks 1.1 and 1.4. This task creates the empty structure and the validator only.

---

### Task 0.2 — `schemas/` directory and YAML meta-schema

**Depends on:** 0.1
**Blocks:** 0.3, 1.1, 1.4
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- `schemas/` directory at repo root
- `schemas/_meta_schema.yaml` defines the v2 schema YAML meta-schema (architecture §7.1): `doc_type`, `claim_kind`, `domain_knowledge_ref`, `fields[]` (each with `id`, `german_label`, `severity`, `type`, `enum_values?`, `normalization_rule_ref?`), `verifier_refs[]`, `prompt_fragment_template`
- Validator at `scripts/validate-schemas.ts` checks every `schemas/<doc_type>/schema.yaml` against the meta-schema
- CI test runs validator
- Two stub files: `schemas/mietvertrag/schema.yaml` and `schemas/wohnungsuebergabeprotokoll/schema.yaml` with `doc_type` field only

**Files touched:** `schemas/`, `scripts/validate-schemas.ts`, `src/tests/schemas.test.ts`

---

### Task 0.3 — Generator scaffolding (Phase 1 outputs only)

**Depends on:** 0.1, 0.2
**Blocks:** 1.1, 1.4
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `scripts/gen-schemas.ts` is a Node CLI: reads all `schemas/*/schema.yaml`, validates them, writes outputs to `schemas/<doc_type>/generated/`
- Phase 1 outputs only (architecture §7.2):
  1. `prompt_fragment.ts` — Deno-compatible TypeScript module with the prompt fragment for Step 8b. Header comment "DO NOT EDIT — generated from schema.yaml."
  2. `field_labels.json` — German UI labels for the triage overlay
  3. `envelope_validator.ts` — minimal Deno-compatible validator that rejects: value with no evidence, invalid absence_state, invalid enum value, missing severity
- CLI command: `pnpm gen:schemas`
- Pre-commit hook re-runs generator and stages output diffs
- CI test re-runs generator and fails if output diff is non-empty (catches manually-edited generated files)
- Outputs work in Deno runtime (explicit `.ts` import paths, no node-prefix imports)

**Files touched:** `scripts/gen-schemas.ts`, `package.json`, `.husky/pre-commit`, `.github/workflows/ci.yml`

**Notes:** Phase 2 (JSON Schema, Zod) and Phase 3 (TypeScript types, eval rubric, emitter stubs) deferred per architecture §7.2. Adding them later requires (a) a real consumer exists and (b) a CI test validates the consumer's contract.

---

### Task 0.4 — Migration: claim store tables

**Depends on:** none (parallel to 0.1-0.3)
**Blocks:** 0.5, 2.1, 3.1
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Migration file `supabase/migrations/<timestamp>_v2_claim_store.sql`:
  - Creates `warehouse.claims` table per architecture §4.2 schema (id, property_id, subject, predicate, value jsonb, claim_kind, valid_from, valid_to, source_document_id, source_extraction_run_id, source_field_path, confidence, evidence_id, source_type, human_actor_id, created_at, superseded_at, superseded_by_claim_id)
  - Creates `warehouse.claim_closures` table for executed closures (id, target_claim_id, valid_to, reason_claim_id, applied_at, applier_version)
  - Creates `warehouse.derivation_records` per architecture §4.6 with GIN index on `input_claim_ids`
  - All three tables annotated `@tenant-scoped-via property_id` in Prisma schema
  - Trigger blocks `UPDATE` except on the explicit immutability columns (superseded_at, superseded_by_claim_id, valid_to for closures)
  - Trigger blocks `DELETE` entirely (GoBD, append-only)
  - Indexes: `(property_id, subject, predicate, valid_from)` for resolver queries; GIN on `derivation_records.input_claim_ids`; **partial index `CREATE INDEX idx_claims_open ON warehouse.claims (property_id, subject, predicate) WHERE valid_to IS NULL`** for the most common applier query ("find currently-active claims") — required by architecture §5.5.7
- Prisma migration generated and committed
- CI tenant-isolation gate passes
- `ARCHITECTURE_STATE.md` updated

**Files touched:** `supabase/migrations/`, `prisma/schema.prisma`, `ARCHITECTURE_STATE.md`

**Notes:** This is the load-bearing table set. Verify the migration runs on a fresh database before considering the task done. The partial index on open claims is required by the closure-applier query patterns in architecture §5.5.7 — without it, every closure decision scans the full claim history.

---

### Task 0.5 — Migration: v2 extraction envelope table

**Depends on:** 0.4
**Blocks:** 1.2, 1.5
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Migration file `supabase/migrations/<timestamp>_v2_extraction_envelope.sql`:
  - Creates `warehouse.document_extractions_v2` table per architecture §3.1 + §3.3 envelope: id, source_document_id, doc_type, schema_version, prompt_version, model, extraction_run_id, fields jsonb (the envelope structure), lifecycle jsonb (the lifecycle sub-envelope §3.4), human_review_status, created_at
  - Annotated `@tenant-scoped-via source_document_id` in Prisma schema
  - Trigger blocks `UPDATE` except on `human_review_status` (which can change as a human reviews)
  - Trigger blocks `DELETE` entirely
  - Index on `(source_document_id, created_at DESC)` for "latest extraction for document" queries
- Prisma migration generated
- Legacy `document_extractions` table untouched
- CI passes

**Files touched:** `supabase/migrations/`, `prisma/schema.prisma`, `ARCHITECTURE_STATE.md`

---

## Phase 1 — Mietvertrag end-to-end (Week 2-3, ~8 tasks)

The first complete vertical slice. By end of Phase 1, a Mietvertrag enters the system, produces a v2 envelope, emits claims, and `rent_for_unit` returns a correct answer for KO132 / 1.OG (Lena Everding). The simplest of the five real cases — no Nachtrag, no supersession.

### Task 1.1 — Domain knowledge: `mietvertrag.md`

**Depends on:** 0.1
**Blocks:** 1.2, 1.5
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- `domain_knowledge/mietvertrag.md` populated per architecture §6.3 example
- Front-matter includes: `default_claim_kind: assertion`, `legal_grounding` (BGB §535, §557, §573), `fields_governed` (kaltmiete, nebenkostenvorauszahlung, kaution, mietbeginn, mietende, tenant_identity, landlord_identity, unit_ref), `normalization_rules` (kaltmiete_excludes_nebenkosten), `gotchas` (nachtrag_supersession with `real_failure_reference: weber_900_vs_1000`, indexmiete_vs_staffelmiete), `adversarial_fixtures_required` (draft_unsigned, with_nachtrag_attached, indexmiete_clause, staffelmiete_clause, gewerbemietvertrag_misclassified, with_handwritten_amendment)
- `closes: []` (Mietvertrag itself emits no closures)
- Free-form prose section explains nuances with citations
- CI front-matter validation passes

**Files touched:** `domain_knowledge/mietvertrag.md`

---

### Task 1.2 — Schema: `mietvertrag/schema.yaml` (launch fields only)

**Depends on:** 0.2, 0.3, 1.1
**Blocks:** 1.3
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `schemas/mietvertrag/schema.yaml` populated per meta-schema with launch-slice fields ONLY:
  - `kaltmiete` (severity: critical, type: money, normalization_rule_ref: kaltmiete_excludes_nebenkosten)
  - `unit_ref` (severity: critical, type: enum, enum_values: ["EG", "1.OG", "DG", ...])
  - `tenant_identity` (severity: critical, type: structured)
  - `mietbeginn` (severity: critical, type: date)
  - `mietende` (severity: important, type: date)
- `domain_knowledge_ref: domain_knowledge/mietvertrag.md`
- `prompt_fragment_template` field with the Sonnet instructions for these fields
- `verifier_refs` includes monetary-verbatim verifier (kaltmiete) and enum verifier (unit_ref) — these don't exist yet but are referenced; CI allows forward references during Phase 1
- `pnpm gen:schemas` produces `schemas/mietvertrag/generated/prompt_fragment.ts`, `field_labels.json`, `envelope_validator.ts`
- Generated outputs imported successfully in Deno test
- CI passes

**Files touched:** `schemas/mietvertrag/schema.yaml`, `schemas/mietvertrag/generated/`

**Notes:** Deferred fields (kaution, nebenkostenvorauszahlung, indexmiete clauses, staffelmiete schedule) are post-launch. Deep Mietvertrag schema is Phase 2.

---

### Task 1.3 — Deterministic verifiers (Mietvertrag launch fields)

**Depends on:** 1.2
**Blocks:** 1.5
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `supabase/functions/process-document/verifiers/` directory created
- `verifiers/monetary-verbatim.ts` — verifies extracted monetary value appears verbatim in OCR text (German number formatting `1.234,56` or `1234,56`). Returns `{ passes: bool, reason?: string }`.
- `verifiers/enum.ts` — verifies extracted value matches schema's enum_values
- `verifiers/date-format.ts` — verifies extracted date parses as valid German date; rejects comma-separated multi-value strings (the Haiku failure case)
- All verifiers are pure functions, model-agnostic, no LLM calls
- CI test scans `verifiers/` source for model identifiers (`sonnet`, `gpt`, `gemini`, etc.) — fails if any present (architecture §9.3)
- Unit tests per verifier with positive and negative cases (the Kuru "36270 Eosbacher Str." case in PLZ verifier is deferred to its own task in Phase 2)

**Files touched:** `supabase/functions/process-document/verifiers/`, tests under `src/tests/verifiers/`

---

### Task 1.4 — Domain knowledge: `wohnungsuebergabeprotokoll.md`

**Depends on:** 0.1
**Blocks:** 1.5, 2.4
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- `domain_knowledge/wohnungsuebergabeprotokoll.md` populated
- Front-matter includes: `default_claim_kind: event`, the four `uebergabe_typ` enum values (Einzug, Auszug, Eigentümerwechsel, unklar)
- `gotchas` includes `eigentuemerwechsel_does_not_invalidate_tenants` with `real_failure_reference: hofmann_unklar`
- `closes` matrix declares: `lease_terminated` event closes `kaltmiete`/`tenant_active`/`kaution`/`nebenkostenvorauszahlung` for matching unit; `ownership_transferred` closes `owner` claim for property but NOT tenant claims
- Free-form prose explains the three Übergabe scenarios and the Hofmann case
- CI passes

**Files touched:** `domain_knowledge/wohnungsuebergabeprotokoll.md`

---

### Task 1.5 — Step 8b refactor: wire v2 envelope path alongside Haiku Step 5

**Depends on:** 0.5, 1.2, 1.3, 1.4
**Blocks:** 1.6, 2.2
**Tag:** t2
**Estimate:** L

**RESCOPED from earlier draft.** The earlier version called for removing Haiku Step 5 outright. Developer review caught that this would break extraction overnight for the ~116 doc types without v2 schemas (Rechnung, Versicherungspolice, Grundbuchauszug, etc.) — Sonnet's base intelligence prompt produces summary/tags/entities but NOT doc-type-specific fields like vendor_name, amount, invoice_date. Rescoped per architecture §11.2: both extraction paths coexist during the migration window. Haiku Step 5 retirement moves to deferred Task D.9.

**Acceptance criteria:**
- `supabase/functions/process-document/index.ts` modified:
  - Add a registry lookup: `const HAS_V2_SCHEMA = (doc_type: string) => boolean`, populated from `schemas/index.ts` (generated)
  - Step 4 (classifyDocument) — unchanged, still produces doc_type
  - Step 5 (Haiku extractFields) — **continues to run for doc types without v2 schemas**. For doc types WITH v2 schemas, skip Step 5 (no Haiku call, no legacy `document_extractions` write)
  - Step 8b (Sonnet) — runs for every document, as today. For doc types WITH a v2 schema: read the schema's generated prompt fragment, use Anthropic tool use mode for structured output, run verifiers per `verifier_refs`, write result to `warehouse.document_extractions_v2`. For doc types WITHOUT a v2 schema: produce existing intelligence-layer output (summary, tags, entity_name, etc.) writing to `warehouse.document_intelligence` as today — no v2 envelope, no claim emission
  - Verifier failures (when v2 path runs) override `absence_state` to `contradicted` or `ambiguous`, downgrade `confidence`, set `validation_status`
  - Claim emission (Task 1.7) only fires on the v2 path
- Edge Function deployed: `supabase functions deploy process-document`
- Smoke test 1: process one Mietvertrag from KO132 (v2 path) — inspect resulting v2 envelope, confirm fields populate with evidence and lifecycle, confirm legacy `document_extractions` row was NOT written
- Smoke test 2: process one Rechnung (legacy path) — confirm legacy `document_extractions.extracted_fields` row IS written with vendor_name/amount/invoice_date as today, confirm v2 envelope was NOT written
- Smoke test 3: confirm BOTH doc types appear correctly in the inbox (legacy fields render via dual-read path in Task 1.6)
- ARCHITECTURE_STATE.md updated to reflect dual-path migration

**Files touched:** `supabase/functions/process-document/index.ts`, `ARCHITECTURE_STATE.md`

**Notes:** The single highest-risk task in the launch slice. Long brief — paste as `docs/tasks/task-1.5.md` in repo, reference from Discord. Verify all three smoke tests, not just the v2 path. The failure mode this task prevents is: ~116 doc types lose their extraction data overnight. If the smoke tests don't all pass, do NOT deploy.

---

### Task 1.6 — Triage overlay dual-read

**Depends on:** 1.5
**Blocks:** 4.1
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Triage overlay component (`src/components/warehouse/triage-overlay.tsx` or equivalent) modified per architecture §11.1:
  - Loads v2 envelope first (`warehouse.document_extractions_v2`, latest by source_document_id)
  - If v2 exists: render envelope format (raw_value, normalized_value, evidence quote with page reference, confidence badge, absence_state)
  - If v2 doesn't exist: render legacy `document_extractions.extracted_fields` with a "Legacy-Format" badge
- "Re-extract" button on legacy-format documents triggers a v2 extraction; result appears in triage for human review
- Tests: render with v2-only doc, render with legacy-only doc, render with both (v2 wins)
- No regression in existing triage behavior for legacy documents

**Files touched:** `src/components/warehouse/triage-overlay.tsx`, `src/lib/warehouse-actions.ts`, tests

---

### Task 1.7 — Mietvertrag claim emitter

**Depends on:** 0.4, 1.5
**Blocks:** 1.8, 2.5
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `src/lib/emitters/mietvertrag.ts` created
- Pure function: `(extraction: ExtractionEnvelope, document: Document) => EmissionResult` per architecture §4.4
- Emits per launch slice scope (architecture §22):
  - `kaltmiete` assertion claim (subject = `unit:<unit_ref>`, valid_from = effective_date, valid_to = null)
  - `tenant_active` assertion claim (subject = `unit:<unit_ref>`, value = tenant identity, valid_from = mietbeginn, valid_to = null)
- If `document_status` = "draft" or "cancelled": emit no claims
- Returns `EmissionResult { claims_to_insert, closure_intents: [] }` (Mietvertrag emits no closures)
- All emitted claims have `source_type: "document_extraction"`
- Pure: CI test asserts emitter file does not import any database client, claim store module, or async I/O primitive
- Unit tests: emit from Lena Everding Mietvertrag fixture, assert two claims produced with correct fields

**Files touched:** `src/lib/emitters/mietvertrag.ts`, `src/tests/emitters/mietvertrag.test.ts`

---

### Task 1.8 — Claim-store transaction applier

**Depends on:** 0.4, 1.7
**Blocks:** 1.9, 2.1
**Tag:** t2
**Estimate:** L

**Acceptance criteria:**
- `src/lib/claim-store/applier.ts` created per architecture §5.5
- Function: `applyEmission(emissionResult: EmissionResult, context: { property_id, extraction_run_id }) => Promise<{ inserted_claim_ids, applied_closure_ids, derivation_record_ids }>`
- Wraps insertion + closures in single Postgres transaction
- For each claim in `claims_to_insert`: insert into `warehouse.claims`, write `DerivationRecord` linking to `extraction_run_id` and rule_refs (from emitter version)
- For each `ClaimClosure`: query matching open or future claims based on the closure's declared `close_mode` (architecture §5.5.3):
  - `close_overlapping_only`: close claims where `valid_from <= close_at AND (valid_to IS NULL OR valid_to > close_at)`
  - `close_overlapping_and_future`: above OR `valid_from > close_at`
  - `close_overlapping_and_supersede_future`: same query as above, but write `superseded_by_claim_id` (not just `valid_to`) on future claims to preserve chain integrity
- Validate safety rules per architecture §5.5.4:
  - Only same property (`target_property_id = match.property_id`)
  - Only allowed predicate pairs (per closing matrix in domain knowledge front-matter)
  - Tenant identity match required where configured (use fuzzy-match function — see below)
  - No retroactive reach into already-superseded history
- Implement claim-aware blockers per architecture §5.5.5:
  - **Multi-tenant partial check** (Kündigung-triggered closures): query `SELECT * FROM warehouse.claims WHERE property_id = ? AND subject = ? AND predicate = 'tenant_active' AND valid_to IS NULL`. If active-tenant count exceeds extracted terminating-party count, OR if not all active tenants present in terminating-parties list (per fuzzy match), set `blocker_status: requires_review` and skip closure (still insert the new event claim)
  - **Eigentümerwechsel + vacant-possession check**: emit `occupancy_conflict` warning event, never auto-close tenant claims
  - **Mieterhöhung + Staffelmiete conflict check**: if open future-dated Staffelmiete claims exist for same unit, set `blocker_status: requires_review` on closure intent
- Implement fuzzy tenant-name matching per architecture §5.5.6: lowercase, strip Anrede ("Herr", "Frau", "Dr."), tokenize on whitespace+commas, check token-subset. Exact subset = match; partial overlap = flag for review; no overlap = no match. **No Levenshtein distance** (false positives on short German names).
- Apply closure: set `valid_to`, `superseded_at`, `superseded_by_claim_id` (per close_mode), write `claim_closures` audit row, write DerivationRecord
- Transaction rolls back on any validation failure
- Idempotent: re-running an EmissionResult produces no duplicate state
- Unit tests with fixtures:
  - Mietvertrag emission inserts 2 claims, 0 closures
  - Mieterhöhung emission (later task) inserts 1 claim, applies 1 closure with `close_overlapping_only`
  - Kündigung emission (later task) inserts 1 event claim, applies 4 closures with `close_overlapping_and_future`, correctly closes future Mieterhöhung claims
  - Eigentümerwechsel-Übergabeprotokoll inserts owner closure, NEVER closes tenant claims (Hofmann fixture)
  - Multi-tenant partial Kündigung sets blocker_status, doesn't close, surfaces in triage
  - Mieterhöhung mid-Staffelmiete sets blocker_status, doesn't close, surfaces in triage
  - Tenant fuzzy match: "Max Müller" matches "Müller, Max" matches "Max Heinrich Müller"; "Bauer" does NOT match "Baumer"
- CI passes

**Files touched:** `src/lib/claim-store/applier.ts`, `src/lib/claim-store/fuzzy-tenant-match.ts`, `src/tests/claim-store/applier.test.ts`, `src/tests/claim-store/fuzzy-tenant-match.test.ts`

**Notes:** Long brief — paste as `docs/tasks/task-1.8.md` in repo. The closing matrix and `close_mode` per rule are read from domain knowledge front-matter, not hard-coded. Three close_modes correspond to three SQL query patterns; tested per close_mode. Fuzzy matching is unit-tested with German-name fixtures (Müller variants, Schmidt vs Schmitt, Anrede stripping).

---

### Task 1.9 — Wire Step 8b → emitter → applier

**Depends on:** 1.5, 1.7, 1.8
**Blocks:** 1.10
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- After Step 8b writes the v2 envelope, the pipeline:
  1. Loads the appropriate emitter for the doc_type (registry pattern: `EMITTERS[doc_type]`)
  2. Calls emitter to produce `EmissionResult`
  3. Calls applier to insert claims and apply closures
  4. Writes a final pipeline log entry with claim_ids and closure_ids
- If no emitter exists for the doc_type: log a "no_emitter_for_doc_type" warning, skip claim emission, do not fail the pipeline
- Smoke test: process Lena Everding Mietvertrag end-to-end, confirm two claims appear in `warehouse.claims` with correct subject/predicate/value
- ARCHITECTURE_STATE.md updated

**Files touched:** `supabase/functions/process-document/index.ts`, `src/lib/emitters/index.ts` (registry), `ARCHITECTURE_STATE.md`

---

### Task 1.10 — `rent_for_unit` resolver

**Depends on:** 1.9
**Blocks:** 1.11, 4.2
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `src/lib/resolvers/rent-for-unit.ts` created per architecture §5.2
- Function: `rentForUnit({ property_id, unit_ref, as_of_date }) => ResolvedFact<Money>`
- Algorithm exactly per architecture §5.2:
  - Query claims where property_id, subject, predicate=kaltmiete, claim_kind=assertion, valid_from <= as_of_date, (valid_to IS NULL OR valid_to > as_of_date)
  - Zero / one / multiple claim handling per spec
  - Returns `ResolvedFact { value, confidence, status, provenance, explanation, resolver: { name, version } }`
- Pure: CI test asserts resolver does not import LLM client, prompt module, or extraction module
- Writes a DerivationRecord per resolution call (output_type: "resolved_fact")
- Unit test: Lena Everding case (KO132 1.OG, €650, single claim) returns €650 with `single_active_claim`

**Files touched:** `src/lib/resolvers/rent-for-unit.ts`, `src/tests/resolvers/rent-for-unit.test.ts`

---

### Task 1.11 — Lena Everding fixture test (Phase 1 verification)

**Depends on:** 1.10
**Blocks:** Phase 2
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- Fixture: Lena Everding Mietvertrag PDF saved at `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/source.pdf`
- Ground truth at `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/expected.json` with expected envelope
- Test runs end-to-end:
  - Process the PDF through Step 8b
  - Assert v2 envelope matches expected.json on critical fields
  - Assert claim emission produces expected claims
  - Assert `rentForUnit({ property_id: KO132, unit_ref: "1.OG" })` returns €650
- Test in CI suite

**Files touched:** `tests/fixtures/extraction/mietvertrag/everding-ko132-1og/`, `src/tests/integration/everding-end-to-end.test.ts`

**Notes:** This is the Phase 1 gate. If this test passes, Phase 1 is done. If it doesn't, no further phases proceed until it does.

---

## Phase 2 — Supersession + Übergabeprotokoll (Week 3-4, ~6 tasks)

The harder cases. Mieterhöhung produces closures; Übergabeprotokoll produces events. By end of Phase 2, all 5 real cases (Weber, Paul, Kuru, Hofmann, Everding) resolve correctly.

### Task 2.1 — Mieterhöhung schema, domain knowledge, emitter

**Depends on:** 0.3, 1.8
**Blocks:** 2.1b, 2.2, 2.6
**Tag:** t2
**Estimate:** L

**Acceptance criteria:**
- `domain_knowledge/mieterhoehung.md` with front-matter per schemas document Section 3:
  - `default_claim_kind: assertion`
  - Gotchas: `scope_narrowed_to_rent_change`, `kappungsgrenze_15_percent`, `tenant_consent_requirement`, `effective_date_vs_notice_date`, `future_dated_increase_no_immediate_closure`, `staffelmiete_mid_schedule_amendment`, `closure_prerequisites`
  - `closes` matrix entry with `close_mode: close_overlapping_only` and the prerequisite-gated `when` clause from the schema (verifies signature, effective_date, unit_ref, document_status not draft, no Staffelmiete conflict)
- `schemas/mieterhoehung/schema.yaml` with launch fields: `nachtrag_typ`, `rechtsgrundlage`, `new_kaltmiete`, `previous_kaltmiete`, `effective_date`, `notice_date`, `unit_ref`, `tenant_identity`, `landlord_signature_present`, `tenant_signature_present`, plus the §558/§559/Index-specific structured fields
- `pnpm gen:schemas` produces generated outputs
- `src/lib/emitters/mieterhoehung.ts`: pure function returning EmissionResult with:
  - One new kaltmiete assertion claim (subject = `unit:<unit_ref>`, valid_from = effective_date)
  - One ClaimClosure with `close_mode: close_overlapping_only`, target_predicate = kaltmiete, target_subject matches new claim, valid_to = effective_date - 1 day
  - Closure intent's `blocker_status` is set to `requires_review` if the emitter's claim-aware check detects open future-dated kaltmiete claims for the unit (Staffelmiete conflict — applier handles; emitter sets the flag)
  - If prerequisites fail (missing signature, draft status, etc.), no closure intent emitted (only the new claim, with reduced confidence)
- Unit tests: Paul Mieterhöhung produces correct claim + closure, Mieterhöhung-on-draft produces no closure, Mieterhöhung mid-Staffelmiete produces closure with `requires_review` blocker

**Files touched:** `domain_knowledge/mieterhoehung.md`, `schemas/mieterhoehung/`, `src/lib/emitters/mieterhoehung.ts`, tests

---

### Task 2.1b — Mietvertragsnachtrag schema, domain knowledge, emitter

**Depends on:** 2.1
**Blocks:** 2.2 (no — parallel to 2.2)
**Tag:** t2
**Estimate:** M

This is the new doc_type added per developer feedback. Splits non-rent amendments out of Mieterhöhung to prevent silent data loss. The emitter delegates rent-change scope to the Mieterhöhung emitter.

**Acceptance criteria:**
- `domain_knowledge/mietvertragsnachtrag.md` with front-matter per schemas document Section 4:
  - `default_claim_kind: reference` (rent_change scope upgrades to assertion via delegation)
  - Gotchas: `scope_classification_accuracy_critical`, `multi_scope_documents`, `rent_change_delegates_to_mieterhoehung`, `non_rent_scopes_emit_reference_claims_only`, `misclassified_as_mieterhoehung`
  - `closes` matrix entry: only fires when `nachtrag_scope == "rent_change"`, delegates to mieterhoehung's closing rule
- `schemas/mietvertragsnachtrag/schema.yaml` with the `nachtrag_scope` enum and per-scope structured payloads (rent_change_payload, tenant_identity_change_payload, deposit_change_payload, ancillary_cost_change_payload, term_change_payload, usage_right_change_payload, other_change_descriptor)
- `pnpm gen:schemas` produces generated outputs; new doc_type appears in `schemas/index.ts` registry (auto-flips legacy → v2 path for this doc type per Task 1.5)
- `src/lib/emitters/mietvertragsnachtrag.ts`: pure function:
  - If `nachtrag_scope == "rent_change"`: build a Mieterhöhung-shaped extraction from `rent_change_payload` + common fields, delegate to `mieterhoehungEmitter()`, return its result
  - Otherwise: emit one reference-kind claim with `predicate: "amendment_present"`, `value: { scope, ...payload }`, `status: "unsupported_requires_review"`. No closure intents.
- Step 4 classifier prompt updated to distinguish `mieterhoehung` from `mietvertragsnachtrag` based on WHAT changes, not document title
- Unit tests:
  - Pet-clause Nachtrag (`usage_right_change`) → one reference claim, no closures
  - Tenant identity change Nachtrag → one reference claim, no closures (tenant_active claims stay open)
  - Bilateral rent-change Nachtrag (`rent_change`) → delegates correctly, produces same EmissionResult shape as a Mieterhöhung
  - Misclassification fixture: pet-clause Nachtrag misclassified as Mieterhöhung at Step 4 → mieterhoehung emitter rejects extraction (new_kaltmiete absent), surfaces in triage with classification-error flag

**Files touched:** `domain_knowledge/mietvertragsnachtrag.md`, `schemas/mietvertragsnachtrag/`, `src/lib/emitters/mietvertragsnachtrag.ts`, `supabase/functions/process-document/classification-prompt.ts`, tests

**Notes:** Adds ~3-4 hours of work above the original Mieterhöhung scope per developer estimate. The split prevents silent data loss for the ~15-20% of Nachträge that change non-rent terms. Critical: the Step 4 classifier must distinguish the two doc_types reliably — adversarial fixture `nachtrag_misclassified_as_mieterhoehung_at_step4` is the gate.

---

### Task 2.2 — End-to-end test: Paul case (supersession)

**Depends on:** 2.1
**Blocks:** 2.3
**Tag:** t1
**Estimate:** M

**Acceptance criteria:**
- Fixtures: Paul original Mietvertrag (€525) + Paul Mieterhöhung (€575) saved at `tests/fixtures/extraction/`
- Ground truth files for both
- Test runs in order:
  1. Process Mietvertrag → expect 1 active kaltmiete claim of €525
  2. Process Mieterhöhung → expect 1 new active kaltmiete claim of €575, previous claim closed
  3. `rentForUnit({ property_id: KO132, unit_ref: "EG", as_of_date: today })` returns €575 with single_active_claim
  4. `rentForUnit({ property_id: KO132, unit_ref: "EG", as_of_date: 2023-01-01 })` returns €525 (historical query works)
- Same test for Kuru case (€440 → €470) and Weber case (€900 → €1,000)

**Files touched:** `tests/fixtures/extraction/`, `src/tests/integration/supersession-cases.test.ts`

**Notes:** This is the Weber-bug-resolution gate. If this test passes, the architectural fix for the original bug is verified.

---

### Task 2.3 — Übergabeprotokoll schema with `uebergabe_typ` dispatch

**Depends on:** 1.4, 0.3
**Blocks:** 2.4
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `schemas/wohnungsuebergabeprotokoll/schema.yaml` with critical-severity field `uebergabe_typ` (enum: Einzug, Auszug, Eigentümerwechsel, unklar)
- Other launch fields: `inspection_date`, parties (Käufer/Verkäufer for Eigentümerwechsel; Mieter for Einzug/Auszug)
- Generated prompt fragment instructs Sonnet to determine `uebergabe_typ` from doc content (Käufer/Verkäufer → Eigentümerwechsel; Mieter X moves in → Einzug)
- Generated envelope validator rejects extractions with `uebergabe_typ` outside the enum

**Files touched:** `schemas/wohnungsuebergabeprotokoll/`

---

### Task 2.4 — Übergabeprotokoll emitter (dispatch on `uebergabe_typ`)

**Depends on:** 2.3, 1.7
**Blocks:** 2.5
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `src/lib/emitters/wohnungsuebergabeprotokoll.ts` per architecture §4.5:
  - `uebergabe_typ = "Einzug"` → emit `tenant_active` event claim (no closures); valid_from = inspection_date
  - `uebergabe_typ = "Auszug"` → emit `lease_terminated` event claim AND closure intents for kaltmiete, tenant_active, kaution, nebenkostenvorauszahlung claims for the matching unit
  - `uebergabe_typ = "Eigentümerwechsel"` → emit new `owner` claim AND closure intent for previous owner claim. **No tenant-claim closures.** This is the Hofmann fix.
  - `uebergabe_typ = "unklar"` → emit no claims, set `requires_human_review` on the extraction
- Unit tests: each `uebergabe_typ` value produces correct EmissionResult

**Files touched:** `src/lib/emitters/wohnungsuebergabeprotokoll.ts`, tests

---

### Task 2.5 — Hofmann fixture test (the original bug)

**Depends on:** 2.4
**Blocks:** Phase 3
**Tag:** t1
**Estimate:** M

**Acceptance criteria:**
- Fixtures: Dr. Hofmann Mietvertrag + November 2025 Eigentümerwechsel-Übergabeprotokoll saved
- Test runs in order:
  1. Process Mietvertrag → expect 1 active kaltmiete claim of €900 for HHS55 DG, 1 active tenant_active claim
  2. Process Eigentümerwechsel-Übergabeprotokoll → expect 1 new owner claim, previous owner claim closed; **kaltmiete claim still active; tenant_active claim still active**
  3. `rentForUnit({ property_id: HHS55, unit_ref: "DG" })` returns €900 with single_active_claim
- Negative test: process an Auszug-Übergabeprotokoll for the same unit → kaltmiete claim closed, rentForUnit returns null

**Files touched:** `tests/fixtures/`, `src/tests/integration/hofmann-case.test.ts`

**Notes:** Phase 2 gate. If this test passes, the second of the two original bugs is structurally fixed.

---

### Task 2.6 — PLZ verifier (the Kuru hallucinated address case)

**Depends on:** 1.3
**Blocks:** 4.3 (deferred-but-tracked)
**Tag:** t2
**Estimate:** S

**Acceptance criteria:**
- `verifiers/plz.ts`: validates German postal codes against a static lookup
- Static lookup file: `data/plz-bundesland.json` with all 5-digit German PLZs and their Bundesland
- Verifier returns `passes: false` if PLZ not found OR if PLZ doesn't match the expected Bundesland for the address
- Used in extraction post-processing for any field with type `address`
- Unit test: Kuru "36270 Eosbacher Str." case fails verification (36270 doesn't exist near Schauenburg)

**Files touched:** `verifiers/plz.ts`, `data/plz-bundesland.json`, tests

**Notes:** Address fields aren't critical-severity in launch slice, but this verifier is cheap to add and prevents the recurrence of the Kuru bug class.

---

## Phase 3 — Composer + brain replacement (Week 4-5, ~5 tasks)

Replaces the legacy brain with composer + presenter. By end of Phase 3, the dashboard rent roll renders from resolved facts, not from `document_intelligence`.

### Task 3.1 — Composer core: `PropertySnapshot` shape

**Depends on:** 0.4, 1.10
**Blocks:** 3.2
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `src/lib/composer/property-snapshot.ts` per architecture §5.4.3
- Type: `PropertySnapshot { core, modules, metadata }` with `modules` containing optional `rent_roll`, `ownership`, `insurance`, `costs`, `handover`
- `composePropertySnapshot({ property_id, modules: ["rent_roll"] }) => Promise<PropertySnapshot>`
- Composer is pure TypeScript, no LLM calls
- For each requested module, calls the appropriate resolver(s)
- Metadata includes `composed_at`, `claim_snapshot_version` (hash over the relevant claim IDs), `resolver_versions`, `completeness` per module, `warnings`
- Writes a DerivationRecord (output_type: "property_snapshot")
- CI test asserts composer file does not import LLM client or prompt module

**Files touched:** `src/lib/composer/property-snapshot.ts`, tests

---

### Task 3.2 — `RentRollSnapshot` module

**Depends on:** 3.1, 1.10
**Blocks:** 3.3
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- `src/lib/composer/modules/rent-roll.ts`
- For a property, enumerates units (read from existing Property/Unit tables), calls `rentForUnit` for each
- Returns `RentRollSnapshot` with array of `{ unit_ref, current_kaltmiete: ResolvedFact<Money>, tenant_active: ResolvedFact<Tenant>, ... }`
- Each `ResolvedFact<T>` carries value, confidence, status, provenance (claim ids, document ids), explanation
- Unit test: KO132 returns 3-row rent roll; HHS55 returns 2-row rent roll; values match the 5 real cases

**Files touched:** `src/lib/composer/modules/rent-roll.ts`, tests

---

### Task 3.3 — Dashboard rent roll renders from composer

**Depends on:** 3.2
**Blocks:** 3.4
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Dashboard rent roll component refactored to call `composePropertySnapshot({ property_id, modules: ["rent_roll"] })` instead of reading `document_intelligence`
- For each row, render value + click-through provenance modal showing source documents and quotes
- "Legacy" tag if any cell falls back to legacy data (during transition)
- Loading state while composer runs
- Existing UI tests pass; new test: dashboard for KO132 shows Lena Everding €650 with provenance modal showing the source Mietvertrag

**Files touched:** dashboard components, tests

**Notes:** First customer-facing surface that consumes resolver output. Significant moment.

---

### Task 3.4 — Legacy brain shadow mode

**Depends on:** 3.3
**Blocks:** 3.5
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Legacy `scripts/generate-brain.js` continues to run on schedule, writing to `document_intelligence` (or a "legacy_brain_output" table)
- A new comparison job runs nightly: for each property, calls composer, calls legacy brain, diffs the rent roll values
- Divergences logged to a `brain_shadow_comparison` table with property_id, divergent_field, composer_value, brain_value, run_at
- Discord alert if divergence count > N (TBD threshold)
- Customer-facing surfaces continue to read composer only — legacy brain output is not displayed
- After 30 days of stable comparison, the legacy brain can be deleted (separate task, post-launch)

**Files touched:** `scripts/brain-shadow-comparison.ts`, comparison table migration, Discord webhook

---

### Task 3.5 — Presenter (LLM, renders only)

**Depends on:** 3.2
**Blocks:** 4.4 (chat, deferred-but-tracked)
**Tag:** t2
**Estimate:** L

**Acceptance criteria:**
- `src/lib/presenter/render.ts` per architecture §5.4.6
- Function: `renderResolvedFact(fact: ResolvedFact<T>) => Promise<string>` — produces German prose explaining the fact and its provenance
- Function: `renderPropertySnapshot(snapshot: PropertySnapshot) => Promise<string>` — produces a German property summary
- Uses Anthropic Sonnet, prompt explicitly forbids: reading OCR, reading claims directly, resolving conflicts, choosing between competing values, inventing values not in input
- CI-assisted check: presenter source file does not import `@/lib/extractions/`, `@/lib/claim-store/`, or any direct DB client
- Adversarial fixture set: prompts presenter with PropertySnapshots designed to tempt it into invention; test asserts presenter refuses or only uses provided values
- Unit test: render Lena Everding rent fact produces German prose mentioning €650, the source Mietvertrag, and the effective date

**Files touched:** `src/lib/presenter/render.ts`, adversarial fixtures, tests

**Notes:** Chat (`/api/properties/[id]/chat` with the intent parser + AnswerMode trichotomy) is a Phase 4 task — out of launch slice but tracked. Presenter is built first; chat is a wrapper around it later.

---

## Phase 4 — Eval, alerts, launch readiness (Week 5-6, ~5 tasks)

Eval harness, regression alerts, gold set, launch checklist.

### Task 4.1 — Eval harness scaffolding

**Depends on:** 1.11, 2.5
**Blocks:** 4.2
**Tag:** t2
**Estimate:** L

**Acceptance criteria:**
- `scripts/eval/run.ts` — Node CLI that reads gold-set fixtures, runs each through the pipeline, compares to ground truth
- Per-field metrics: exact match (raw_value), normalized match (normalized_value), evidence correctness (does quote justify value), absence-state correctness, severity-weighted error rate
- Output: JSON file at `eval/results/<timestamp>.json` with per-doc-type, per-field, per-model breakdown
- At launch, runs against Sonnet only (Opus added in Task 4.5)
- Fixture loader respects gold/dev/test split (architecture §13.2)

**Files touched:** `scripts/eval/`, `eval/results/`, gold-set fixture loader

---

### Task 4.2 — Discord regression alert

**Depends on:** 4.1
**Blocks:** 4.3
**Tag:** t2
**Estimate:** S

**Acceptance criteria:**
- CI workflow runs `scripts/eval/run.ts` on every PR
- Stores result, compares to previous run on main
- If severity-weighted score drops > 2pp on any doc type or critical-field exact-match drops > 2pp on any field: posts to Discord with details
- Alert includes: which doc type, which field, regression magnitude, link to comparison artifact
- Manual approval required to merge regression-causing PRs (GitHub branch protection)

**Files touched:** `.github/workflows/ci.yml`, Discord webhook, branch protection rules

---

### Task 4.3 — Initial gold set (the 5 real cases + adversarial fixtures)

**Depends on:** 1.11, 2.2, 2.5
**Blocks:** 4.4
**Tag:** t1
**Estimate:** L (mostly Nils labeling time)

**Acceptance criteria:**
- 5 real-case fixtures (Lena, Paul both, Kuru both, Weber both, Hofmann) with full ground-truth envelopes — these already exist from Phase 1/2 tasks; this task formalizes them into the gold set
- 5-10 adversarial Mietvertrag fixtures (synthetic, generated by Opus from architecture §15.2 list) covering: draft_unsigned, with_nachtrag_attached, indexmiete_clause, staffelmiete_clause, gewerbemietvertrag_misclassified
- 3-5 adversarial Übergabeprotokoll fixtures: einzug_explicit, auszug_explicit, eigentuemerwechsel_explicit, ambiguous_unklar
- Ground truth labeled by Nils (~5-8 hours of focused work)
- CI test enumerates `adversarial_fixtures_required` in domain knowledge and asserts each tag has at least one fixture in the gold set
- Gold set committed to repo at `eval/gold-set/`

**Files touched:** `eval/gold-set/`, `tests/fixtures/`

**Notes:** The labeling work in this task is the most expensive non-Claude-Code time in the entire plan. Block ~8 hours over 2 days.

---

### Task 4.4 — ARCHITECTURE_STATE.md and launch checklist

**Depends on:** 4.3
**Blocks:** Launch
**Tag:** t1
**Estimate:** S

**Acceptance criteria:**
- `ARCHITECTURE_STATE.md` updated to reflect v2 launch state: composer is canonical, legacy brain in shadow mode, claim store live, eval running nightly, gated dashboard deferred
- `docs/launch-checklist.md` produced with go/no-go criteria:
  - All Phase 1, 2, 3, 4 fixture tests pass
  - Eval severity-weighted score ≥ 90% on critical fields for both Mietvertrag and Übergabeprotokoll
  - 30-day stability of composer vs. legacy brain shadow comparison (this is the gate that delays formal "launch" by 30 days post code-complete)
  - Discord regression alerts working
  - First customer's documents test-uploaded and processed without error
- `docs/launch-checklist.md` becomes the gate for the customer-facing announcement

**Files touched:** `ARCHITECTURE_STATE.md`, `docs/launch-checklist.md`

---

### Task 4.5 — Opus-as-critic in eval (model diversity)

**Depends on:** 4.1
**Blocks:** none (post-launch enhancement, but desired before formal launch)
**Tag:** t2
**Estimate:** M

**Acceptance criteria:**
- Eval harness runs each fixture through Sonnet AND Opus
- Per-doc-type, per-field, harness reports which model wins on severity-weighted score
- Three-role labeling (architecture §12) wired: extractor = Sonnet, critic = Opus, human adjudicator = Nils
- Triage UI surfaces critic disagreements as additional flags
- Disagreement taxonomy tracked: both correct, extractor wrong/critic right, both wrong (full-overturn)

**Files touched:** `scripts/eval/run.ts`, triage UI, disagreement metrics dashboard

**Notes:** Multi-provider routing config exists from Task 0.3 but only routes to Sonnet at launch. GPT-5 / non-Anthropic providers added when eval evidence justifies, per architecture §9.2.

---

## Out of launch slice (deferred, tracked)

These tasks are NOT part of the launch slice. They are post-launch work. Listed here so they don't get forgotten and so dependencies are visible.

### Deferred Task D.1 — Chat with intent parser + AnswerMode

Architecture §5.4.5. Refactor `/api/properties/[id]/chat` to use intent parser → resolver → presenter pattern with three answer modes (`authoritative_resolved_fact`, `document_search_summary`, `not_supported`). Captures unsupported questions to a roadmap queue.

**Trigger:** post-launch, when chat usage data shows what questions customers actually ask.

### Deferred Task D.2 — Gated public dashboard

Architecture §13.3. NextAuth-gated quality dashboard with per-doc-type accuracy trends, methodology, gold-set composition. Public migration at month 4-6 contingent on gold-set diversity.

**Trigger:** when gold set crosses 100 docs/type and prospect conversations need it.

### Deferred Task D.3 — Versicherungspolice deep schema

Architecture Pass 2 deep schema. Active/expired/renewal-chain handling. Insurance resolver.

**Trigger:** before second customer onboards; or when insurance-related triage volume justifies.

### Deferred Task D.4 — NKA implementation (60-day post-launch hard commitment)

Architecture §17.2. Requires:
- Claim-aware derivation primitive (architecture §17.1)
- DerivationRecord dependency tracking (already built, Task 0.4)
- NKA schema and emitter
- Per-tenant balance resolver
- Re-emission strategy when historical claims change

**Trigger:** within 60 days of v2 first-customer launch. Hard commitment per architecture §17.2.

### Deferred Task D.5 — JSON Schema, Zod, TypeScript types in generator

Architecture §7.2 Phases 2-3. Add as their consumers exist:
- JSON Schema when the envelope validator needs full schema validation (currently Phase 1's minimal validator suffices)
- Zod when first piece of code wants typed extraction output
- TypeScript types when codepaths exceed informal type usage
- Eval rubric generation when eval harness is ready to consume it
- Claim emitter signature stubs when adding 5+ new doc types

**Trigger:** consumer-driven, per architecture §7.2 discipline.

### Deferred Task D.6 — Active learning hook

Architecture §14.1. Triage corrections automatically tag documents as gold-set candidates. Weekly labeling cycle pulls highest-priority candidates first.

**Trigger:** when triage volume produces enough corrections per week to warrant the loop (~10+ corrections/week).

### Deferred Task D.7 — GPT-5 / non-Anthropic provider integration

Architecture §9.2. When eval data shows a doc type where Anthropic models plateau below threshold AND a different family is hypothesized to handle it better.

**Trigger:** evidence-driven, not pre-emptive.

### Deferred Task D.8 — Delete legacy brain, delete legacy `document_extractions`, delete dual-read

After 30 days of stable shadow comparison post-launch, the legacy brain can be deleted (`scripts/generate-brain.js` removed, `document_intelligence` consumption removed from any remaining surfaces). After all 411 legacy `document_extractions` rows have been re-extracted on demand or deemed not-of-interest (12+ months), the legacy table and the dual-read code path can be removed.

**Trigger:** time-based + verification.

### Deferred Task D.9 — Retire Haiku Step 5 once all doc types have v2 schemas

The architecture's target state (per architecture §11) is single-pass Sonnet for extraction. The transition window keeps Haiku Step 5 alive for doc types without v2 schemas. This task retires Haiku Step 5 once all production doc types have been migrated to v2 schemas.

**Acceptance criteria (when ready to execute):**
- Audit `schemas/` directory: confirm all production doc types have v2 schemas (registry coverage = 100%)
- Process recent production traffic: confirm zero documents in the last 30 days routed through the legacy Haiku path (every classified doc_type has a v2 schema)
- Remove Step 5 (Haiku) call from `supabase/functions/process-document/index.ts`
- Remove `extractFields` Haiku prompt builders for all doc types
- Migrate `warehouse.document_extractions` to read-only (or archive) — historical legacy extractions remain queryable for GoBD audit
- Remove the `HAS_V2_SCHEMA` registry check (no longer needed; all doc types route to v2)
- Remove the dual-read fallback in triage overlay (Task 1.6) — v2 envelope is now the only source
- Update architecture document §11 with steady-state language; remove transition-period discussion
- ARCHITECTURE_STATE.md updated to reflect single-pass Sonnet target achieved

**Trigger:** schema coverage + production traffic verification.
**Estimated horizon:** 6-12 months post-launch, depending on customer pressure to migrate specific doc types.
**Coupled with D.8:** legacy `document_extractions` table cleanup and Haiku Step 5 retirement happen in the same migration window.

---

## Sequencing summary

| Week | Phase | Key gates |
|------|-------|-----------|
| 1 | Phase 0 — Foundations | Domain knowledge dirs exist, generator scaffolded, claim store + envelope tables migrated |
| 2 | Phase 1 (1.1-1.6) | Mietvertrag schema, verifiers, Step 8b refactor, triage dual-read |
| 3 | Phase 1 (1.7-1.11) + Phase 2 start | Emitter + applier + resolver, Lena Everding fixture passes; Mieterhöhung domain knowledge |
| 3-4 | Phase 2 (2.1-2.6) | Paul/Kuru/Weber tests pass, Übergabeprotokoll dispatch, Hofmann test passes |
| 4-5 | Phase 3 | Composer + RentRollSnapshot, dashboard refactored, presenter built, legacy brain in shadow mode |
| 5-6 | Phase 4 | Eval harness, Discord regression alert, gold set labeled, launch checklist |
| 6+ | 30-day shadow comparison | Legacy brain deletion gate; deferred tasks unblock |
| Post-launch +60 days | Deferred D.4 (NKA) | Hard commitment per architecture §17.2 |

**Total tasks in launch slice:** 29 (Phase 0: 5, Phase 1: 11, Phase 2: 7 including 2.1b, Phase 3: 5, Phase 4: 5; with one in P3 already counted in P2 by dependency). The Mietvertragsnachtrag split (Task 2.1b) was added per developer feedback and adds ~3-4 hours of work to prevent silent data loss for non-rent Nachträge.

**Blocking critical path:**
0.4 → 0.5 → 1.5 → 1.7 → 1.8 → 1.9 → 1.10 → 1.11 → 2.1 → 2.4 → 2.5 → 3.1 → 3.2 → 3.3 → 3.4 → 4.1 → 4.2 → 4.3 → 4.4

(Task 2.1b runs in parallel to 2.2-2.5 since it only depends on 2.1 — does not extend the critical path.)

That's 19 tasks on the critical path. The other 10 can run in parallel where dependencies allow (most of Phase 0, the verifier tasks, the schema tasks, Task 2.1b).

**Realistic single-builder pace:** 1-2 t2 tasks per day OR 3-4 t1 tasks per day. Critical path is ~3-4 weeks of focused work plus ~1-2 weeks of labeling, integration debugging, and shadow-comparison observation = 4-6 weeks total, matching architecture §1.1 expectations.

---

## Discipline rules during implementation

1. **Verify by running, not by reading completion reports.** Claude Code's "I have completed Task X" is unreliable. Every task ends with: did the test pass? Did the smoke test produce expected output? Did the migration apply on a fresh DB?
2. **Tier 0 gates are non-negotiable.** Multi-tenant CI gate, migration discipline, ARCHITECTURE_STATE.md gate, GoBD soft-delete, backup-restore drill — these continue to apply to every PR. No bypass.
3. **One task per Discord invocation.** Don't combine "build the schema and the emitter and the test" into one task. They are separate.
4. **Long tasks live in the repo.** Briefs longer than ~1500 chars get pasted as `docs/tasks/task-X.Y.md`, referenced from Discord with the path.
5. **ARCHITECTURE_STATE.md updated on every t2 task touching pipeline files.** This is a Tier 0 gate; PRs without it fail CI.
6. **No customer-facing surface displays current facts from both legacy and v2 sources** (architecture §5.4.9). Composer is canonical from Task 3.3 onwards; legacy brain runs in shadow only.
7. **The five real cases are the truth.** If any test among the Lena/Paul/Kuru/Weber/Hofmann fixtures fails, the architecture isn't working. Stop and investigate before proceeding.

---

## What this document is not

- A Gantt chart with calendar dates
- A risk register
- A staffing plan (solo builder)
- A budget breakdown
- A formal project charter

It is a sequenced list of executable tasks that ship the v2 launch slice. When a task is done, check it off and move to the next.
