# ARCHITECTURE_STATE.md — Living State Document

_Last updated: May 3, 2026 — Full rewrite after Tier 0 completion._
_If this file doesn't list it, assume it doesn't exist._
_Read this before writing any code or sending any task to Claude Code._

---

## Product

**PropManager DE** — German property management document warehouse SaaS.
GoBD-compliant document intelligence: automated intake, extraction, classification, and per-property "brain" surfacing structured insights.

**Live URL:** https://prop-manage-de.vercel.app
**Repo:** github.com/ND9256-cloud/prop-manage-de
**Stack:** Next.js App Router, Tailwind v4, shadcn/ui (new-york, neutral), Prisma, Supabase, NextAuth v5, Vercel
**Infrastructure:** Mac Mini M4 (Tailscale), Discord control plane, pg_cron auto-processing

---

## Properties (Live Data)

| Property | Short Code | Address | Units | Tenants | Rent/Month |
|----------|-----------|---------|-------|---------|------------|
| Schauenburg | KO132 | Korbacher Straße 132 | 3 (EG, 1.OG, DG) | Julija Paul €575, Lena Everding €650, Saniye Kuru €470 | €1,695 |
| Kassel | HHS55 | Heinrich-Heine-Straße 55/55a | 2 (1.OG, DG) | Weber GmbH €1,000, Familie Hofmann €900 | €1,900 |

**Total:** 5 units, €3,595/month, 100% Vermietungsquote
**Org ID:** 310131df-d6ed-4007-83c2-ac69a7e9df42

---

## Database Schema

### warehouse schema (Supabase, 26 tracked migrations)
- **warehouse.documents** — 634 rows (626 applied, 6 failed, 2 quarantined). Has cost_class, retention_until, deleted_at, deleted_by columns. Hard DELETE blocked by Postgres trigger (GoBD).
- **warehouse.document_extractions** — ~411 rows (is_current=true per doc, JSONB extracted_fields). Vendor 97%, amount 98% fill rate on cost docs.
- **warehouse.document_intelligence** — 402 rows. Summaries, tags, entity refs, action signals, cost_class, umlagefaehig, viewer_safe. Step 8b active (Sonnet). is_current=true pattern, RLS enabled.
- **warehouse.property_intelligence** — 2 rows (KO132, HHS55). Blackstone 11-section brain format. Staleness trigger active from pipeline. Brain prompt in src/lib/brain-prompt.ts.
- **warehouse.processing_jobs** — job queue, pg_cron every minute.
- **warehouse.suggested_matches** — entity matching results.
- **warehouse.review_tasks** — low-confidence review queue.
- **warehouse.apply_log** — GoBD immutable audit trail.
- **warehouse.document_chunks** — EMPTY placeholder for future RAG.
- **warehouse.document_intelligence_runs** — DOES NOT EXIST.

### public schema (Prisma, 13 models)
All models annotated with tenant-scoping (enforced by CI gate):

| Model | Annotation | Org Column / FK |
|-------|-----------|-----------------|
| Organization | @global | — |
| VpiIndex | @global | — |
| User | @tenant-scoped | organizationId (nullable) |
| Property | @tenant-scoped | organizationId |
| Person | @tenant-scoped | organizationId |
| BankConnection | @tenant-scoped | organizationId |
| BankAccount | @tenant-scoped | organizationId |
| Membership | @tenant-scoped | orgId |
| Invitation | @tenant-scoped | orgId |
| Unit | @tenant-scoped-via | propertyId |
| Lease | @tenant-scoped-via | unitId |
| ServiceProvider | @tenant-scoped-via | propertyId |
| BankTransaction | @tenant-scoped-via | bankAccountId |

**Data state:** Organization (1), User (2 — admin + synthetic monitor), Property (2), Membership (2). All other Prisma tables are empty (no real lease/transaction data yet).

### SQL Views (warehouse schema)
- v_cost_overview, v_vendor_summary, v_insurance_status, v_open_actions, v_property_summary — all active
- v_unit_timeline — EXISTS but has permission issue (SELECT not granted)

---

## Pipeline (Supabase Edge Function, dual-path)

Shared steps: 1. claimJob  2. fetchDocument  3. extractText  4. classifyDocument  5b. categorize  10. completeJob

**Legacy path** (doc types without v2 schema — ~116 types):
5. extractFields (Haiku)  6. storeExtraction  7. matchEntities  8. routeByConfidence  8b. generateIntelligence (Sonnet)

**v2 path** (doc types in `V2_SCHEMA_DOC_TYPES` — currently: mietvertrag):
5. extractFields → skipped  8b-v2. generateV2Envelope (Sonnet + schema prompt + verifiers → `document_extractions_v2`)

Open taxonomy: 120 German doc types. DOC_TYPE_MAP maps to 4 display categories (Kosten, Versicherungen & Verträge, Behörden, Sonstiges).
Self-operates via pg_cron every minute. Stuck job recovery every 5 minutes.

---

## Tier 0 — Foundational Integrity Gates (ALL COMPLETE)

All five gates shipped May 2026. These were blocking customer #1.

### 1. Multi-Tenant CI Gate (commit b8e3da3)
- Runs on every PR via GitHub Actions. Branch protection active.
- 13 Prisma models annotated (@tenant-scoped / @tenant-scoped-via / @global).
- Meta-rule: every new model must declare tenancy or CI fails.
- 8 exceptions annotated with call-site-specific ≥20-char reasons.
- Raw SQL ($queryRaw, $executeRaw) banned in app code. Existing 7 callers annotated as exceptions.
- Meta-test suite at tools/tenant-isolation-lint/__fixtures__/.
- Exceptions tracked in tenant-isolation-exceptions.md with CI diff enforcement.
- Schema parser: line-oriented text parser, no @prisma/internals dependency.
- Approved wrappers: getOrgContext(), getOrgContextWritable(), getOrgContextAdmin(), getOrgId(), getOrgIdOrThrow(), warehouseDb().
- Architectural preference: direct organizationId columns over indirect @tenant-scoped-via for new tables.
- Config: tools/tenant-isolation-lint/config.ts (single file, all policy definitions).

### 2. Migration Discipline (commit 53f9aa2)
- Supabase CLI initialized and linked to production.
- 26 migrations tracked and synced (Local = Remote).
- `supabase db push` is the only approved method for schema changes — no manual SQL via dashboard.
- CI drift detection via GitHub Actions on every PR touching migrations or schema. Branch protection active.
- GitHub secret: SUPABASE_ACCESS_TOKEN for CI authentication.

