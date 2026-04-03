# ARCHITECTURE_STATE.md — Living State Document

_Last updated: 2026-04-03 (sidebar redesign, brain, chat). Update this file after every architectural change._
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
- warehouse.document_intelligence: 397 rows — summaries, tags, entity refs, action signals, cost_class, umlagefaehig per document (is_current=true pattern, RLS enabled)
- warehouse.property_intelligence: 2 rows — per-property AI analysis brain table (analysis jsonb, suggested_views jsonb, is_current=true pattern, staleness trigger from pipeline, RLS disabled)
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

### Live Features
- Open taxonomy (120 German types), DOC_TYPE_MAP
- Extraction (vendor 97%, amount 98% on cost docs)
- Dashboard with property cards, 4-category buckets
- Inbox with vendor/amount/date columns
- Triage overlay with apply/quarantine
- CI/CD (GitHub Actions), 16 golden + 11 Playwright tests
- last_seen_at on memberships
- Document intelligence (summaries, entity_name, unit_ref, cost_class, umlagefaehig in UI, German tags)
- viewer_safe filtering on intelligence summaries
- Proda-style icon-only sidebar with expand/collapse chevron toggle
- Settings flyout with user info and logout
- Fixed shell layout (header + sidebar fixed, content area scrolls independently)
- Immobilien-Analyse brain summary cards on dashboard
- Property chat endpoint at /api/properties/[id]/chat

### SQL Views (warehouse schema)
- warehouse.v_cost_overview: cost aggregation by property, cost_class, year
- warehouse.v_vendor_summary: vendor aggregation by property
- warehouse.v_insurance_status: applied insurance documents with intelligence
- warehouse.v_open_actions: documents with pending action signals
- warehouse.v_property_summary: doc and photo counts per property
- warehouse.v_unit_timeline: ⚠️ EXISTS but has permission issue (SELECT not granted)

### Designed but NOT implemented
- Full-text search, cost aggregation API
- Auto-apply learning, vendor normalization

### Deferred
- IBAN, due_date, payment_status extraction
- purchase_price/purchase_date on Property
- Dark mode, mobile, i18n
- GoBD correction flow

Rule: If this file doesnt list it, assume it doesnt exist.
