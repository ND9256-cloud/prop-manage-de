# ARCHITECTURE_STATE.md — Living State Document

_Last updated: 2026-04-08 (reordered hardening priorities, Tier 0 gates). Update this file after every architectural change._
_Read this before writing any code or sending any task to Claude Code._

## Database Tables — What Exists

### warehouse schema
- warehouse.documents: 634 rows (626 applied, 6 failed, 2 quarantined) — has cost_class column (text)
- warehouse.document_extractions: ~410 rows (is_current=true per doc, JSONB extracted_fields)
- warehouse.processing_jobs: job queue, pg_cron every minute
- warehouse.suggested_matches: entity matching results
- warehouse.review_tasks: low-confidence review queue
- warehouse.apply_log: GoBD immutable audit trail
- warehouse.document_chunks: EMPTY placeholder for RAG
- warehouse.document_intelligence: 402 rows — summaries, tags, entity refs, action signals, cost_class, umlagefaehig per document (is_current=true pattern, RLS enabled). Step 8b active in pipeline.
- warehouse.property_intelligence: 2 rows (KO132, HHS55) — per-property AI analysis brain table. Blackstone 11-section format (analysis jsonb, suggested_views jsonb, is_current=true pattern). Staleness trigger active from pipeline. Brain prompt single source of truth in src/lib/brain-prompt.ts. RLS disabled.
- warehouse.document_intelligence_runs: DOES NOT EXIST — must be created

### public schema (Prisma)
- Organization: 1 org
- User: 1 user (admin@demo.com)
- Membership: 1 row (owner role, has last_seen_at)
- Property: 2 properties (KO132, HHS55)
- Unit/Person/Lease/BankConnection/BankAccount/BankTransaction: schema exists, no data

### Pipeline (10 functions, all active)
1. claimJob 2. fetchDocument 3. extractText 4. classifyDocument
5. extractFields 5b. categorize 6. storeExtraction 7. matchEntities
8. routeByConfidence 8b. generateIntelligence (includes cost_class + umlagefaehig, flags property_intelligence stale) 9. completeJob

### Files that DO NOT exist
- src/lib/document-intelligence-schema.ts (was in Antigravity, never on Mac Mini)
- Intelligence runs migration SQL

### Known Issues
- connector.apply() fails for angebot/vollmacht/informationsmaterial doc_types
- 6 failed documents (HEIC, large PDFs)
- Vendor name duplication (83 extracted, ~50 real)
- Audit log property_id column: FIXED
- viewer_safe incorrectly flags Mieteingänge summaries as false
- unit_ref inconsistent across documents
- Cost amounts include purchase prices
- cost_class/umlagefaehig columns on document_intelligence only populated for new documents (397 existing rows have NULL)
- cost_class column on warehouse.documents set by pipeline via COST_CLASS_MAP, existing rows have NULL
- HHS55 brain shows Weber rent as 900 not 1000 (original vs current rent)
- Some Mietbeginn dates missing in brain output
- Property table name is "Property" not "properties" — raw SQL queries must use quoted "Property" (e.g. FROM "Property")

### Live Features
- Open taxonomy (120 German types), DOC_TYPE_MAP
- Extraction (vendor 97%, amount 98% on cost docs)
- Dashboard Section 1: KPI strip (Objekte, Einheiten, Miete/Monat, Vermietungsquote)
- Dashboard Section 2: Immobilienbestand holdings table with short_code, full address, Mietfläche, Miete/Monat, Miete/Jahr from brain + Property table (raw SQL uses quoted "Property")
- Dashboard Section 3: Immobilien-Analyse with property selector and Mietübersicht tab
- "Seit deinem letzten Besuch" orientation card on Alle Dokumente page (moved from dashboard)
- Inbox (Alle Dokumente) with vendor/amount/date columns
- Triage overlay with apply/quarantine, document intelligence summary in right panel
- CI/CD (GitHub Actions)
- last_seen_at on memberships
- Document intelligence (summaries, entity_name, unit_ref, cost_class, umlagefaehig in UI, German tags)
- viewer_safe filtering on intelligence summaries
- Proda-style icon-only sidebar with expand/collapse chevron toggle at top
- Settings flyout with user info and logout (replaces settings page link)
- Fixed shell layout (header + sidebar fixed, content area scrolls independently)
- Brain insight line on property detail page
- Compact folder list on property detail Dokumente tab
- Property chat endpoint at /api/properties/[id]/chat
- German number and date formatting (dots as thousands separators, dd.MM.yyyy dates)
- Brain schema validation and diff protection in generate-brain.js
- Brain contract tests validating property_intelligence JSON structure

### SQL Views (warehouse schema)
- warehouse.v_cost_overview: cost aggregation by property, cost_class, year
- warehouse.v_vendor_summary: vendor aggregation by property
- warehouse.v_insurance_status: applied insurance documents with intelligence
- warehouse.v_open_actions: documents with pending action signals
- warehouse.v_property_summary: doc and photo counts per property
- warehouse.v_unit_timeline: ⚠️ EXISTS but has permission issue (SELECT not granted)

### Tests
- 11 Playwright tests — all passing
- 16 golden file tests — all passing
- 2 brain contract tests — all passing

### In flight
- Synthetic monitoring (Playwright + launchd + Discord) — finish before starting Tier 0 block.

## Tier 0 — Foundational Integrity Gates (BEFORE CUSTOMER #1)

**⛔ BLOCKING customer #1 onboarding. All five gates must pass before any paying tenant is onboarded.**

1. **Multi-tenant CI gate** — eslint or grep rule failing build on unguarded Prisma mutations missing org_id scope.
2. **Migration discipline** — supabase db push only, no manual SQL; drift-detection script comparing prod schema to migrations directory in CI.
3. **ARCHITECTURE_STATE.md CI gate** — fail build on commits touching supabase/migrations/, supabase/functions/process-document/, src/lib/*-actions.ts, or src/app/ routes without same-commit update to this file.
4. **GoBD soft-delete and retention** — applied (Verbucht) documents must support soft-delete with retention period enforcement at the data layer.
5. **Backup-restore drill** — one-time restore of Supabase Pro backup into separate project, verify documents and database came back, document the steps.

### Designed but NOT implemented
- Full-text search, cost aggregation API
- Auto-apply learning, vendor normalization

### Deferred
- IBAN, due_date, payment_status extraction
- purchase_price/purchase_date on Property
- Dark mode, mobile, i18n
- GoBD correction flow (beyond soft-delete)

Rule: If this file doesnt list it, assume it doesnt exist.