### 3. ARCHITECTURE_STATE.md CI Gate (commit 175ca58)
- PRs touching migrations, pipeline, server actions, routes, schema, CI workflows, or lint gates must also update this file or the build fails.
- Hard fail, no override — the friction is the feature.
- Trigger paths: supabase/migrations/*, supabase/functions/process-document/*, src/lib/*-actions.ts, src/app/*, prisma/schema.prisma, tools/tenant-isolation-lint/*, .github/workflows/*

### 4. GoBD Soft-Delete + Retention (commit 76e1849)
- warehouse.documents has deleted_at (timestamptz) and deleted_by (uuid) columns.
- Postgres trigger blocks hard DELETE on warehouse.documents — any attempt raises an exception.
- softDeleteDocument() enforces retention_until before allowing deletion. Returns error with expiry date if retention period hasn't expired.
- Retention calculation: 30 years for legal (rechtliches), 10 years from invoice date for cost docs, 10 years default.
- Audit trail: deleted_at timestamp + deleted_by userId on every soft delete.
- Prisma tables (Property, Lease, BankTransaction) deferred — no real data yet.

### 5. Backup-Restore Drill (commit b28f78f)
- PASSED May 3, 2026. pg_dump (4.7MB) → pg_restore into separate Supabase project.
- Verified: 634 documents, 402 intelligence rows, 411 extraction rows — all match production.
- 318 restore errors (all Supabase system extensions, zero data loss).
- Recovery procedure documented in scripts/restore-drill.md.
- Cadence: quarterly (next drill: August 2026).

### 6. Eval Harness Scaffolding (Task 4.1)
- `scripts/eval/` — deterministic metrics module, fixture loader, CLI (`score` + `extract --live`).
- Metrics (architecture §13.2): exact_match (raw_value), normalized_match (deep-equal, key-sorted — value-correctness), evidence_grounded (legacy verbatim-quote boolean, whitespace-normalized — retained for back-compat), the **evidence-grounding GRADE** (0–3, field-aware/same-page/local-window — see Task 4.3a; the grade is the forward metric, evidence_grounded is no longer the primary `evid` signal), absence_state_correct (no hallucinated values on gold-absent), severity_weighted_error_rate (weights from schemas/<doc_type>/schema.yaml).
- Value-correctness (normalized_match) and evidence-grounding (the grade) are split and NEVER collapsed: a value can be correct yet ungrounded, or grounded yet wrong.
- Semantic "does the quote justify the value" is deferred to the Task 4.5 critic — no LLM judgment in the metrics module.
- `extract --live` is gated behind explicit `--live` + `--fixture-cap N` flags; errors cleanly when fixtures lack OCR text inputs (the case today — Task 4.3 produces those inputs).
- Fixture loader respects an optional per-fixture `meta.json` (`{ split, tags, notes }`) — default split is `gold`. The gold/dev/test split convention is not yet formalized in architecture; the loader is forward-compatible.
- Output: `eval/results/<timestamp>.json` with per-fixture and per-doc-type aggregates.
- Tests: `src/tests/eval/metrics.test.ts` (deterministic, no LLM, 36 assertions), `src/tests/eval/score-smoke.test.ts` (gold-vs-gold across all real fixtures, 81 assertions).
- 4.2 (CI + Discord regression alert), 4.3 (gold-set + adversarial fixtures), 4.5 (Opus + critic) build on this.

---

## Synthetic Monitoring (LIVE, commit 76f18379)

Files: ~/scripts/synthetic/ on Mac Mini, src/app/api/synthetic/ping/route.ts in repo.

- **Tier A:** HTTP ping to /api/synthetic/ping every 5 minutes. Validates JSON shape + freshness (checked_at within 60s). Catches: Vercel down, build broken, env vars missing.
- **Tier B:** Playwright headless login as synthetic viewer user every 15 minutes. Asserts data-testid="warehouse-properties-loaded" DOM contract on /dashboard/warehouse. Catches: auth broken, RLS broken, dashboard regressions.
- **Alert discipline:** 2 consecutive completed failures before alerting. One alert per incident. Recovery message on pass. No success spam.
- **Connectivity self-check:** Two-of-two probes (Google generate_204 + Supabase host). Suppresses alerts when Mac Mini's own internet is down.
- **Heartbeat deadman:** Scheduler writes heartbeat every 60s. Orchestrator detects stale heartbeat (>20 min) and alerts.
- **Pause file:** touch ~/.agent-hub/synthetic-paused to suppress during deploys.
- **Synthetic user:** synthetic-monitor@prop-manage-de.internal, viewer role, is_synthetic=true. Filtered from getOrgMembers, getOrgPendingInvitations, audit display. Credentials in Apple Passwords + ~/.synthetic-monitor.env (mode 0600).

**INVARIANT:** data-testid="warehouse-properties-loaded" with data-property-count and data-app-version on /dashboard/warehouse. Any dashboard redesign must preserve these attributes.

**Accepted SPOF:** Entire alert path depends on discord-bridge.js being alive.

---

## Typed Notification System (LIVE, shipped with synthetic monitoring)

- discord-bridge.js handles JSON notifications with schema validation via TYPE_CONFIG.
- Types: task_completed, task_failed, task_decision_needed, synthetic_failure, synthetic_recovery, synthetic_heartbeat_stale, synthetic_heartbeat_recovered, playwright_drift, test_notification.
- Each type has color, icon, label. Embeds show title + summary + structured fields + action links.
- Orchestrator auto-injects `### SUMMARY:` convention into every Claude Code task.
- Schema validator rejects malformed notifications (missing channel/type/title/summary, short reasons, etc.).
- `!test-notification` command in Discord to verify the notification path.
- `!status` command shows orchestrator + synthetic monitor heartbeat status.

---

## UI (Live Features)

- **Dashboard:** KPI strip (Objekte, Einheiten, Miete/Monat, Vermietungsquote) + Immobilienbestand holdings table + Immobilien-Analyse with property selector and Mietübersicht tab.
- **Inbox (Alle Dokumente):** Document list with vendor/amount/date columns. Triage overlay with apply/quarantine. Document intelligence summary in right panel. "Seit deinem letzten Besuch" orientation card.
- **Property detail:** Compact folder list on Dokumente tab. Brain insight line.
- **Team management:** /dashboard/settings/users — member list, invitations, role management.
- **Shell:** Proda-style icon-only sidebar with expand/collapse chevron. Settings flyout with user info and logout. Fixed layout (header + sidebar fixed, content scrolls).
- **Property chat:** /api/properties/[id]/chat endpoint.
- **Formatting:** German numbers (dots as thousands separators), dd.MM.yyyy dates.

### Design Principles
- German-only UI (English loanwords retained: Dashboard, Inbox, Export, Upload, Download, CSV, PDF, E-Mail).
- Fidelity content/structure with Apple Health aesthetics.
- Silence is calm: no green "Alles OK" badges, no alerts unless actionable.
- Dashboard is a router, not a destination.

---

## Roles & Access

| Role | Access | Notes |
|------|--------|-------|
| service_operator | Full ops access | Nils — data processor |
| owner | Org admin | Rarely used initially |
| manager | Future internal staff | Not active |
| viewer | Read-only property owner | Customer-facing |

- Middleware: viewers → /dashboard/warehouse, managers blocked from /settings.
- UI controls hidden for viewers (upload, apply, quarantine, export, settings).
- All mutations use getOrgContextWritable() or getOrgContextAdmin().

---

## Auth & Security

- NextAuth v5 Credentials (bcrypt).
- Org context: getOrgContext(), getOrgContextWritable(), getOrgContextAdmin() in src/lib/org.ts.
- Cookie-based active org with auto-fallback (x-active-org, x-active-role).
- warehouseDb(orgId) wrapper for warehouse queries — injects org_id predicate.
- Wrong-org errors return 'Not found' (never 'Unauthorized').
- updateMany/deleteMany with count check everywhere.
- is_synthetic boolean on User for filtering synthetic monitor from UI.

---

## Infrastructure

- **Mac Mini M4** (Tailscale IP 100.86.27.51, user: federico): orchestrator, discord-bridge, synthetic scheduler. All launched via ~/scripts/start-agents.sh.
- **Discord:** #nils (control), #pipeline (alerts), #build (codex), #status (system online).
- **Supabase Pro:** Database + storage + Edge Functions. CLI linked, migrations tracked.
- **Vercel:** Auto-deploy from main. Synthetic ping endpoint with force-dynamic.
- **GitHub Actions:** 3 CI gates (tenant isolation, migration drift, architecture state).

---

## v2 Claim Store (Task 0.4)

Three new tables in `warehouse.*` schema: `claims`, `claim_closures`, `derivation_records`.
- **Append-only by design:** Postgres triggers block UPDATE (except one-way supersession on claims.valid_to/superseded_at/superseded_by_claim_id) and block all DELETE (GoBD compliance).
- **Indexes:** Composite on `(property_id, subject, predicate, valid_from)`, partial index on open claims (`WHERE valid_to IS NULL`), GIN on `derivation_records.input_claim_ids`, plus source_document, closures target, derivation output/property.
- **Tenant isolation:** All three tables annotated `@tenant-scoped-via property_id` (directly or transitively via target_claim_id). RLS enabled with org isolation policies.
- **Migration:** `supabase/migrations/20260510080000_v2_claim_store.sql`
- **Integration test:** `src/tests/v2-claim-store-migration.test.ts` (13 assertions: constraints, triggers, immutability)
- **Status:** Schema live, applier writes claims (Task 1.8). Not yet wired into pipeline (Task 1.9).

## Claim-store transaction applier (Task 1.8)

Single writer to `warehouse.claims`, `warehouse.claim_closures`, and
`warehouse.derivation_records` in normal pipeline operation. Architecture §5.5.

**Shipped:**
- `src/lib/claim-store/applier.ts` (Task 1.8, 2026-05-22) — `applyEmission`
  function. All three close_modes implemented. Three claim-aware blocker
  checks (multi-tenant partial, vacant-possession safeguard, Staffelmiete
  conflict). Fuzzy tenant matching for closure verification. DerivationRecord
  per insert and per closure. Transaction-wrapped; rollback on any safety
  failure. Idempotent via SELECT-before-INSERT on `(source_extraction_run_id,
  subject, predicate, source_field_path)`.
- `src/lib/claim-store/fuzzy-tenant-match.ts` — pure token-subset matcher,
  Anrede-stripped, no Levenshtein. 12 unit tests.
- `src/lib/claim-store/types.ts` — ApplyContext, ApplyResult, BlockerReason,
  APPLIER_VERSION.

**Pending (separate tasks):**
- Closing-matrix predicate-pair allowlist enforcement (TODO in applier.ts) —
  blocks on the second emitter type landing
- Optional-match confidence downgrade (TODO in applier.ts)
- Test-environment trigger bypass for cleanup — currently tests use
  transaction rollback via passed-in `tx`; production pipeline call (Task 1.9)
  opens its own transaction

**Wire-up:** Task 1.9 calls `applyEmission` from the Edge Function after
Step 8b writes the v2 envelope and the appropriate emitter produces an
EmissionResult.

---

## v2 Extraction Envelope (Task 0.5)

New table `warehouse.document_extractions_v2` — the v2 extraction envelope that stores document-level extraction results in structured envelope format per architecture §3.1/§3.3/§3.4.
- **Append-only with one exception:** Postgres triggers block UPDATE on all columns except `human_review_status` (mutable to support the triage workflow). DELETE blocked entirely (GoBD compliance).
- **Indexes:** `(source_document_id, created_at DESC)` for latest-extraction queries, `extraction_run_id` for replay, `schema_version` for re-emission candidates, `doc_type` for eval slicing, partial index on `human_review_status` where not `'not_reviewed'`.
- **Tenant isolation:** `@tenant-scoped-via source_document_id` (FK chain: document_extractions_v2.source_document_id → documents.id → Property.id). RLS enabled with org isolation policy.
- **Migration:** `supabase/migrations/20260510090000_v2_extraction_envelope.sql` + `20260510090001_v2_extraction_envelope_grants.sql`
- **Integration test:** `src/tests/v2-extraction-envelope-migration.test.ts` (12 assertions: CHECK constraints, immutability triggers, human_review_status mutability, GoBD delete block, index queries)
- **Status:** Schema live, v2 pipeline path writes envelopes for mietvertrag doc_type (Task 1.5). Legacy `warehouse.document_extractions` (Haiku Step 5) untouched; both paths coexist during transition window per architecture §11.

---

## v2 Domain Knowledge Layer

- `domain_knowledge/` directory exists at repo root
- 5 stub files present (one per launch-slice doc type): mietvertrag, wohnungsuebergabeprotokoll, mieterhoehung, mietvertragsnachtrag, kuendigung
- Front-matter Zod validator in `src/tests/domain-knowledge.test.ts`
- Validator currently runs manually (`npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts`); CI integration is part of Task 0.2

## v2 Schemas Layer

- `schemas/` directory exists at repo root with 5 doc-type subdirectories: mietvertrag, wohnungsuebergabeprotokoll, mieterhoehung, mietvertragsnachtrag, kuendigung
- Each has a stub `schema.yaml` validating against the meta-schema (`schemas/_meta_schema.yaml`)
- Validator at `scripts/validate-schemas.ts` (importable + CLI)
- Test at `src/tests/schemas.test.ts` runs the validator
- Cross-validation against domain knowledge: claim_kind match, fields_governed coverage, normalization_rule_ref integrity. Currently soft because stubs have empty arrays — becomes load-bearing in Phase 1+.

## v2 Generator (Phase 1 Outputs)

- `schemas/<doc_type>/generated/` directories exist for all 5 launch-slice doc types (mietvertrag, wohnungsuebergabeprotokoll, mieterhoehung, mietvertragsnachtrag, kuendigung)
- Three generated files per doc type: `prompt_fragment.ts` (Deno-compatible), `field_labels.json`, `envelope_validator.ts` (Deno-compatible, hand-written validation, no Zod)
- Generator at `scripts/gen-schemas.ts` (CLI: `npm run gen:schemas`, check mode: `npm run gen:schemas:check`)
- CI gate at `.github/workflows/generated-files-fresh.yml` enforces that generated files stay in sync with source schemas
- Phase 2 outputs (JSON Schema, Zod schemas) and Phase 3 outputs (TypeScript types, eval rubric, emitter stubs) are deferred per architecture §7.2 — added when consumers exist

---

## Tests

| Suite | Count | Status |
|-------|-------|--------|
| Playwright e2e | 11 | ✅ Passing |
| Golden file tests | 16 | ✅ Passing |
| Brain contract tests | 2 | ✅ Passing |
| Tenant isolation meta-tests | 18 | ✅ Passing |

---

## Known Issues (Non-Blocking)

- connector.apply() fails for angebot/vollmacht/informationsmaterial doc_types.
- 6 failed documents (HEIC, large PDFs).
- Vendor name duplication (83 extracted, ~50 real — needs normalization table).
- Cost amounts include purchase prices (€519k Kaufvertrag mixed with operating costs).
- viewer_safe incorrectly flags Mieteingänge summaries as false.
- unit_ref inconsistent across documents.
- cost_class/umlagefaehig NULL on 397 existing intelligence rows (only new docs populated).
- HHS55 brain shows Weber rent as 900 not 1000.
- Some Mietbeginn dates missing in brain output.
- v_unit_timeline permission issue.
- Supabase probe in connectivity check not loading SUPABASE_URL (Google fallback works).
- Orchestrator emits task_completed when Claude Code exits 0 despite body-reported failure.
- SUMMARY convention is string-parsing hack (replace with structured output at customer #1).

---

## Follow-Ups (Tracked, Not Blocking)

### Iteration 2 — Tenant Isolation
- Raw SQL wrappers: tenantSafeQuery, tenantSafeExecute, tenantSafeQueryVia. DoD: wrappers exist, all $queryRaw exceptions migrated, zero raw SQL annotations remaining.
- Schema constraint audit gate: @@unique declarations missing organizationId.
- Prisma table soft-delete: Property, Lease, BankTransaction get deleted_at/deleted_by when they have real data.

### After Tier 0 (Priority Order)
- Pre-commit tsc + lint
- verify-brain.js invariants with brain-diff-on-regeneration
- Structured JSON logging with trace_id
- Anthropic spend cap (immediate 5 min) + daily cost report (deferred)
- Fixture-on-prompt-change

### Deferred Features (Build When Needed)
- Extraction schemas v2: deploy Edge Function, Phase 1 test on grundbuchauszug docs.
- Auto-apply learning (after 50+ reviewed docs).
- Vendor normalization table.
- IBAN extraction, due_date + payment_status.
- Full-text search (ocr_text exists, needs tsvector index + UI).
- Cost aggregation API.
- Insurance active/expired tracking.
- Rent roll current state.
- Vacancy detection.
- Phase 2 i18n (next-intl, DE/EN).
- GoBD correction flow (Stornieren & neu verbuchen).
- Shared document table primitives.
- Research wiki (Karpathy pattern, post-customer-1).

### Deferred UI/UX
- Global search in header.
- Persistent Upload in sidebar.
- Add Property UI button.
- Export button.
- Timeline view for Protokoll.
- Sidebar section grouping with labels.
- Breadcrumb icons.

### Deferred SaaS Hardening (Post-Customer-1)
- Observability dashboard.
- Anomaly alerting baselines.
- Per-customer metrics.
- Job replay.
- Feature flags.
- Code health reports.

---

## Key Rules

1. **No backend without frontend to consume it.** Don't build APIs, columns, or indexes until a UI exists to use them.
2. **Discord task rule:** Every task adding a new data field to UI must specify: (1) database table/column, (2) server action query, (3) component that renders it.
3. **Spec → ChatGPT critique → Claude Code implementation.** Claude (chat) writes the spec, ChatGPT critiques, Claude Code implements via Discord.
4. **Claude Code self-verification is unreliable** for "write from scratch" tasks. Always verify by running the code, not by reading completion reports.
5. **Silence is calm.** No green badges, no alerts unless actionable.
6. **Architectural preference:** Direct organizationId columns over indirect @tenant-scoped-via for new tables.
7. **Password/secret scripts** leak into SSH history and chat logs. Rethink before first hire.

## CI workflow path filters removed (2026-05-10)

Removed `paths:` filters from `migration-drift.yml` and `tenant-isolation.yml`. Both workflows now run on every PR and every push to main. Reason: branch protection requires these checks to pass, but path filters meant they never reported status on PRs that didn't touch the filtered paths, leaving such PRs blocked indefinitely in "Expected — Waiting for status to be reported." Trade-off: ~30s additional CI compute per PR. Acceptable.

## v2 Deterministic Verifiers (Task 1.3)

`supabase/functions/process-document/verifiers/` directory created with three pure-function verifiers backing the verifier_refs declared in `schemas/mietvertrag/schema.yaml`:

- `monetary-verbatim` — extracted monetary value must appear verbatim in OCR text (German thousands-separator, plain, US-style accepted)
- `enum` — normalized_value must match field_spec.enum_values
- `date-format` — ISO 8601 single-value calendar date (rejects comma-separated multi-value strings; round-trips against `new Date()` to catch invalid calendar dates like 2024-02-31)

All verifiers are pure functions per architecture §10. No LLM calls, no model-specific code paths.

Model-agnosticism enforced by `src/tests/verifiers-no-model-identifiers.test.ts` per architecture §9.3: scans all verifier source files for forbidden tokens (sonnet, haiku, opus, gpt, gemini, claude, llama, mistral). Fails CI if any match.

15 unit-test assertions covering positive and negative cases per verifier including absence_state skip behavior.

Status: verifiers live in code, wired into the v2 pipeline path (Task 1.5). Verifiers run on every v2 envelope field with `absence_state == "present"` and matching `verifier_refs`. Failures downgrade `confidence` to `"low"`, set `validation_status` to `"failed_verifier"` or `"failed_format"`, and override `absence_state` to `"contradicted"` (semantic failure) or `"ambiguous"` (structural failure).

## v2 Dual-Path Pipeline (Task 1.5)

The `process-document` Edge Function now branches on a v2 schema registry:

- **Registry:** `schemas/index.ts` exports `V2_SCHEMA_DOC_TYPES = new Set(["mietvertrag"])` and `hasV2Schema(docType)`. Hand-maintained — adding a doc type requires an explicit edit, not auto-discovered from directory structure.
- **v2 path (doc types IN registry — currently only `mietvertrag`):**
  - Step 5 (Haiku extractFields): **skipped** — no Haiku API call, no legacy extraction written.
  - Step 8b-v2 (Sonnet generateV2Envelope): runs Sonnet with the schema's `prompt_fragment` template, parses JSON envelope, validates via `envelope_validator.ts`, runs deterministic verifiers per `verifier_refs`, writes to `warehouse.document_extractions_v2`. **FATAL on failure** — does not fall back to legacy extraction.
  - Steps 7 (storeExtraction), 8 (matchEntities), 9 (routeByConfidence): skipped for v2. Document routed to `needs_review`.
  - Step 8b legacy (generateIntelligence): **not called** for v2 docs — no `document_intelligence` row written.
- **Legacy path (doc types NOT in registry — ~116 doc types):** pipeline runs exactly as before. Step 5 (Haiku) → legacy `document_extractions`. Step 8b (Sonnet) → `document_intelligence`. No v2 envelope written.
- **Lifecycle (Phase 1):** minimal — `issue_date`/`effective_date` from `mietbeginn`, `expiry_date` from `mietende` if present, `document_status: "active"`. Fuller lifecycle analysis deferred to Phase 2.
- **Triage UI:** not yet updated — Task 1.6 adds dual-read (v2 envelope first, legacy fallback).
- **Edge Function deployment:** manual (`supabase functions deploy process-document`) — not auto-deployed by git push.

### Task 1.6 — Triage Overlay Dual-Read

Triage overlay now reads v2 envelopes from `warehouse.document_extractions_v2` with graceful fallback to legacy `document_extractions`.

- **`getTriageDocument`** fetches latest v2 envelope (by `source_document_id`, `created_at DESC`). Returns `v2Envelope` and `v2EnabledDocTypes` in the data shape.
- **Decision rule:** v2 present → v2 fields rendered (read-only, "v2" badge); v2 absent → legacy fields rendered (editable, "Legacy-Format" badge). Never both.
- **`src/lib/extraction-display.ts`** — pure module (no React/Prisma/Supabase/Next imports) mapping v2 envelopes and legacy extracted_fields to uniform `DisplayRow[]`. Canonical location for field labels and formatting. Future v2 doc types extend the `V2_FIELDS` map here.
- **`requeueDocumentExtraction(documentId)`** — new server action. Inserts a `processing_jobs` row with `status='queued'`; audit-logs `re_extraction_requested`. "Neu extrahieren" button visible for legacy docs whose `doc_type` is v2-enabled (currently: `mietvertrag`).
- **v2 envelopes are read-only** in the overlay (append-only per architecture §3.1). Edit-in-overlay remains legacy-only. v2 edit flow deferred.
- **Test:** `src/tests/triage-document-shape.test.ts` — 40 assertions covering Lena's exact v2 fields, absence_state rendering, legacy Rechnung/lease shapes, purity gate, and edge cases.
- **Acceptance:** Lena Everding's Mietvertrag shows kaltmiete 650,00 EUR, Einheit 1.OG, Mieter Everding/Lena, Mietbeginn 01.04.2025, no Mietende row (not_applicable), "v2" badge.

### Task 1.5b — Validator Audit (PR pending)

Comprehensive audit of `envelope_validator.ts` against architecture §3.1. Four bugs found; three fixed:

- **Bug B (FIXED):** Evidence was required unconditionally. Now gated on `absence_state == "present"` per §3.1. This was the bug blocking Lena Everding's mietende (open-ended lease, `not_applicable`, no evidence).
- **Bug C (FIXED):** Severity check was removed entirely by PR #21. Now restored: pipeline (`generateV2Envelope`) injects severity from `v2Config.fieldSpecs[fieldId].severity` before validation; validator confirms it matches the schema's FIELD_DEFS.
- **Bug D (FIXED):** Enum check referenced `v.value` (doesn't exist in envelope) instead of `v.normalized_value`. Dead-code path fixed.
- **Bug E (NEW):** Added checks for `confidence` (high|medium|low) and `validation_status` (valid|failed_format|failed_verifier|requires_human_review) enums.
- **Bug A (NOT CHANGED):** Evidence stays as array (PR #22's choice). Architecture §3.1 table says object; implementation intentionally diverges to support multi-quote evidence.

Test: `src/tests/envelope-validator.test.ts` — 36 assertions covering happy path, all 8 absence_state values, evidence gating, severity injection (including new fields), enum invariants, and shape errors. Prevents future drift.

### Task 1.5c — Mietvertrag Schema Expansion (3 fields)

Schema bumped from `2026-05-11-v1` to `2026-05-13-v1`. Three fields added to `schemas/mietvertrag/schema.yaml`:

- **nebenkostenvorauszahlung** (money, important) — monthly NK advance. Sets ambiguous for Warmmiete/Inklusivmiete contracts; not_applicable for kein-NK leases.
- **kaution** (money, important) — security deposit. Sets ambiguous for "3 Monatsmieten" without euro figure; not_applicable for kautionsfrei contracts. BGB §551 cap is the resolver's job.
- **landlord_identity** (structured, critical) — Vermieter party, mirrors tenant_identity shape. For Eigentümerwechsel scenarios, captures the ORIGINAL Vermieter from the contract.

These three fields were already declared in `domain_knowledge/mietvertrag.md` `fields_governed` but had been deferred during Phase 1 minimal-schema rollout. All 8 mietvertrag fields_governed entries are now covered by the schema.

Existing v2 envelopes (Lena, Paul) remain on `2026-05-11-v1` — no migration risk. New extractions land on `2026-05-13-v1`. After merge: Nils manually redeploys Edge Function and re-queues Lena's + Paul's jobs to get them onto the new schema.

- Renderer: `V2_FIELDS.mietvertrag` in `extraction-display.ts` has 8 entries (money cluster → unit → parties → dates).
- Pipeline: `V2_PROMPTS.mietvertrag.fieldSpecs` has 8 entries with correct severities.
- Tests: envelope-validator 36 assertions, triage-document-shape 50 assertions.
- gen:schemas:check warnings reduced from 12 to 9 (3 mietvertrag "not yet in schema" warnings gone).

### Task 1.5d — OCR Truncation Fix (extractText max_tokens + stop_reason guard)

`extractText` was capped at `max_tokens: 4000` (~16k chars output) while Claude Haiku 4.5 supports up to 64,000 output tokens. Multi-page documents were silently truncated mid-document. Sonnet then operated on truncated text, marking fields in the missing portion as `absent` with high confidence and no warning.

Fix:
- **PDF path:** `max_tokens` raised 4000 → 64000 (Haiku 4.5 model max)
- **Image path:** `max_tokens` raised 2000 → 8000 (defensive headroom for dense scans)
- **New pure helper** `classifyOcrResponse` in `supabase/functions/process-document/ocr-result.ts`: inspects `stop_reason` on the Anthropic response. If `stop_reason === "max_tokens"`, drops `ocr_confidence` to 60 and logs a structured warning with the doc_id. Loud failure instead of silent truncation.
- **New test** `src/tests/extract-text-truncation.test.ts` — 22 assertions covering happy path (PDF/image), truncated path, empty/missing content, and other stop_reasons. Pure test, no DB or API calls.

Followup: corpus docs with truncated OCR (confirmed: Lena Everding + Julija Paul mietverträge) need re-queue after Edge Function redeploy. Runbook in the PR description.

## Task 1.5f — Page-by-page PDF OCR (2026-05-21)

extractText PDF branch now splits the PDF into single-page PDFs (pdf-lib),
extracts each page in parallel batches of 5 via Haiku 4.5 with max_tokens=4000,
and stitches outputs with --- Seite N --- boundary markers. Per-page timeout 45s
with retry on 529 (waits 30s, then 90s). Failed pages produce [ERROR: ...]
markers inline so absence is visible, not silent.

Replaces Task 1.5d single-call max_tokens=64000 strategy for PDF input.
Image input still uses single-call extraction (classifyOcrResponse retained).

Expected p50 latency drop from 8+ min to 30s for typical mietverträge.
Predictable Haiku cost linear in pages.

New module: supabase/functions/process-document/page-extraction.ts
New test: src/tests/page-extraction.test.ts (33 assertions)
classifyOcrResponse from Task 1.5d retained for image branch only.

## Task 1.5g — Anthropic rate limiter (2026-05-21)

All outbound Anthropic API calls now route through a single shared token-bucket
rate limiter in supabase/functions/process-document/rate-limiter.ts +
anthropic-client.ts. Configuration via env vars ANTHROPIC_RPS (default 0.67 =
40 rpm) and ANTHROPIC_BURST (default 5). Retry policy includes 429 (rate limit)
and 529 (overload). Honors retry-after header.

Six call sites refactored to use callAnthropic():
- extractPageText (per-page OCR)
- extractText image branch
- classifyDocument
- extractFields (legacy)
- generateV2Envelope (Sonnet)
- generateIntelligence (Sonnet, Step 8b)

Motivation: Task 1.5f's 5-way parallel OCR burst hit Anthropic's 50 rpm Tier 2
rate limit, causing pages 3-5 of Paul's mietvertrag to fail with 429. Rate
limiter prevents bursts while preserving per-doc parallelism (concurrency
within a doc is decoupled from API request rate).

New module: rate-limiter.ts (pure, ~80 lines)
New module: anthropic-client.ts (~120 lines)
New tests: src/tests/rate-limiter.test.ts (18 assertions)
New tests: src/tests/anthropic-client.test.ts (23 assertions)

Two new env vars (with safe defaults): ANTHROPIC_RPS, ANTHROPIC_BURST.

## Task 1.5e-prompt — Kaution synonym hints (2026-05-21)

mietvertrag schema.yaml kaution field description expanded to include German
synonyms (Mietsicherheit, Barkaution, Sicherheitsleistung) and form-template
formatting hints (underscores, dotted lines around amounts).

Schema version: 2026-05-13-v1 → 2026-05-21-v1

Motivation: Lena's Mietsicherheit clause and Paul's Kaution clause were both
present in OCR text after Task 1.5g but Sonnet returned absent on both.
Hypothesis: prompt didn't mention the synonyms or form-template patterns.

After Edge Function redeploy, re-extract Lena + Paul and verify kaution
populates correctly.

If still absent on either: missed-content verifier (Task 1.5e-verifier)
becomes next priority.

## v2 pipeline wiring (Task 1.9+)

The Deno Edge Function (`supabase/functions/process-document/index.ts`)
calls a Node-side API route (`POST /api/pipeline/apply-emission`) after
Step 8b commits the v2 envelope. The Node route looks up the appropriate
emitter from the registry, runs it, and calls `applyEmission` (Task 1.8).

**Why HTTP, not direct Deno DB writes:** the applier is Prisma-based
(Node-only). Reimplementing it in Deno would duplicate ~500 lines of
closure logic and create a drift surface. The HTTP bridge adds ~50ms
per document but keeps a single source of truth for claim emission
and closure semantics.

**Failure mode:** if the bridge call fails (HTTP error, network, or 5s timeout), the
Edge Function logs and proceeds. The envelope persists; claims can be
applied later via a manual replay script. Phase 1 prioritizes envelope
durability over claim-store completeness. `step9_apply_status` values:
`applied`, `no_emitter_for_doc_type`, `bridge_http_error`, `bridge_network_error`,
`bridge_timeout`, `skipped_no_url`.

**Auth:** `x-internal-secret` header. Both sides read `PIPELINE_INTERNAL_SECRET`
from env. The route returns 401 on mismatch.

**Registered emitters:**
- `mietvertrag` → `emitMietvertragClaims` (Task 1.7), version `1.0.0`

**Pending wiring follow-ups (not Task 1.9):**
- Evidence-row population (`EmitterContext.evidence_id_for_field` currently
  returns null for all fields)
- Retry/backoff on transient bridge failures
- Backfill script for already-extracted envelopes
- Multi-emitter registry entries as other doc-type emitters land

## Emitters (Task 1.7+)

Pure functions in `src/lib/emitters/<doc_type>.ts` that read v2 envelopes
and return `EmissionResult { claims_to_insert, closure_intents }`. Architecture
§4.4 contract.

**Shipped:**
- `mietvertrag.ts` (Task 1.7, 2026-05-21) — emits kaltmiete + tenant_active
  assertion claims, optionally kaution. No closures. Returns empty result
  for drafts or missing load-bearing fields.

**Pending:**
- `mieterhoehung.ts` — produces kaltmiete claim + close_overlapping_only closure
- `wohnungsuebergabeprotokoll.ts` — dispatches on uebergabe_typ
- `kuendigung.ts` — produces lease_terminated event + close_overlapping_and_future
  closures, conditional on signature/widerspruch/multi_tenant_partial blockers

**Purity gate:** `src/tests/emitter-purity.test.ts` rejects any DB/fetch
import in `src/lib/emitters/`. CI-enforced on every PR.

**Applier wiring:** see Task 1.8 (claim-store transaction applier). Emitters
are not yet called from the Edge Function — the envelope is produced and
stored, but no claims are persisted until 1.8 ships.

### Hotfix (2026-05-22) — apply-emission route column names

`/api/pipeline/apply-emission` now reads `property_id` and `org_id` directly from
`warehouse.documents` (snake_case, both columns present on row creation) instead
of joining to `Property` for `"organizationId"`. The original draft used a JOIN
that referenced non-existent camelCase columns and would have 400'd every bridge
call. Tenant-isolation annotation reason updated to reflect the direct read.

## Resolver layer (Task 1.10+)

Resolvers are pure functions that answer one question by querying the claim
store and returning a `ResolvedFact` with full provenance. Architecture §5.1–5.3.

**Shipped:**
- `src/lib/resolvers/types.ts` — `ResolvedFact<TValue>`, `ResolutionStatus`,
  `Money`, `Conflict`, `downgradeConfidence`
- `src/lib/resolvers/rent-for-unit.ts` (Task 1.10) — `rentForUnit({ property_id,
  unit_ref, as_of_date?, org_id }, { tx? }) → Promise<ResolvedFact<Money>>`.
  Implements §5.2 algorithm: zero/one/multi-claim handling, sort by (valid_from
  DESC, created_at DESC), confidence downgrade on conflicts. Writes a
  DerivationRecord per call (output_type="resolved_fact"); DR write is
  best-effort and does not block resolution. Org isolation via JOIN to Property
  with explicit org_id parameter.
- `src/tests/resolvers/rent-for-unit.test.ts` — 8 scenarios, ≥30 assertions,
  covers Lena single-claim, Paul/Kuru-style Mieterhöhung, Hofmann, multi-claim
  conflict, zero-claim, before-any-claim date, org isolation, prefix
  idempotency
- `src/tests/resolvers/resolver-purity.test.ts` — CI gate: resolver source
  contains no LLM/prompt/emitter/extraction imports and no `fetch(` or
  `https://` literals

**Pending (separate tasks):**
- Other resolvers (`owner_of_property`, `active_insurance_for_property`,
  `last_meter_reading_for_unit`) — follow the same template
- UI surfacing of conflicts (`status === "latest_active_claim_with_conflicts"`
  should drive a triage banner)
- Caching/memoization for hot resolvers (not needed pre-customer)

## Phase 1: CLOSED (Task 1.11, 2026-05-27)

Phase 1 of the v2 extraction architecture is complete. The full chain —
extraction envelope → claim emission → applier with closure handling →
resolver — works end-to-end for the Mietvertrag doc type.

**Phase 1 deliverables:**
- Task 1.7: pure Mietvertrag claim emitter
- Task 1.8: transaction applier with closure semantics
- Task 1.9: Edge Function ↔ Node bridge via /api/pipeline/apply-emission
- Task 1.10: rent_for_unit resolver
- Task 1.11: Everding KO132 1.OG end-to-end fixture test (Phase 1 gate)

**The Phase 1 gate test** (`src/tests/integration/everding-end-to-end.test.ts`)
runs the full chain against a deterministic fixture envelope. If this test
ever fails, Phase 1 is broken and must be fixed before any Phase 2 work.

**Phase 1 success criterion verified:**
`rentForUnit({ property_id: KO132, unit_ref: "1.OG" })` returns
`{ amount: 65000, currency: "EUR" }`, `status: "single_active_claim"`,
`confidence: "high"`.

**Next:** Phase 2 — extend to other doc types (Mieterhöhung, Kündigung,
Übergabeprotokoll, Eigentümerwechsel) per the closing-matrix pattern.

## Mieterhöhung emitter shipped (Task 2.1, 2026-05-27)

Second doc_type in the v2 chain, and the FIRST emitter that produces closure
intents. Starts Phase 2.

**Shipped:**
- `domain_knowledge/mieterhoehung.md` — front-matter declares the `closes` rule
  (target_predicate: kaltmiete, target_subject_pattern: "unit:<unit_ref>",
  close_mode: close_overlapping_only, valid_to_source: "effective_date - 1 day",
  blocker_check: [staffelmiete_conflict]) plus the seven required gotchas
  (scope_narrowed_to_rent_change, kappungsgrenze_15_percent,
  tenant_consent_requirement, effective_date_vs_notice_date,
  future_dated_increase_no_immediate_closure, staffelmiete_mid_schedule_amendment,
  closure_prerequisites). Note: the front-matter `closes` shape follows the
  shipped Zod contract in src/tests/domain-knowledge.test.ts (CloseEntry), not
  the illustrative shape in the task brief.
- `schemas/mieterhoehung/schema.yaml` — extraction fields nachtrag_typ,
  rechtsgrundlage, new_kaltmiete, previous_kaltmiete, effective_date,
  notice_date, unit_ref, tenant_identity, landlord/tenant signature flags,
  document_status, staffelmiete_context, plus §558/§559/Indexmiete structured
  sub-objects (conditional, extractor-side only). Generated prompt fragment +
  validator + field labels regenerated via `npm run gen:schemas`.
- `src/lib/emitters/mieterhoehung.ts` — pure function. Always emits one new
  `kaltmiete` assertion claim (confidence downgraded to "low" when closure
  prerequisites fail, so drafts still surface in triage without superseding the
  open claim). When prerequisites pass (landlord_signed, effective_date present,
  unit_ref present, document_status not draft/unsigned) it ALSO emits a
  `kaltmiete_amended` **event** claim and a `ClaimClosure` (close_overlapping_only,
  close edge = effective_date - 1 day). The event claim is required by the
  applier: applyEmission throws unless exactly one event claim accompanies a
  closure intent, and it dispatches the §5.5.5 Staffelmiete blocker on the event
  claim's predicate. Throws when new_kaltmiete is absent. Sets
  blocker_status="requires_review" when staffelmiete_context=true; the applier
  independently re-checks the claim store (checkStaffelmieteConflict).
- `src/lib/emitters/index.ts` — `mieterhoehung` registered for HTTP bridge dispatch.
- `src/tests/emitter-mieterhoehung.test.ts` — 46 assertions across happy path,
  draft-no-closure, Staffelmiete-blocker, missing-effective_date, missing-
  new_kaltmiete (throws), and determinism scenarios.
- Emitter purity gate (`src/tests/emitter-purity.test.ts`) auto-discovers the
  new file; no edit needed.

**Reconciliation note (task brief vs shipped code):** the brief's Step 3/Step 5
code used invented type names (`ClosureIntent`, `ClaimToInsert`) and a
single-claim/`target_predicate`-singular shape. The shipped types are `Claim`
and `ClaimClosure` (`target_predicates: string[]`, no `triggering_event_predicate`),
and the shipped applier requires the accompanying `kaltmiete_amended` event
claim. The emitter and tests were aligned to the shipped contract, as the brief
itself instructs ("verify type alignment ... any mismatch breaks the integration").

**Pending (separate tasks):**
- Task 2.1b: Mietvertragsnachtrag (non-rent amendments)
- Task 2.2: end-to-end Paul case test (€525 → €575 supersession through the full chain)
- Predicate-pair allowlist generator (CI consumer-contract, §6.4) — when it lands,
  this front-matter's `closes` becomes the source of truth
- Evidence-row population for closure intents (still null)
- Indexmiete recomputation jobs (future field-level resolver)

## Phase 2 supersession gate + applier hotfix (Task 2.2, 2026-05-27)

Three-case integration test (Paul, Kuru, Weber) verifying the supersession
chain end-to-end. The Weber case is the original v1 bug that motivated v2;
the test verifies the architectural fix.

**Shipped:**
- `tests/fixtures/extraction/supersession/{paul,kuru,weber}-*/` —
  synthetic Mietvertrag + Mieterhöhung envelopes per case
- `src/tests/integration/supersession-cases.test.ts` — 54 assertions across
  3 cases, all rolled back in per-case tx
- **Applier hotfix (in same PR):**
  1. Staffelmiete blocker check now excludes the current emission's own
     claims (filter on source_extraction_run_id != ctx.extraction_run_id).
     Previously the check found the newly-inserted kaltmiete and falsely
     blocked the closure.
  2. close_overlapping_only no longer sets superseded_at +
     superseded_by_claim_id on closed claims (only close_overlapping_and_supersede_future
     does, per architecture §5.5.3). Previously the closed claim was hidden
     from the resolver's historical queries because of the
     superseded_by_claim_id IS NULL filter.

**Bug class closed:** the historical query `rentForUnit(as_of_date < effective_date)`
now correctly returns the old rent (€525 for Paul pre-2024, €900 for Weber
pre-2024-04-01) with `single_active_claim` and `confidence: "high"`.

**Pending (separate tasks):**
- Task 2.1b: Mietvertragsnachtrag (non-rent amendments)
- Task 2.3: Übergabeprotokoll schema (now shipped per a separate PR if applicable)
- Task 2.4: Übergabeprotokoll emitter
- Task 2.5: Hofmann fixture (Eigentümerwechsel safeguard)
- Task 2.6: PLZ verifier

## Übergabeprotokoll schema expanded (Task 2.3, 2026-05-27)

The schema YAML stub at `schemas/wohnungsuebergabeprotokoll/schema.yaml`
(placeholder since Task 0.2) has been expanded with all 11 production fields.
Domain knowledge file `domain_knowledge/wohnungsuebergabeprotokoll.md` was
already populated in Task 1.4 — no changes needed there.

**Fields shipped in the schema:**
- uebergabe_typ (critical, enum: Einzug, Auszug, Eigentümerwechsel, unklar) —
  THE dispatch discriminator for Task 2.4's emitter
- unit_ref (critical, enum, conditional on uebergabe_typ in [Einzug, Auszug])
- uebergabe_datum (critical, date)
- kaeufer / verkaeufer (critical, structured, conditional on Eigentümerwechsel)
- mieter_in (critical, structured, conditional on Einzug)
- mieter_out (critical, structured, conditional on Auszug)
- vacant_possession_language_present (important, boolean) — Hofmann signal
- vacant_possession_language_excerpts (nice_to_have, structured_array)
- meter_readings (important, structured_array) — evidence baseline
- damages_noted (nice_to_have, structured_array)
- signatures (important, structured)

The schema's prompt_fragment_template embeds explicit Hofmann-safeguard
guidance: when in doubt, set uebergabe_typ="unklar". The Eigentümerwechsel
closure rule (in domain knowledge front-matter) is the structural backstop;
"unklar" is the SAFE default at extraction time.

**Pending (separate tasks):**
- Task 2.4: emitter dispatching on uebergabe_typ (with the Hofmann safeguard
  enforced in code)
- Task 2.5: Hofmann fixture test (the gate test)
- Inconsistency to resolve in Task 2.4: domain knowledge `closes` array uses
  `close_overlapping_only` for Eigentümerwechsel, but architecture §5.5.2
  specifies `close_overlapping_and_supersede_future`. Pick one when
  implementing the emitter; the architecture spec should win.

## Übergabeprotokoll emitter shipped (Task 2.4, 2026-05-28)

Third emitter. Dispatches on `uebergabe_typ` into four branches. The Hofmann
safeguard is now **structural code**: the Eigentümerwechsel branch has no code
path that produces a tenant-related closure intent.

**Files:**
- `src/lib/emitters/wohnungsuebergabeprotokoll.ts` — emitter
- `src/lib/emitters/index.ts` — registered in EMITTERS map (version "1.0.0")
- `src/tests/emitter-wohnungsuebergabeprotokoll.test.ts` — 82 assertions across
  6 scenarios

**Behavior:**
- **Einzug** → 1 `tenant_active` event claim (subject `unit:<unit_ref>`,
  value.tenants=[mieter_in], valid_from=uebergabe_datum), no closures
- **Auszug** → 1 `lease_terminated` event claim (subject `unit:<unit_ref>`,
  value.terminating_parties=[mieter_out]) + 4 closure intents on
  `unit:<unit_ref>` for predicates `kaltmiete`, `tenant_active`, `kaution`,
  `nebenkostenvorauszahlung`; `close_overlapping_and_future`,
  `close_at = uebergabe_datum`. tenant_active closure carries
  `match.tenant_identity = mieter_out.name` with `match_strictness="required"`;
  the other three use `match_strictness="absent"` (their value shapes have no
  `tenants[]` array, so a required tenant-identity match would filter every
  candidate out).
- **Eigentümerwechsel** → 1 `ownership_transferred` event claim (subject
  `"property"`) + 1 new `owner` assertion claim (subject `"property"`,
  value.owner=kaeufer, valid_from=uebergabe_datum) + 1 closure intent for the
  previous owner (target_predicate `owner`, `close_overlapping_and_supersede_future`,
  `close_at = uebergabe_datum - 1 day`, match.tenant_identity=verkaeufer.name
  with `match_strictness="optional"` since the shipped ClaimClosure.match
  shape has no dedicated owner_identity slot). **NEVER** closes tenant /
  kaltmiete / kaution / nebenkostenvorauszahlung claims.
- **unklar / unrecognized / missing required field** → empty EmissionResult
  (defers to triage; does NOT throw, unlike Mieterhöhung where missing
  new_kaltmiete is a hard error)

**Resolved inconsistency (Task 2.3 carry-over):** the domain knowledge file
(`closes` array, Task 1.4) declared `close_overlapping_only` for the
Eigentümerwechsel owner closure; architecture §5.5.2 / §5.5.3 specify
`close_overlapping_and_supersede_future`. The emitter uses the architecture
value — the previous owner is genuinely superseded by the new owner, so
`superseded_by_claim_id` preserves the ownership chain for audit. The
domain knowledge file should be aligned in a cosmetic follow-up.

**Hofmann safeguard, two layers:**
1. **Emitter:** the `emitEigentuemerwechsel` function in
   `wohnungsuebergabeprotokoll.ts` only ever constructs an `owner` closure.
   There is no flag or condition that gates tenant closures — those intents
   are simply never built.
2. **Applier:** `checkVacantPossessionWarning` in `claim-store/applier.ts`
   rejects any ownership→tenant closure as `vacant_possession_warning` (the
   backstop, verified in Scenario 7 of the applier tests).

**Verification:**
- 82 emitter assertions pass (6 scenarios incl. explicit Hofmann assertion)
- 32 purity assertions pass (no DB / fetch / fs / env in emitter)
- All other emitter, claim-store, and integration tests still pass
  (Mieterhöhung 46, Mietvertrag 37, applier 39, fuzzy 12,
  Everding end-to-end 25, supersession-cases 54)
- Tenant-isolation lint: 0 violations
- tsc clean

**Pending:**
- Task 2.6: PLZ verifier
- `owner_of_property` resolver (later — owner claims are emitted now but the
  resolver does not yet read them)
- Cosmetic follow-up: align `domain_knowledge/wohnungsuebergabeprotokoll.md`
  `closes` close_mode with the architecture value

## Phase 2 GATE PASSED — Hofmann case (Task 2.5, 2026-05-28)

The second of the two original v1 bugs is structurally fixed.

`src/tests/integration/hofmann-case.test.ts` runs two transactions against
HHS55 DG (per-transaction rollback, no production residue):

- **Positive (Transaction A):** an Eigentümerwechsel-Übergabeprotokoll
  (Bernhardt → Denn Immobilienverwaltung eGbR, handover 2025-11-15) transfers
  ownership — new `owner` claim created, previous owner closed with
  `valid_to = 2025-11-14` (`close_overlapping_and_supersede_future`) — but
  leaves Hofmann's `tenant_active` and `kaltmiete` claims ACTIVE.
  `rentForUnit(HHS55, DG)` still returns €900 with status
  `single_active_claim`. The Hofmann safeguard holds.
- **Negative control (Transaction B):** an Auszug for the same unit
  (Hofmann moving out, handover 2026-02-28) closes the `kaltmiete` and
  `tenant_active` claims. `rentForUnit` then returns `null` with status
  `no_claim_for_date` (the closed claim still exists in history, so the
  resolver distinguishes this from "no claim ever existed"). The system
  CAN close tenancy when appropriate — proving the positive result above
  is meaningful.

**Both original bugs now have verified structural fixes:**
- Weber (supersession): Task 2.2 (54 assertions across Paul / Kuru / Weber)
- Hofmann (ownership ≠ tenancy): Task 2.5 (22 assertions)

**Test-setup note:** HHS55 DG has pre-existing committed claims from the
real `20210412_Mietvertrag Dachgeschoss.pdf`. The test transaction first
runs a `valid_to = valid_from` UPDATE on them (allowed by the supersession
triggers, GoBD-safe) so the resolver sees only test-seeded state.
Transaction rollback restores production data.

**Reconciliation from brief:** the brief's draft asserted resolver status
`no_active_claim` after Auszug; the shipped resolver returns
`no_claim_for_date` whenever a closed claim still exists for
(subject, predicate) (`src/lib/resolvers/rent-for-unit.ts`). The brief's
sample owner-claim value shape (`{ name: "Bernhardt, ..." }`) was likewise
reconciled to the shipped emitter's `{ owner: { name, ... } }`.

**Phase 2 core thesis verified.** Remaining Phase 2: Task 2.1b
(Mietvertragsnachtrag), Task 2.6 (PLZ verifier).

## Mietvertragsnachtrag emitter live (Task 2.1b, 2026-05-28)

New doc_type `mietvertragsnachtrag` catches the ~15-20% of Nachträge that
change NON-rent terms (pet clauses, parking, deposit, ancillary cost, term,
party identity). Previously these were funneled into the Mieterhöhung
doc_type and either dropped (no `new_kaltmiete` → emitter throw) or, worse,
risked silent rent corruption when a stray figure was present. The split
makes the failure mode explicit: misclassified non-rent Nachträge surface in
triage rather than silently corrupting rent.

**Files shipped:**
- `domain_knowledge/mietvertragsnachtrag.md` — front-matter
  (default_claim_kind=reference, five gotchas, empty `closes` array — the
  rent_change closure is owned by the delegate, not declared here).
- `schemas/mietvertragsnachtrag/schema.yaml` — 14 fields: `nachtrag_scope`
  enum (7 values) + common fields (unit_ref, effective_date, tenant_identity,
  signatures, document_status) + six per-scope conditional structured
  payloads (rent_change, tenant_identity_change, deposit_change,
  ancillary_cost_change, term_change, usage_right_change) +
  `other_change_descriptor`. schema_version `2026-05-28-v1`. Generated
  outputs regenerated.
- `src/lib/emitters/mietvertragsnachtrag.ts` — pure function, no DB / fetch
  / fs / env. Dispatches on `nachtrag_scope`:
  - `rent_change` → reshape `rent_change_payload` + common fields into a
    Mieterhöhung-shaped envelope and DELEGATE to `emitMieterhoehungClaims`.
    Single source of truth for kaltmiete `close_overlapping_only`
    supersession — a bilateral rent-change Nachtrag and a unilateral §558
    notice produce byte-identical claim shapes and identical close edges
    (`effective_date - 1 day`).
  - `tenant_identity_change` / `deposit_change` / `ancillary_cost_change` /
    `term_change` / `usage_right_change` / `other` → ONE reference-kind
    `amendment_present` claim with `value.status =
    "unsupported_requires_review"` and the per-scope payload. NO closures.
    Critically, `tenant_identity_change` does NOT close `tenant_active` —
    the tenancy continues; only a party detail changes.
  - Missing or unknown scope → empty `EmissionResult` (defers to triage).
- `src/lib/emitters/index.ts` — `mietvertragsnachtrag` registered in
  EMITTERS map, version 1.0.0.
- `supabase/functions/process-document/index.ts` — classifier prompt
  amended additively: paragraph distinguishing `mieterhoehung` from
  `mietvertragsnachtrag` by WHAT the document changes, not by document
  title. `mietvertragsnachtrag` added to the example doc-types list.
- `src/tests/emitter-mietvertragsnachtrag.test.ts` — 47 assertions across
  5 scenarios: pet-clause (usage_right_change reference claim), tenant
  identity change (reference claim + explicit no-tenant-active-closure
  safety assertion), bilateral rent change (delegation produces Mieterhöhung-
  shaped result), misclassification rejection (non-rent envelope fed to
  Mieterhöhung emitter throws — the safe loud failure), determinism.

**Delegation safety property:** the rent_change branch produces Mieterhöhung
output by calling the Mieterhöhung emitter directly — not by reimplementing
its closure logic. If the Mieterhöhung emitter is ever updated, both paths
move together. The misclassification rejection test (Scenario 4) asserts
that feeding a non-rent envelope to `emitMieterhoehungClaims` throws on
absent `new_kaltmiete` — the safety property that protects against silent
rent corruption when Step 4 misroutes.

**Reconciliation from brief:**
- The brief's illustrative `closes` entry for the domain knowledge
  front-matter used keys (`trigger_predicate`, `delegates_to`) that do not
  match the shipped CloseEntry Zod contract (`src/tests/domain-knowledge.test.ts`:
  `target_predicate`, `target_subject_pattern`, `close_mode`, `when`,
  `valid_to_source`, `match_requirements`). The actual closure is produced
  by the Mieterhöhung emitter via delegation, so the shipped front-matter
  uses `closes: []` and documents the delegation in the body prose +
  `rent_change_delegates_to_mieterhoehung` gotcha. This is more truthful
  than declaring a malformed close entry.
- The brief's reference to `schemas/index.ts` registration was not applied:
  neither Task 2.1 (Mieterhöhung) nor Task 2.3 (Übergabeprotokoll) modified
  `V2_SCHEMA_DOC_TYPES`, and adding a doc_type there gates the v2 extraction
  path which is not yet wired for `mietvertragsnachtrag` end-to-end.
  Shipped pattern preserved.

**Verification:**
- emitter tests 47 assertions
- purity gate 40 assertions across 5 emitter files (the new emitter is
  picked up automatically by the directory walk; cross-emitter import
  `./mieterhoehung` is not flagged because mieterhoehung itself is pure)
- schemas test: 5 schemas validated
- domain-knowledge test: 5 files validated
- regression: all other emitter and integration tests still pass
  (Mietvertrag 37, Mieterhöhung 46, Übergabeprotokoll 82, Everding 25,
  Hofmann 22, supersession-cases 54)
- tenant-isolation lint: 0 violations
- tsc clean

**Pending:**
- Task 2.6: PLZ verifier
- Resolvers for `amendment_present` claims — at launch these are
  informational; no resolver consumes them yet.
- Multi-scope documents that change both rent and a non-rent term in one
  Nachtrag are deferred to a later task (flag for review).
- Adversarial fixture `nachtrag_misclassified_as_mieterhoehung_at_step4`
  as a full Step-4 classifier eval is a separate harness; this task
  verifies only the emitter's rejection behavior in unit tests.

## PLZ verifier shipped (Task 2.6, 2026-05-28) — Phase 2 COMPLETE

Deterministic verifier guarding against hallucinated German addresses (the
Kuru bug class). Static lookup of 8,298 valid German PLZs → Bundesland
(point-in-polygon of PLZ coordinates against dissolved official Bundesland
boundaries).

- data/plz-bundesland.json: 8,298 PLZ → Bundesland
- verifiers/plz.ts: checkPlz (pure core) + plzVerifier wrapper. On failure
  (PLZ not found OR Bundesland mismatch) → confidence "low",
  validation_status "requires_human_review" per §10. No model identifiers (§9.3).
- 28 assertions; the Kuru case (36270 — a non-existent PLZ) is structurally caught.

Runs on address-typed fields in extraction post-processing. Address fields are
not critical-severity in the launch slice, so the verifier may be dormant until
an address field is added — registered and unit-tested, ready when needed.

**Phase 2 COMPLETE.** Both original v1 bugs gate-tested (Weber 2.2, Hofmann 2.5);
Mieterhöhung, Übergabeprotokoll, Mietvertragsnachtrag emitters shipped;
supersession + Hofmann + PLZ guards in place. Next: Phase 3 (composer + brain
replacement).

## Composer core shipped (Task 3.1, 2026-05-28) — Phase 3 begins

The deterministic brain-replacement foundation (architecture §5.4.3). Pure
TypeScript: `src/lib/composer/property-snapshot.ts` assembles a
`PropertySnapshot { core, modules, metadata }` by dispatching requested
modules to a registry. No LLM, no prompts — the CI purity gate
(`src/tests/composer/composer-purity.test.ts`) enforces this. DB access via
Prisma is permitted (resolvers do the same); reasoning is not.

- `composePropertySnapshot({ property_id, org_id, modules }, { tx? }): Promise<PropertySnapshot>`
- `CorePropertySnapshot`: short_code, address, total_sqm, unit_count, unit_refs,
  org_id. Always composed from `Property` + `Unit` (unit_count is computed
  from the Unit table — `Property.unit_count` is nullable and unused).
- Module registry: rent_roll / ownership / insurance / costs / handover.
  Every module is registered as a stub returning `completeness: "unavailable"`
  with a `not_implemented` warning. Task 3.2 replaces the rent_roll entry with
  the real implementation; later tasks slot in the others.
- Unknown module names → `completeness: "unavailable"` + `unknown_module`
  warning (graceful — never throws on unknown names).
- Metadata: `composed_at` (ISO), `claim_snapshot_version` (stable SHA-256 over
  sorted relevant claim IDs — the cache-invalidation key per §5.4),
  `resolver_versions`, `completeness` per module, `warnings`.
- Writes one `warehouse.derivation_records` row per call with
  `output_type='property_snapshot'`, `composer_version='1.0.0'`,
  `input_claim_ids` (union over modules), `resolver_version` (comma-joined
  `name@version` pairs or NULL when no resolvers ran). Best-effort write
  (logs and returns on failure) mirroring the resolver's audit-row policy.
- Consumes the SHIPPED `ResolvedFact<T>` from `src/lib/resolvers/types.ts` —
  NOT the idealized §5.4.4 status enum. The composer is a pass-through for
  resolver output; status remapping is deliberately out of scope.

**DerivationRecord CHECK confirmed:** `output_type='property_snapshot'` is
already allowed by the Phase 0 claim-store migration
(`supabase/migrations/20260510080000_v2_claim_store.sql`). `composer_version`
column exists. No migration needed.

**Tests:** 31 assertions across 7 scenarios in
`src/tests/composer/property-snapshot.test.ts` (KO132 core, HHS55 core,
unknown module, rent_roll stub, hash determinism, derivation record write,
cross-org access denied). 16 assertions in the purity gate.

**Pending Phase 3:** 3.2 (rent_roll module — replaces the stub), 3.3
(dashboard renders from the composer), 3.4 (legacy brain shadow mode + kill
switch), 3.5 (presenter, LLM render-only). Blackstone-compatible projection
(§5.4.8) deferred until a surface needs it.

## Authoritative Unit inventory seeded (Task 3.1b, 2026-05-28)

Architecture decision: **unit existence is structural truth (Unit table); unit
facts are temporal truth (claims).** The rent_roll module (3.2) enumerates ALL
units from the Unit table and resolves each via `rentForUnit`; a unit with no
active claim is a VACANCY — a signal only an authoritative inventory can
surface. Claim-derived unit enumeration was rejected: vacant units produce no
claims and would be invisible, making Vermietungsquote / vacancy-detection
structurally impossible.

- Unit table seeded: KO132 {EG, 1.OG, DG}, HHS55 {1.OG, DG} — 5 units total
- Schema migration `supabase/migrations/20260528115252_add_unit_structural_fields.sql`:
  relaxed `sizeSqm` to nullable so unknown values can be stored as NULL (the
  spec forbids fabricating m²); added compound unique on
  (`propertyId`, `unitNumber`) for safe upsert and to prevent duplicates.
  `floor` (int?) and `rooms` (float?) already nullable. Prisma schema mirrored.
- Seed script `scripts/seed-units.ts` is idempotent (upsert keyed on
  `propertyId, unitNumber`) and also migrates the three legacy KO132 rows from
  German labels ("Erdgeschoss" / "1. Obergeschoss" / "Dachgeschoss") to the
  canonical `EG / 1.OG / DG` form in place — preserves Unit IDs so existing
  leases stay intact. Seeds the known values (KO132 1.OG = 100 m² / 3.5 Zi
  from the Everding Mietvertrag); leaves the four unknown size_sqm/rooms as
  NULL pending Nils. Re-runs are no-ops.
- **JOIN INVARIANT:** `unitNumber` holds canonical values (`EG`, `1.OG`, `DG`)
  matching claim subjects (`unit:<ref>`). Divergence would silently break
  `rentForUnit` and render occupied units as false vacancies. The seed script
  also asserts the invariant at run time by joining `warehouse.claims` against
  the seeded inventory and failing on any orphan `unit:*` subject.
- `composePropertySnapshot` now reports `KO132 unit_count = 3`,
  `HHS55 unit_count = 2`; the 3.1 test assertions were flipped accordingly
  (HHS55 from 0→2; both properties now also assert canonical `unit_refs`).

**Unblocks Task 3.2** (rent_roll module enumerates this inventory).

## RentRollSnapshot module shipped (Task 3.2, 2026-05-28)

The first real composer module. Enumerates every unit from the authoritative
Unit inventory (3.1b) and resolves each via `rentForUnit` (Task 1.10),
producing one row per unit — occupied or vacant. End-to-end proof: Lena's €650
now flows OCR → extraction → claim → applier → resolver → composer → row.

- `src/lib/composer/modules/rent-roll.ts`: `composeRentRoll(ctx) => ModuleResult`
- `RentRollRow`: `unit_ref`, `occupancy_status`, `vacancy_reason`,
  `current_kaltmiete` (passes the resolver's `ResolvedFact<Money>` through
  unchanged — value, status, confidence, source_claim_ids, source_document_ids,
  derivation_record_id, resolver version), structural passthrough
  (`size_sqm`, `floor`, `rooms`, `target_cold_rent` from the Unit table),
  and `tenant_active`.
- **Vacancy distinction** (a design requirement, mapped from resolver status):
  - `single_active_claim` → `occupied`
  - `no_claim_for_date` → `vacant` + `tenancy_ended` (closed claim in history)
  - `no_active_claim` → `vacant` + `no_data` (phantom vacancy — no lease on
    file; KO132 EG today)
  - `latest_active_claim_with_conflicts` → `needs_review` (resolver picked
    latest, but rent is ambiguous; excluded from `resolved_kaltmiete_total`)
- Summary: `total_units`, `occupied_units`, `vacant_units`,
  `needs_review_units`, `resolved_kaltmiete_total` (Money — sum of OCCUPIED
  rows only, conflict rows excluded so the headline number stays honest), and
  `vermietungsquote` (occupied / total).
- Registered in `MODULE_REGISTRY`, replacing the 3.1 `rent_roll` stub.
- `composePropertySnapshot` now passes `db` (`opts.tx ?? prisma`) into
  `ctx.tx` so modules always have a usable Prisma client.
- KO132 → 3 rows (EG vacant/no_data, 1.OG carries Lena's €65000 cents,
  DG depends on shipped claims); HHS55 → 2 rows.
- **`tenant_active` typed-but-unavailable.** No `tenantForUnit` resolver
  exists yet. Per the architectural rule "don't duplicate resolver logic
  outside the resolver layer," the column is populated with a sentinel
  `{ status: "unavailable", reason: "no_tenant_resolver", resolver: { name: "tenant_for_unit", version: "unshipped" } }`
  and the module emits a `tenant_resolver_unavailable` warning. **Follow-up
  task:** ship a `tenantForUnit` resolver and swap the sentinel for a real
  `ResolvedFact<Tenant>`.

**Vermietungsquote falls out for free** — total/occupied is computable only
because the inventory is authoritative (3.1b). The roadmap's
"vacancy-detection / Vermietungsquote" feature lands here as a side effect of
correct architecture, ahead of schedule.

Tests: `src/tests/composer/rent-roll.test.ts` — 46 assertions across
KO132 full roll (occupancy, provenance, phantom vacancy, structural
passthrough, tenant sentinel, module aggregation), HHS55 (2 rows),
provenance-on-resolved-rows, the full `mapOccupancy` mapping table (every
resolver status including a defensive fallback), summary math, and
registry-replacement (no `not_implemented` warning, completeness not
`unavailable`).

**Unblocks Task 3.3** (dashboard renders the rent roll with click-through
provenance to claims and documents).

## Dashboard rent roll renders from composer (Task 3.3, 2026-05-28)

The first customer-facing surface that renders from resolved facts instead of
the legacy `document_intelligence` brain. Lena Everding's €650 now appears as
a clean row on `/dashboard/warehouse` with a click-through provenance modal
naming the source Mietvertrag.

- `src/lib/dashboard-actions.ts` adds `getRentRollSnapshots()`: composes
  `RentRollSnapshot` per property via `composePropertySnapshot({ modules:
  ["rent_roll"] })` and side-loads provenance (document file_name / doc_type
  / category for `source_document_ids`; valid_from / confidence /
  source_field_path for `source_claim_ids`). Legacy `document_intelligence`
  tenants are returned alongside as a per-(property, unit_ref) fallback map.
- `src/components/warehouse/rent-roll-composer.tsx`: one row per unit from
  the composer.
  - `occupied` → kaltmiete as a click target (provenance modal); confidence
    chip if not high.
  - `vacant + no_data` (phantom vacancy) → "Kein Mietvertrag hinterlegt"
    with an actionable upload affordance (`data-action="upload-lease"`,
    links to the existing property page). KO132 EG.
  - `vacant + tenancy_ended` → "Leerstand".
  - `needs_review` → "Prüfen" chip; excluded from the displayed total.
  - Composer-first / legacy-fallback: if the composer has no value but the
    legacy brain has a tenant for the same unit_ref, the cell renders the
    legacy amount with a small "Legacy" tag. The legacy read is the
    dark-launch safety net and is removed after 3.4 shadow mode proves
    parity.
  - Vermietungsquote rendered as an understated header stat
    (`data-testid="vermietungsquote-stat"`), not a hero number — at 5 units
    a single vacancy swings it 20 points.
- `src/components/warehouse/provenance-modal.tsx`: opens on cell click.
  Shows the resolved value, confidence + status, the source document(s)
  (file name, doc_type, category, link into the inbox), and the claim chain
  (first claim marked ★, claim id prefix, source_field_path, valid_from).
  Resolver name@version printed at the bottom. This is the visible
  embodiment of "evidence chains as legal shields."
- `tenant_active` is rendered as a gracefully-absent "—" — no fake data.
  Wiring the real tenant column waits for the tenant resolver follow-up.
- Loading skeleton at
  `src/app/(dashboard)/dashboard/warehouse/loading.tsx` while the composer
  runs.
- `data-testid="warehouse-properties-loaded"` preserved on the same
  PropertySelection root — the Tier B synthetic monitor invariant is intact.
- The legacy brain-driven "Mietübersicht" sub-table inside the
  Immobilien-Analyse card has been removed (replaced by the composer-driven
  section above it). The brain card still renders the property overview
  summary, risks, and urgent action.
- Wiring a NEW upload action is out of scope; the row carries the hook for
  the follow-up.

Tests: `e2e/rent-roll-composer.spec.ts` — warehouse-properties-loaded
testid present, KO132 1.OG Lena €650 visible, clicking €650 opens the
provenance modal with a source document, KO132 EG renders the phantom
vacancy CTA, Vermietungsquote stat present.

**Unblocks Task 3.4** (composer / legacy brain shadow-mode parity check,
then legacy fallback removal).


## Task 3.3 shipped — first customer-facing surface from the composer (2026-05-28)

The dashboard rent roll at /dashboard/warehouse now renders from
composePropertySnapshot(rent_roll) instead of document_intelligence. The
three product decisions held in implementation: composer-first with legacy
fallback ("Legacy" cell tag during 3.4 transition), phantom vacancy as
actionable worklist item ("Kein Mietvertrag hinterlegt" + upload affordance),
understated Vermietungsquote. Lena Everding's €650 appears as a clean row
with click-through provenance (underlined value links to source document).
EG renders as phantom vacancy (no claim ever ingested).

The trust proposition ("evidence chains as legal shields") becomes tangible
here: every resolved number traces to its source document in one click.

**Follow-ups surfaced by 3.3 (not blocking merge):**

1. **Top stat bar still legacy-sourced.** The dashboard header still shows
   100% Vermietungsquote / €3.595/Monat — sourced from the legacy aggregate,
   contradicted by the composer's 33% / €650 directly below. Two paths:
   migrate top stats to composer (right long-term answer; needs an
   org-level aggregate snapshot, not just per-property rent_roll), or
   label them "Legacy" until 3.4 retires the legacy read. Decide in 3.4.

2. **DG renders as phantom vacancy despite known Kuru claim.** We have a
   €470 Saniye Kuru claim for KO132 DG in the test fixtures, but the
   dashboard shows DG as "Kein Mietvertrag hinterlegt." Same class as EG —
   the v2 claims pipeline has no kaltmiete claim for unit:DG in the live
   data, only in test fixtures. The rent roll is correctly surfacing the
   ingestion gap. Action: ingest Kuru's lease through the v2 pipeline (or
   verify why her real lease document hasn't produced a claim).

3. **The "Mietübersicht" duplication.** Both the composer rent roll AND
   the legacy Immobilien-Analyse render on the same page. 3.4 shadow mode
   keeps them parallel by design; once parity is proven, the legacy
   Mietübersicht table is retired (the narrative/insights from the legacy
   brain may stay until 3.5 replaces with the deterministic Presenter).

4. **Upload-action wiring.** The phantom-vacancy upload affordance has a
   data hook (`data-action="upload-lease"`) but is not yet wired to the
   upload flow. Small follow-up.

## Cleanup note (2026-05-28)

KO132 1.OG had 3 identical €650 kaltmiete claims from re-processing the same
Lena document across 3 extraction runs during May 25 bridge debugging.
Manually cleaned: kept canonical run 883934f6 (claim 8fd74446), superseded
the two duplicates via direct UPDATE (superseded_at + superseded_by_claim_id
pointing at canonical) since no GoBD correction flow exists yet. Latent bug:
the applier dedups only on source_extraction_run_id, so re-processing the
same document stacks duplicate active claims. Fix before first customer:
dedup on (source_document_id, subject, predicate, value, valid_from).


## Brain shadow mode shipped (Task 3.4, 2026-05-28)

Parallel-run safety net. A nightly GitHub Actions job
(`.github/workflows/brain-shadow-comparison.yml`, 02:00 UTC) runs the composer
and legacy brain side-by-side per property, classifies divergences, writes
them to `warehouse.brain_shadow_comparison`, and posts a Discord alert when
any divergence falls into the alert classes
(`kaltmiete_amount_mismatch`, `composer_missing_unit`, `unknown`).

The framing: shadow mode is NOT "wait for identical output." Composer and
legacy SHOULD diverge in known ways (composer is more honest about ingestion
gaps; composer rejects bad data legacy accepted). Stable = every divergence
falls into a known class. Unknown classes alert.

**Known informational classes** (no Discord):
- `composer_vacant_legacy_occupied` — ingestion gap. Composer correctly says
  "no lease on file"; legacy hallucinated occupancy from stale data.
- `composer_occupied_legacy_vacant` — legacy stale.
- `legacy_missing_unit` — legacy didn't know about a unit in the inventory.
- `vermietungsquote_mismatch`, `total_kaltmiete_mismatch` — aggregate math
  consequences of the per-unit differences (composer denominator includes
  unclaimed units; legacy had no inventory-as-truth).

**Alert classes** (Discord summary posted with run timestamp and counts):
- `kaltmiete_amount_mismatch` — both sides occupied, different rent.
- `composer_missing_unit` — composer's Unit table lacks a unit legacy knew.
- `unknown` — genuinely unclassified.

**First run results (2026-05-28T20:28Z, 2 properties):** 7 divergences total,
0 alerts. KO132 EG + DG classify as `composer_vacant_legacy_occupied`; the
33%-vs-100% Vermietungsquote case classifies as `vermietungsquote_mismatch`.
The three already-known divergences from 3.3 are recorded as informational.

**Files:**
- `supabase/migrations/20260528201627_brain_shadow_comparison.sql` (table + RLS)
- `scripts/brain-shadow-comparison.ts` (the job)
- `scripts/lib/brain-shadow-classify.ts` (pure classifier; 42 test assertions)
- `scripts/lib/discord-notify.ts` (thin webhook POST; no-op without secret)
- `src/lib/legacy-brain/extract-tenants.ts` (parser extracted from
  dashboard-actions for reuse by the job; dashboard-actions imports from here)
- `src/tests/scripts/brain-shadow-classify.test.ts`
- `.github/workflows/brain-shadow-comparison.yml`

After ~30 days of stable comparison, the legacy brain can be retired
(separate task, post-launch). The most likely future trigger of a
`kaltmiete_amount_mismatch` alert is the latent applier dedup bug (same-
document reprocessing → duplicate active claims → conflict status →
ambiguous amount); should be fixed pre-customer.

**Unblocks Task 3.5** (presenter, LLM render-only).


## Presenter shipped (Task 3.5, 2026-05-28) — Phase 3 COMPLETE

The third leg of the v2 three-component architecture. Composer assembles
facts deterministically; resolvers produce `ResolvedFact<T>`; **Presenter
turns those into German prose with provenance, no reasoning.**

- `src/lib/presenter/render.ts`: `renderResolvedFact(fact, hints?)`,
  `renderPropertySnapshot(snapshot, hints?)`. Returns German prose strings.
  Library — NOT a server action; no `"use server"` directive.
- `src/lib/presenter/prompts.ts`: system prompt is the safety boundary.
  Enumerates the v1 brain failure modes as forbidden behaviors (Hofmann:
  inventing "vacant" from incomplete data; rent roll: silently picking one
  of two competing claims).
- `src/lib/presenter/types.ts`: `RenderHints { documents?: DocumentHint[] }`.
  Callers resolve `source_document_ids` → `doc_type` before calling the
  presenter; the presenter never touches the DB. Without hints the prose
  uses "der hinterlegten Quelle" generically; with hints it can name the
  document type ("laut hinterlegtem Mietvertrag").
- Anthropic Sonnet (`PRESENTER_MODEL = "claude-sonnet-4-6"`);
  `PRESENTER_VERSION = "1.0.0"`. Model id is centralised at the top of
  `render.ts` so swapping is a one-line change.
- Hard prompt boundary: no inventing values, no resolving conflicts, no
  reading OCR/claims, no choosing between competing values, no commentary,
  no currency normalization. JSON values are treated as data, not
  instructions (prompt-injection resistance).
- Purity gate `src/tests/presenter/presenter-purity.test.ts`: forbids
  `@/lib/db`, `@/lib/claim-store/*`, `@/lib/extractions/*`,
  `@/lib/emitters/*`, `@/lib/supabase/*`, `@supabase/supabase-js`,
  `prisma`, `@prisma/*`, `node:fs` / `fs`. Imports from
  `../resolvers/*` and `../composer/*` are forbidden EXCEPT `import type`
  from `../resolvers/types` and `../composer/types`. Forbids `fetch(`
  literal and any `"use server"` directive. 44 assertions across the
  three presenter files.
- Acceptance test `src/tests/presenter/render.test.ts`: Lena Everding
  fact (€650, Mietvertrag, 01.04.2025) + KO132 full snapshot (3 units, 1
  occupied / 2 phantom-vacant, 33 % Vermietungsquote) + HHS55 minimal +
  empty-modules. 17 live LLM assertions.
- Adversarial fixture set `src/tests/presenter/fixtures/*.json` (8
  fixtures, the acceptance test of the safety boundary): vacant no-data
  phantom vacancy, conflict (two competing claims), low-confidence,
  missing sqm, all-modules-unavailable, currency preservation (USD
  not silently converted to EUR), prompt-injection resistance,
  needs-review. Each fixture asserts both required substrings
  (case-insensitive, tolerant) and forbidden substrings/regexes (strict —
  a single leaked invented value fails the test). 56 assertions total.

**Phase 3 COMPLETE.** v2 chain runs OCR → extraction → claim → applier →
resolver → composer → **presenter** → German prose. Legacy brain still
runs in shadow mode (Task 3.4); after ~30 days of stable comparison it can
be retired.

**Out of scope (follow-ups):**
- Dashboard / chat surfaces consuming the presenter (separate tasks per
  surface; the renderer is ready, UIs adopt it next).
- Caching layer keyed on `(claim_snapshot_version, PRESENTER_VERSION,
  sha256(payload))`. Boundary noted in `render.ts` as a comment; uncached
  at v1 by design (premature caching hides correctness issues).
- A tenant resolver that would let `renderResolvedFact` name the active
  tenant. Until shipped, `tenant_active` is rendered as "Mieterdaten nicht
  verfügbar".
- Streaming. v1 returns the complete string.
- i18n / English locale. German only at launch; when next-intl ships the
  presenter splits per locale.
- Shadow rendering against the legacy brain narrative (could be a 3.4-style
  follow-up; not in 3.5).

**Server-side Anthropic SDK confirmation:** `@anthropic-ai/sdk` is already
a dependency at `^0.82.0`. The Edge Function uses a Deno-flavored client
(`supabase/functions/process-document/anthropic-client.ts`) that does NOT
run in Node; the presenter uses the canonical Node import. The two clients
stay independent by design.

---

## Phase 3 COMPLETE (2026-05-28)

The v2 three-component architecture is fully wired end-to-end:

  Document → OCR → Extraction (Sonnet) → Envelope → Emitters → Applier
    → Claim Store (GoBD append-only) → Resolvers (ResolvedFact<T>)
    → Composer (PropertySnapshot) → **Presenter (German prose)**

What this means for the product:
- The dashboard rent roll renders from composer output, not from
  document_intelligence. Lena Everding's €650 traces, in one click, to the
  source Mietvertrag. The trust proposition (evidence chains as legal
  shields) is now tangible to the user.
- All units are visible — occupied, vacant-tenancy-ended, and phantom-vacant
  ("no lease on file → upload"). The rent roll is a worklist, not a report.
- Vermietungsquote falls out for free from the inventory-as-truth decision
  (3.1b). Currently shown understated.
- Legacy brain still runs in shadow mode (3.4), but only as a comparison
  signal — customer-facing surfaces read composer only.

**Tasks completed in Phase 3:**
- 3.1   Composer core (PropertySnapshot, registry pattern)
- 3.1b  Unit inventory as authoritative structural truth
- 3.2   RentRollSnapshot module (phantom vs real vacancy distinction)
- 3.3   Dashboard renders from composer with provenance click-through
- 3.4   Shadow-mode nightly comparison (composer vs legacy, alert classes)
- 3.5   Presenter — LLM render-only with hard prompt boundary + adversarial
        fixtures + purity gate

The PR numbering for the record: #51 (3.1b), #52 (3.2), #53 (3.3), #54 (3.4),
#55 (3.5) all on main.

## 30-day shadow-mode countdown started (2026-05-28)

The legacy brain (scripts/generate-brain.js) continues to run on its existing
schedule and write to property_intelligence. The nightly comparison job runs
at 02:00 UTC, classifies divergences, and posts Discord alerts only on alert
classes (kaltmiete_amount_mismatch, composer_missing_unit, unknown).

Current known divergences classify as informational and do NOT alert:
- KO132 EG, KO132 DG: composer_vacant_legacy_occupied (legacy knows the
  tenant from document_intelligence; composer correctly shows phantom
  vacancy because no claim was ever ingested for those units)
- Top dashboard stats (100% Vermietungsquote, €3.595/Monat): legacy-sourced;
  composer says 33% / €650. Recorded as vermietungsquote_mismatch and
  total_kaltmiete_mismatch — informational.

After ~30 days of stable comparison (no unexplained divergence class), the
legacy brain can be retired (separate post-launch task).

## Today's-lessons follow-ups (record for pre-customer fixes)

### Presenter minor-units inconsistency (Task 3.5 follow-up)

The presenter prompt's amount-formatting rule is currency-specific (EUR
examples). LLM correctly renders amount: 65000 EUR → 650,00 € (divides by
100), but for USD renders 65000 → 65.000 USD (treats as literal, no
division). Surfaced by adversarial-mismatched-currency fixture.

The LLM should never do arithmetic. Fix: pre-format the amount in the caller
(server action) and pass a formatted string to the presenter. Prompt only
needs to render strings, not interpret minor-units conventions.

Small v1.1 task before any non-EUR property onboards.

### Test-assertion discipline (Task 3.5 lessons)

Lessons codified by adversarial fixtures and the render.test.ts HHS55 incident:

- **Positive assertions tolerant.** Accept any honest phrasing the LLM
  legitimately produces. The empty-modules positive check only matched
  "keine moduldaten" / "keine daten" verbatim; LLM said "keine weiteren
  Moduldaten vorhanden" — equally honest, missed by the check. Broaden lists
  to include legitimate variations.

- **Negative assertions precise about invention, not broad against
  vocabulary.** Forbid specific tenant names ("Julija", "Saniye"), specific
  monetary values via regex (\d+,\d{2}\s*€), and occupancy *assertions*
  ("vermietet an", "ist Mieter"). Do NOT forbid vocabulary roots
  ("Mieter", "Mietvertrag", "Kaltmiete") — these are legitimate domain
  words the presenter must use in section headers like "Mieterliste: nicht
  verfügbar."

- **Fixtures must use real data, not fake data labeled with real
  identifiers.** The HHS55 fixture passed structural assertions while
  containing completely fabricated address, units, and sizes — because the
  assertions never checked facts. Integration-style fixtures use real
  composer output where possible; synthetic fixtures should not use real
  property short_codes/IDs.

### Applier dedup-by-identity fix shipped (2026-05-29, Tier 0 gate)

The applier no longer dedups on source_extraction_run_id alone. Identity for
a fact is now (source_document_id, subject, predicate, value, valid_from) —
re-processing a document is structurally idempotent.

`src/lib/claim-store/applier.ts`:
- `findExistingClaim` keys on (source_document_id, subject, predicate,
  valid_from) and filters `valid_to IS NULL AND superseded_by_claim_id IS NULL`
  (currently-active claims only). Value equality computed in SQL via Postgres
  `jsonb = jsonb` (canonical: sorted keys, normalized whitespace, numeric
  scalars compared by value).
- Insert loop:
  - identical re-emission (value matches) → skip, no insert, no UPDATE to
    superseded_at (true no-op).
  - same identity, value differs → insert new claim AND supersede the prior
    active claim via the existing `applyClosure` path with
    `close_overlapping_and_supersede_future` (sets valid_to, superseded_at,
    superseded_by_claim_id, writes claim_closures audit row). Exactly one
    active claim remains per fact.
- Human adjudication path (`source_extraction_run_id IS NULL`) is unchanged —
  no dedup, by design.

Test: `src/tests/integration/applier-dedup.test.ts` — 26 assertions on real
Lena fixture, three cases per the task brief (first apply, identical re-apply,
value-corrected re-apply). Per-test Prisma transaction rollback (GoBD blocks
DELETE).

Out of scope (separate tasks): partial unique index migration enforcing this
at the DB layer; backfill/supersession of pre-existing duplicate active claims
in production (Lena KO132 1.OG had 3 duplicates manually cleaned 2026-05-28).

### Operational lesson: where browser judgment happens

Several hours today were lost to viewing the Vercel production deployment
while believing it was the local dev branch. Then to viewing localhost on
the laptop while the dev server ran on the Mac Mini. Then to viewing the
Tailscale URL without local session cookies (Unauthorized).

For any browser judgment going forward, the simplest path is the Vercel
preview URL auto-deployed for each PR — it's authenticated against the
production session, no localhost dance, and shows exactly what the merge
would produce. The auto-deploy comments on the PR with the link.


## Task 4.1b — Live extract path wired (Sonnet) + real-case OCR inputs (2026-05-31)

- `scripts/eval/extractor.ts`: Node-callable Sonnet Step 8b extractor. Production extractor (supabase/functions/process-document/index.ts) is Deno/HTTP-only, so the eval harness re-hosts the core extraction logic. SHARES production's generated prompt_fragment, envelope_validator, and verifiers (single source of truth). DUPLICATES V2_CONFIGS (field specs + verifier refs) and the system-prompt wrapper — drift risk.
- `scripts/eval/run.ts`: extract mode runs real Sonnet extraction (Sonnet only; Opus deferred to 4.5), gated behind --live + --fixture-cap, errors cleanly for fixtures lacking source.txt or an extractor config. Candidates written to eval/candidates/<ts>/.
- source.txt added for the 5 real cases (real OCR). Supersession cases (Paul/Kuru/Weber) ground only partially from one document — full multi-document grounding deferred to Task 4.3. Lena (mietvertrag) is the verified DoD path.
- Mocked wiring test (src/tests/eval/extract-wiring.test.ts, 20 assertions) is the CI-safe gate; live Sonnet smoke is manual/out-of-CI.
- Task 4.2a: CI now executes the four DB-free eval tests (see Task 4.2a entry below).

## Task 4.1b-followup — extractor.ts config drift eliminated (2026-05-31)

- `scripts/gen-schemas.ts` now emits a fourth generated artifact per doc type: `schemas/<doc_type>/generated/field_specs.ts` (`FIELD_SPECS` + `VERIFIER_REFS`, driven from schema.yaml). `npm run gen:schemas:check` (CI: generated-files-fresh.yml) guards it against drift.
- `scripts/eval/extractor.ts`: the hand-maintained V2_CONFIGS fieldSpecs + verifierRefs are GONE — both now import from the generated field_specs.ts. The eval harness's extractor config can no longer silently diverge from the schema source of truth. Behavior-identical to the old hardcoded table (existing extract-wiring/metrics/score-smoke tests pass unchanged).
- The German system-prompt wrapper still lives in Deno index.ts (cannot be cleanly imported into Node), so extractor.ts keeps a verbatim copy. New drift-guard test `src/tests/eval/extractor-drift.test.ts` (4 assertions) reads both source files and asserts the wrapper byte-matches (modulo `${...}` interpolation names), plus asserts the schema-driven FIELD_SPECS/VERIFIER_REFS equal the expected mietvertrag set.
- Out of scope (unchanged): production index.ts still hardcodes its own V2_PROMPTS/V2_VERIFIER_REFS copy. (CI execution of the eval tests landed in Task 4.2a, below.)

## Task 4.2a — DB-free eval tests wired into CI (2026-05-31)

- `.github/workflows/ci.yml` gains an `eval-tests` job that runs on every `pull_request`. It executes the four DB-free eval harness files via `npx tsx`: `src/tests/eval/metrics.test.ts`, `score-smoke.test.ts`, `extract-wiring.test.ts` (fully mocked `ExtractorDeps` — no live model), and `extractor-drift.test.ts`. The eval regression net is now a real CI gate, not local-only.
- No secrets: the job needs no Supabase env, no `DATABASE_URL` for the tests, and no `ANTHROPIC_API_KEY`. The only `DATABASE_URL` is a dummy passed to `npm ci` for the prisma generate postinstall, mirroring the existing `check` job. Verified all four pass under a fully stripped environment.
- Out of scope (deferred): integration/DB eval tests (applier-dedup, tenant-for-unit, everding-end-to-end) need DB secrets and are a separate task; the evidence-grounded metric / `evid` gate and gold-set/fixture-layout work remain in Task 4.3; live extraction is never run in CI.

## Task 4.2b — score skips fixtures with no candidate (2026-05-31)

- `scripts/eval/run.ts` (`computeScore`): a fixture whose candidate envelope is missing is no longer scored field-by-field against an empty envelope (which marked every field a miss — the misleading 0.96 error rate). Such fixtures are collected into `result.skipped_no_candidate`; aggregates are computed over scored fixtures only. Scoring of fixtures that have a candidate is unchanged.
- CLI prints `scored=N skipped(no candidate)=M` plus the skipped fixture_ids.
- New test `src/tests/eval/score-skip.test.ts` (3 fixtures, candidate for 1: asserts scored=1, skipped=2, aggregate equals the single scored fixture's rates), wired into the `eval-tests` CI job.

## Task 4.2c — `--fixture-id` substring targeting in the eval CLI (2026-05-31)

- `scripts/eval/run.ts` gains a `--fixture-id <substr>` flag, valid in BOTH `score` and `extract` modes. It keeps only fixtures whose `fixture_id` CONTAINS `<substr>` (case-sensitive substring), so a single case (e.g. Lena) can be targeted directly instead of via the order-dependent `--fixture-cap`. AND-composes with `--split`/`--doc-type`, and is applied BEFORE `--fixture-cap` in extract mode. Exported pure helper `applyFixtureId(fixtures, substr)` does the filtering. Zero matches is a hard error (`no fixture matches --fixture-id <value>`, then lists the available fixture_ids for the active doc-type) and exits non-zero — never a silent no-op. No change to scoring/metric math or the skip-on-missing logic.
- New test `src/tests/eval/fixture-id.test.ts` (DB-free, API-free, runs against real on-disk fixtures): a narrow substring selects exactly the expected fixture(s), a broad substring returns all matches, and a zero-match throws with the message + available-id list. Wired into the `eval-tests` CI job (now six DB-free eval files).

## Task 4.3a — evidence-grounding GRADE v1 (scalar fields, 0–3) (2026-06-04)

- Replaces the verbatim-quote intuition of the legacy `evid` metric with a field-aware, same-page, local-window grounding **grade (0–3)** for direct scalar fields, computed in `scripts/eval/metrics.ts` (`groundingGrade`) — pure, deterministic, DB-free, API-free, no Sonnet, no re-extraction.
  - 3 = value in a same-page local window AND a field-specific label/anchor in that window; 2 = value in window, no field label nearby (or `evidence.page` missing on a CRITICAL field → capped at 2); 1 = value somewhere in OCR but not in the scoped page/window; 0 = value not in OCR.
  - Windows are SAME PAGE ONLY (parsed from the `--- Seite N ---` OCR markers via `parseOcrPages`): direct ±5 lines plus a table-tolerant header lookback of the previous 10 lines. When candidate evidence carries a page, the value search is restricted to it.
  - Value normalization (`valueSurfaceForms`): money `650,00 = 650.00 = 650 = 1.950,00`; dates ISO → `01.04.2025`/`1.4.2025`/`1. April 2025`.
- **Value vs evidence split, never collapsed**: `normalized_match` (value-correctness) is unchanged; the grade is reported separately, per-field and aggregated (`scoreFixture` → `DocTypeMetricSummary.grounding`; `run.ts` per-doc-type `grounding_grade_mean`/`_rate`/`grade3_rate`/`graded_count`). The legacy `evidence_grounded` boolean is retained so the existing six eval tests stay byte-stable.
- **Label sets are schema-sourced, never hardcoded**: new optional `grounding_labels` (field-specific anchors) and `derived` keys in `schemas/<doc_type>/schema.yaml`, emitted by `scripts/gen-schemas.ts` into a new `GROUNDING_SPECS` export in each `generated/field_specs.ts` (FIELD_SPECS unchanged → extractor-drift deep-equal still holds; `gen:schemas:check` regenerated). `kaltmiete` grounds on Kaltmiete/Grundmiete/Nettokaltmiete/Nettomiete but NOT Miete/Monatsmiete/Gesamtmiete/Warmmiete (letter-boundary matching). The extraction prompt, envelope validator, and extracted field set are untouched.
- **Derived fields out of scope (deferred to 4.3c)**: `unit_ref` (and any composite/derived field) is marked `derived: true` → `derived_pending`, excluded from the grounding aggregate, no grade assigned. Structured fields (tenant/landlord_identity) were `non_scalar` in v1 and likewise excluded — **superseded by Task 4.3a-names**, which grades them via person/company grounding (see below).
- Lena Everding re-score (`eval/candidates/lena2`, no re-extraction): present scalar fields reach grade 3 — kaltmiete grade 3 (label Grundmiete, page 3), mietbeginn grade 3 (label Mietzeit, page 2); unit_ref = derived_pending.
- New test `src/tests/eval/grounding-grade.test.ts` (45 assertions: each grade, same-page constraint, kaltmiete label-trap, table-header lookback, critical-field cap, derived/non-scalar exclusion, generated-spec label sets), wired into the `eval-tests` CI job (now seven DB-free eval files).

## Task 4.3a-names — person/company grounding for identity fields (2026-06-04)

- `tenant_identity` & `landlord_identity` — the two most audit-critical fields in a tenancy document — now carry the SAME 0–3 grounding grade as the 4.3a scalar path. Routed through a person/company grounding path in `scripts/eval/metrics.ts` (`gradeIdentity`), still pure/deterministic/DB-free/API-free: **no schema/extractor change, no re-extraction, no Sonnet**. The `non_scalar` exclusion is bypassed for these two fields when the candidate carries an identity-shaped value; a present-but-malformed value still falls through to `non_scalar`, and an absent value is excluded as `absent`. `unit_ref` and true composite fields remain `derived_pending` (4.3c).
- **Identity value-match**: person = surname core token + ≥1 disambiguating token (given name/initial), tolerant of `"Surname, Given"` vs `"Given Surname"` order and umlaut folding (`Müller == Mueller`, ä→ae/ö→oe/ü→ue/ß→ss). Company = distinctive core token(s) + accepted/normalized legal-form suffix (GbR/GmbH/UG/KG…), e.g. `Denn & Denn Verwaltungs GbR`. Value/number label sourcing is unchanged from 4.3a.
- **Anchor = ROLE label, not a generic synonym** (same same-page ±5 / prev-10 window as 4.3a): `tenant_identity` grounds on Mieter/Mieterin/Mietpartei/Vertragspartner; `landlord_identity` on Vermieter/Vermieterin/Eigentümer/"vertreten durch". A field grounds on ITS side's roles only — a tenant name sitting under **Vermieter** cannot reach grade 3 (role-mismatch → grade 2). Positive role sets are sourced from the generated `GROUNDING_SPECS` where available and filled in by an explicit, documented per-field role map in `metrics.ts` (`IDENTITY_ROLE_ANCHORS`, which also records the wrong-side/negative roles); value-label sourcing stays in the generated specs.
- **Signature-only = weak**: a bare signature-block name (value present, no role label in the window) is grade **2**, never 3 — a signature alone is not sufficient grounding. The 4.3a critical-field cap still applies (missing `evidence.page` on a critical identity → capped at 2).
- Lena Everding re-score (`eval/candidates/lena2`, no re-extraction): `tenant_identity` grade 3 (label Mieter, page 1), `landlord_identity` grade 3 (label Vermieter, page 1); `unit_ref` = `derived_pending`. The fixture's grounding roll-up now grades 4 fields (kaltmiete, mietbeginn + both identities), all grade 3.
- `src/tests/eval/grounding-grade.test.ts` extended to **63 assertions** (all prior 45 unchanged-green + 18 identity: Mieter/Vermieter grade 3, the Vermieter role-mismatch trap, company-name+GbR grounding, the lone-surname non-match, signature-only grade 2, grade 0, umlaut normalization, "Given Surname" order, the critical cap, and the non-identity/absent exclusions). Same `eval-tests` CI job.

## Task 4.3b — per-envelope source resolution + gold-self-grounding invariant (2026-06-04)

- **Per-envelope source resolution (loader, Option B — preserve fixture_ids, additive)**: `scripts/eval/loader.ts` (`resolveEnvelopeSources`) now resolves each gold envelope's source OCR/PDF independently, NOT per case_dir. Order: (1) a dedicated `<envelope_basename>.source.{txt,pdf}` next to the envelope (e.g. `mietvertrag.source.txt` beside `mietvertrag.json`); (2) if the dir holds exactly ONE gold envelope, fall back to the dir's shared `source.txt`/`ocr.txt`/`source.pdf`; (3) otherwise `source_text_path = null`. Fixes the proven bug where multi-envelope case dirs shared one `source.txt`, so secondary envelopes scored against the WRONG document's OCR (Hofmann's mietvertrag gold scored 0.00). Dirs are NOT renamed and `fixture_id`s are unchanged; existing shared `source.txt` files are NOT deleted. Lena (single-envelope dir) keeps resolving to her own `source.txt`; hofmann (3 envelopes) and the three supersession dirs (2 each) resolve to null until WS3 backfills per-doc OCR. The gold-envelope COUNT that drives the single-dir fallback is computed over ALL gold envelopes in the dir, independent of the `docType`/`split` filters.
- **`pending_source` semantics**: a gold envelope whose source resolves to null is `pending_source` — NOT a scoring/invariant failure. It means per-document OCR is not yet labeled (deferred to WS3 — Nils labels), not that the gold is wrong.
- **Gold-self-grounding invariant (new CI test)**: `src/tests/eval/gold-grounding.test.ts` runs over all gold fixtures. For every envelope WITH a non-null resolved source it asserts that every PRESENT, NON-DERIVED field grounds at **grade 3** in that envelope's OWN source (using the 4.3a / 4.3a-names `groundingGrade`). Skipped (not failures): fields with `absence_state` != `present`; derived fields (`unit_ref` etc. → 4.3c); non-gradeable fields (no grounding spec / excluded `non_scalar`); and whole envelopes whose source is null (reported `pending_source`). A field below grade 3 is a HARD failure (gold value does not ground in its own source). DB-free, API-free, no Sonnet, no re-extraction.
- Result today: `asserted_envelopes=1` (Lena — her present non-derived fields kaltmiete/mietbeginn/tenant_identity/landlord_identity all grade 3), `pending_source=9` (hofmann ×3 + supersession ×6), `failures=0`. 32 assertions. Wired into the `eval-tests` CI job (now **eight** DB-free eval files).
- `src/tests/eval/extract-wiring.test.ts` now targets Lena explicitly via `--fixture-id everding` instead of the order-dependent `--fixture-cap 1` first fixture: that first mietvertrag fixture is now hofmann's (correctly null source), so the wiring test pins the single-envelope fixture that actually supplies OCR. Assertions and intent unchanged-green.
- Out of scope (unchanged): no extractor/schema change, no re-extraction, no Sonnet; no per-document OCR for multi-envelope cases (WS3); no derived/composite grounding (4.3c, `unit_ref` stays `derived_pending`); 4.3a grade logic and `normalized_match` untouched.

## Task 4.3c-a — scorer-only derived grounding for single-source derived fields (2026-06-04)

- **Single-source derived grade (scorer-only, no schema/extractor change, no re-extraction, no Sonnet)**: a DERIVED field whose value comes from ONE cited source phrase via a declared deterministic normalization rule is now graded in `scripts/eval/metrics.ts` (`groundingGrade` → `gradeDerivedSingleSource`) on a **0/1/3** scale, instead of being excluded as `derived_pending`. **3** = quote-grounds AND rule-reproduces (the `evidence.quote` appears in OCR on its cited page, same-page constraint as 4.3a, AND applying the field's normalization rule to that quote reproduces `normalized_value`); **1** = quote grounds but the rule does NOT reproduce the value (source present, derivation unverified); **0** = quote does not ground (cited source absent from OCR on its page). Pure, deterministic, DB-free, API-free.
- **`floor_synonym_normalization` (the rule for `unit_ref`)**: a declared, deterministic, CLOSED German floor-phrase → canonical-token map in `metrics.ts` (exported): Erdgeschoss/EG→`EG`; `N. Obergeschoss`/`N. OG`/`N.OG` and erste/zweite/dritte/vierte Etage→`N.OG`; Dachgeschoss/DG→`DG`; Unter-/Kellergeschoss/UG→`UG`; a position suffix links/rechts/mitte is preserved (`"1. Obergeschoss links"` → `"1.OG links"`). Unknown/unmappable input → `null` (honest non-match, never a guess); a bare table cell like `"Geschoss 1"` and a bare `"Keller"` deliberately do NOT map.
- **Spec wiring (schema-driven, not hardcoded)**: `mietvertrag` `unit_ref` keeps `derived: true` and gains `derived_kind: single_source` + `normalization_rule: floor_synonym_normalization` in `schema.yaml`; `scripts/gen-schemas.ts` emits both into `GROUNDING_SPECS` (regenerated; `gen:schemas:check` green), and the `GroundingSpec` type (`scripts/eval/types.ts` + generated) carries the two optional fields. Only fields with a `single_source` rule get the derived grade; derived fields WITHOUT one (composite/multi-component, e.g. addresses) stay `derived_pending` (deferred to **4.3c-b**).
- **Gold-self-grounding invariant: derived = REPORT-ONLY**: `src/tests/eval/gold-grounding.test.ts` now grades derived fields and REPORTS them (`derived(rpt) … → grade N`) but does NOT hard-fail on them (hard-gating of derived fields waits until 4.3c is complete). The invariant stays green: `asserted_envelopes=1`, `pending_source=9`, `failures=0` (34 assertions). Lena's `unit_ref` is reported, never gated.
- **Lena re-score (`eval/candidates/lena2`, no re-extraction)**: `unit_ref` grades **0** — her `unit_ref` evidence is a table cell (`"Geschoss 1"` / a `"1"` under a `Geschoss` column), NOT a clean floor phrase, so the cited quote does not ground as a contiguous OCR substring. This is the honest table-case boundary that exposes `unit_ref` as a **table case for 4.3c-b**; it is NOT forced to 3. The fixture roll-up now grades **5** fields (was 4): kaltmiete/mietbeginn/tenant_identity/landlord_identity at grade 3 + unit_ref at grade 0 (grade3_rate 0.800).
- **New test**: `src/tests/eval/derived-grounding.test.ts` (32 assertions: the closed-map rule incl. honest non-matches, each derived grade 3/1/0, the same-page constraint, composite→`derived_pending`, absent/no_ocr exclusions, and the generated-spec derived metadata), wired into the `eval-tests` CI job (now **nine** DB-free eval files). The existing eight eval tests are unchanged-green.
- Out of scope (unchanged): no schema/extractor change to the extracted field set, no re-extraction, no Sonnet; no `source_components` / typed `EvidenceGroundingStatus` enum (4.3c-b); composite/multi-component derived fields stay `derived_pending`; scalar/identity grade logic and `normalized_match` untouched; derived fields do NOT yet hard-fail the gold-grounding invariant.

## Task 4.3c-b-1a — table_cell grounding for unit_ref (scorer-only proving ground) (2026-06-07)

- **`table_cell` is an EVAL-only evidence type, validated scorer-side (no production extractor / envelope_validator change, no re-extraction, no Sonnet, no composites, no bbox)**. The discriminated evidence union lives in `scripts/eval/types.ts`: `Evidence = EvidenceQuote | TableCellEvidence`, keyed on an **optional** `evidence_type` (absent ⇒ `direct_quote`, so every existing `{quote,page,bbox}` fixture is byte-for-byte unchanged and still valid). `TableCellEvidence` carries `{ evidence_type:"table_cell", page?, table_cell:{ row_anchor{quote,anchor_type,canonical?}, column_anchor{quote,canonical?}, cell_value_raw, derivation_rule } }`. Promoting `table_cell` to the production envelope + teaching the extractor to emit it + re-extracting Lena is the **separate** next task (4.3c-b-1b).
- **Integrity principle — the LLM PROPOSES, the scorer VALIDATES**: `cell_value_raw` (the RAW OCR token, e.g. `"1"`) is stored and grounded SEPARATELY from the field's normalized value (`"1.OG"`). The scorer grounds the raw token in OCR and reproduces the normalized value via a deterministic rule — it NEVER trusts a model-declared clean value. Anti-laundering: `cell_value_raw="1.OG"` does NOT pass unless `"1.OG"` literally grounds in OCR.
- **Derivation-rule registry (`scripts/eval/derivation-rules.ts`, shared by the scorer)**: a typed, CLOSED enum `DERIVATION_RULE_IDS = [literal, floor_abbreviation_normalization, geschoss_numeric_to_og]` + a deterministic `applyDerivationRule(rule, raw)`. `literal` = the raw token verbatim; `geschoss_numeric_to_og` = `"1"→"1.OG"`, `"2"→"2.OG"`, … with `EG`/`DG`/`UG` passthrough (LICENSED only under a floor column); `floor_abbreviation_normalization` REUSES the 4.3c-a closed floor map (`floor_synonym_normalization`, wired through `schema.yaml`/`field_specs`). A rule with no registry entry is not a `DerivationRule` (`isDerivationRule` false) → free-form rule strings are rejected at shape validation. (`metrics.ts` ↔ `derivation-rules.ts` is a deliberate import cycle; the floor-rule binding is read at call time via an arrow.)
- **Per-field evidence allow-list (`FIELD_EVIDENCE_POLICY` in `derivation-rules.ts`)**: `unit_ref` allows evidence types `{direct_quote, table_cell, derived}`, table_cell rules `{literal, geschoss_numeric_to_og}`, derived rule `floor_abbreviation_normalization`. Every other field is unchanged (direct_quote only). The table_cell scorer only reaches a positive grade through a permitted `(type, rule)` pair.
- **table_cell scorer (`scripts/eval/metrics.ts` `gradeTableCell`, routed on `evidence_type` BEFORE the scalar/identity/derived paths)** — per the standard: (1) shape: type allowed, row/column/`cell_value_raw`/rule present, rule allowed, page present (missing on critical → cap 2); (2) ground each on the cited page (whitespace-normalized): `row_anchor.quote`, `column_anchor.quote` via a CONFIGURED header-synonym map only (`"Gesch."`→floor; an uncovered header not in OCR = hallucinated = fail), and `cell_value_raw`; (3) locality (same page): row & raw within ±3 lines, column within the previous 10 lines of the value, total span ≤15; (4) the column LICENSES the rule (`geschoss_numeric_to_og` only under a floor column — `"1"` under `"Zimmer"`/`"Nr."` must NOT derive a floor, even if the model declares `canonical:"floor"`); (5) ambiguity: duplicate same-raw/same-column rows with a row anchor that does not disambiguate → cap ≤2, and **`row_anchor` is REQUIRED for grade 3**; (6) derivation: `rule(cell_value_raw) === normalized_value`. Grades: **3** grounded+local+licensed+reproduced+unambiguous (`table_cell_grounded`); **2** value+one anchor, cohesion incomplete; **1** raw on page, no row/column relationship; **0** raw absent / different pages / rule fails / wrong column / hallucinated anchor. Pure, deterministic, DB-free, API-free.
- **Routing leaves the existing paths unchanged**: only a candidate carrying `evidence_type:"table_cell"` enters the table_cell scorer; direct-quote (default) evidence falls through to the unchanged 4.3a scalar / 4.3a-names identity / 4.3c-a derived logic. `normalized_match` is untouched.
- **Lena re-score (`eval/candidates/lena2`, no re-extraction)**: `unit_ref` STAYS grade **0** — UNCHANGED. Her real `unit_ref` evidence is a `direct_quote` (not a `table_cell`), so it keeps its 4.3c-a derived grade 0; teaching the extractor to emit a grounded `table_cell` for her unit and re-extracting is **4.3c-b-1b**'s target. The fixture roll-up is identical to 4.3c-a (5 graded fields, grade3_rate 0.800).
- **New test**: `src/tests/eval/table-cell-grounding.test.ts` (31 assertions: the rule registry incl. free-form rejection + the per-field allow-list; valid bare floor cell→3; wrong column→0; ambiguous header→0; duplicate rows w/ missing row anchor→≤2; header-synonym pass + hallucinated-header fail; anti-laundering `"1.OG"`-raw→0; raw absent→0; different-pages→0; disallowed/free-form rule→0), wired into the `eval-tests` CI job (now **ten** DB-free eval files). All prior nine eval tests are unchanged-green; the gold-grounding invariant stays green (derived report-only, Lena's `unit_ref` reported grade 0, `failures=0`).
- Out of scope (unchanged): no production extractor / `envelope_validator` change; no re-extraction; no Sonnet; no composite/address; no money-table; no bbox; `table_cell`/`derived` do NOT hard-fail the gold-grounding invariant (report-only); scalar/identity/4.3c-a derived logic and `normalized_match` untouched. Production promotion + re-extraction is **4.3c-b-1b**.

## Task 4.3c-b-1b-i — table_cell validator: row_anchor conditional on row ambiguity (scorer-only) (2026-06-07)

- **`row_anchor` is now REQUIRED for grade 3 only when there is ambiguity to resolve.** 1a required a row anchor for grade 3 in EVERY table_cell case; that wrongly capped an unambiguous single-unit floor (Lena's floor `"1"` lives in a single-unit DESCRIPTION table — header `"Wohnfläche ca. Geschoss Zimmer …"` then ONE value row `"100,00 m² 1 3,5 1 1 0 1 – Mitte 0"`, with no tenant in the row). Principle: `row_anchor` exists to disambiguate WHICH ROW supplied the cell; with one candidate row there is nothing to disambiguate, so it adds no defensibility and must not be required.
- **Candidate-data-row count drives the rule (`scripts/eval/metrics.ts` `gradeTableCellOnPage`)**: after grounding the column header + `cell_value_raw`, count value lines at/after the header carrying the raw token under the column. **Single-row block (exactly 1)** → `row_anchor` NOT required; grade 3 = column header grounds + `cell_value_raw` grounds under the licensed floor column + locality (column within the previous 10 lines, span ≤15) + rule reproduces (a provided row anchor must still ground, but is not required and only tightens the span). **Multi-row block (>1)** → `row_anchor` REQUIRED and must pin the value's own row, exactly as in 1a; missing/weak/non-disambiguating anchor → cap ≤2. The linearized floor case keeps a whole row on one line, so a single-unit table counts as ONE data row even when that line repeats the token across columns.
- **Column-position precision preserved (unchanged from 1a)**: the floor is licensed by the COLUMN ANCHOR, not by mere presence of the token. Lena's row has multiple `"1"`s under Geschoss/Zimmer/Küche/Bad/WC; declaring a non-floor column (e.g. `"Küche"`) with `geschoss_numeric_to_og` is rejected (wrong column → 0), and only the `"Geschoss"`-column declaration grades 3.
- **Lena re-score (`eval/candidates/lena2`, no re-extraction)**: `unit_ref` STAYS grade **0** — UNCHANGED. Her real evidence is a `direct_quote` (not a `table_cell`), so this scorer refinement does not touch it; moving her onto a grounded `table_cell` is **4.3c-b-1b-ii**'s target. The gold-grounding invariant stays green (`failures=0`, `unit_ref` reported grade 0).
- **Tests** (`src/tests/eval/table-cell-grounding.test.ts`, now 39 assertions): Lena-shape single-unit description table, no row anchor → 3; column-position trap (`"1"` under `"Küche"` → 0 while the `"Geschoss"` declaration on the same OCR → 3); multi-row rent-roll, no row anchor → ≤2; multi-row with correct row anchor → 3; header-above-wrapped-value (floor on the line below the header), single row → 3. All 1a assertions are unchanged — the anti-laundering, wrong-column, ambiguous-header, hallucinated-anchor, duplicate-rows→≤2, and different-pages cases all stay green (no 1a fixture was a single-row-no-anchor case, so none flipped 2→3).
- Out of scope (unchanged): no production extractor / `envelope_validator` change; no re-extraction; no Sonnet; no new evidence types / composites / money-table / bbox; scalar/identity/derived grade logic and `normalized_match` untouched; `table_cell`/`derived` still report-only against the gold-grounding invariant. This task touches only `scripts/eval` + tests (not a trigger path). Production promotion + re-extraction (Lena onto a `table_cell`) is **4.3c-b-1b-ii**.

## Task 4.3c-b-ii-A — `table_cell` promoted into the PRODUCTION envelope contract: carry + shape-validate + render (no emission, no Sonnet) (2026-06-07)

- **The production envelope can now CARRY, shape-VALIDATE, and RENDER `table_cell` evidence — but nothing EMITS it yet.** This closes the provenance-display break BEFORE any `table_cell` reaches a UI. ADDITIVE + BACKWARD-COMPATIBLE: existing `direct_quote` behavior is byte-unchanged (same extraction output, same emitter→applier→claims flow, same provenance rendering). Teaching the extractor to emit + re-extracting Lena is the SEPARATE next task **4.3c-b-ii-B**.
- **New production evidence module (`src/lib/evidence/`)** — the production mirror of the scorer-side union. `types.ts`: `Evidence = EvidenceQuote | TableCellEvidence`, keyed on an OPTIONAL `evidence_type` (absent ⇒ `direct_quote`), with `row_anchor` OPTIONAL (matching 4.3c-b-1b-i). `derivation-rules.ts`: the closed `DERIVATION_RULE_IDS` + `isDerivationRule` + `FIELD_EVIDENCE_POLICY` (`unit_ref` allows types `{direct_quote, table_cell, derived}`, table_cell rules `{literal, geschoss_numeric_to_og}`; every other field is `direct_quote` only) — value-identical to `scripts/eval/derivation-rules.ts` but carries NO `apply()` (the production validator is shape-only, never grounding). The eval tree and the Next.js app are separate tsconfig worlds (`scripts/`, `supabase/` are excluded from `tsc --noEmit`; eval runs under `tsx`), so the closed enum + policy are duplicated, not imported.
- **`validateEvidence(fieldId, evidence)` (`src/lib/evidence/validate.ts`) — SHAPE + per-field allowed types, NEVER grounding**: `direct_quote` requires a non-empty `quote`; `table_cell` requires numeric `page` + `column_anchor.quote` + `cell_value_raw` + a REGISTERED `derivation_rule` that is ALLOWED for the field (row_anchor optional, but if present must carry a quote). The evidence type must be permitted for the field — a `table_cell` on any field other than `unit_ref` is rejected. Free-form / non-registered / not-allowed-for-field rules are rejected. (This is a NEW standalone validator; the generated per-doc-type `envelope_validator.ts` is intentionally LEFT UNCHANGED — it only ever required a non-empty evidence array, never inspected quotes, so widening it would risk the "direct_quote byte-unchanged" safety invariant. Reconciliation per the illustrative-brief rule.)
- **`renderEvidence(evidence)` (`src/lib/evidence/render.ts`) — GERMAN provenance (UI is German-only)**: `direct_quote` → the quote (unchanged); `table_cell` + row_anchor → `"Tabellenzelle — Zeile [<row>], Spalte [<col>], Rohwert [<raw>], Seite <page>"`; `table_cell` without row_anchor → `"Tabellenzelle — Spalte [<col>], Rohwert [<raw>], Seite <page>"`. Wired into the provenance click-through in `src/lib/dashboard-actions.ts`: `ProvenanceClaim` gains `evidence_rendered: string | null`, computed from the claim `value` jsonb's optional `evidence` object via `renderClaimEvidence`; the `ProvenanceModal` claim chain renders it (`data-testid="claim-evidence"`). Today no emitter attaches a `table_cell`, so this is the byte-unchanged `direct_quote`/null path — the wiring is in place so a `table_cell` claim renders readable source the moment emission lands.
- **Type widening (compile-safe, behavior-unchanged)**: the four emitters (`src/lib/emitters/{mietvertrag,mietvertragsnachtrag,mieterhoehung,wohnungsuebergabeprotokoll}.ts`) widen `FieldBase.evidence` from `{page?,quote?}[]` to `Evidence[]`; the Deno verifier contract (`supabase/functions/process-document/verifiers/types.ts`) widens `FieldEnvelope.evidence` to the inlined union (the Deno tree cannot import from `src/lib`; verifiers run on money fields only and read nothing from evidence — compile-surface only). **Reconciliation vs the brief**: emitters/claims do NOT carry an inline evidence object — claims store a `value` jsonb plus a VESTIGIAL nullable `evidence_id` uuid (there is no `warehouse.evidence` table), and `evidence_id_for_field` returns null. So §2 is satisfied at the TYPE level (the envelope can now carry `table_cell` without a break); the applier dedup/supersession logic is untouched.
- **Prompt shape-description (the one localized wrapper edit)**: `index.ts` (~L939) + its verbatim eval mirror `scripts/eval/extractor.ts` (~L102) now describe BOTH evidence variants (`direct_quote {quote,page,bbox}` and `table_cell {evidence_type, page, table_cell:{...}}`) — SHAPE ONLY, no when-to-use guidance (that is 4.3c-b-ii-B). The byte-identical edit keeps `extractor-drift.test.ts` green.
- **Tests**: `src/tests/evidence/render-evidence.test.ts` (4 assertions: direct_quote implicit/explicit → quote; table_cell ±row_anchor → the German strings) and `src/tests/evidence/validate-evidence.test.ts` (18 assertions: valid table_cell accepts; row_anchor-optional accepts; missing page/column/raw/rule rejects; disallowed type on a non-`unit_ref` field rejects; free-form + not-allowed rules reject; `unit_ref` allows table_cell; direct_quote requires a quote), both wired into the `eval-tests` CI job. `tsc --noEmit` clean; `gen:schemas:check` green (no generated files touched); ALL eval tests + the four emitter suites + the `everding-end-to-end` integration test (25 assertions, real DB chain emitter→applier→claims→resolver = €650) unchanged-green locally.
- Out of scope (unchanged): NO extractor EMISSION guidance (when to use table_cell) — 4.3c-b-ii-B; no re-extraction / Sonnet / prompt-tuning; no composite/address or money table_cell; `direct_quote` behavior, applier dedup/supersession, and the eval scorer/grade logic untouched.
