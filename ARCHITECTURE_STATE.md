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
