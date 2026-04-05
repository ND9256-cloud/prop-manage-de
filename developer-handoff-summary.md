# Developer Handoff Summary

_Last updated: 2026-04-05_

This document summarizes the current state of the property management SaaS for developer onboarding. Read ARCHITECTURE.md for conventions and ARCHITECTURE_STATE.md for live database/feature state.

## Stack

- **Frontend**: Next.js 14 (App Router), React, Tailwind CSS, shadcn/ui
- **Backend**: Supabase (Postgres, Edge Functions, Storage), Prisma ORM (public schema)
- **AI**: OpenAI GPT-4o for document processing pipeline and brain generation
- **CI/CD**: GitHub Actions (.github/workflows/ci.yml)

## Document Processing Pipeline

10 Edge Functions in `supabase/functions/process-document/index.ts`:

1. claimJob → 2. fetchDocument → 3. extractText → 4. classifyDocument → 5. extractFields → 5b. categorize → 6. storeExtraction → 7. matchEntities → 8. routeByConfidence → 8b. generateIntelligence → 9. completeJob

- Open taxonomy with 120 German document types (DOC_TYPE_MAP)
- Step 8b generates per-document intelligence (summary, tags, entity_name, unit_ref, cost_class, umlagefaehig) and flags property brain as stale
- Triggered by pg_cron every minute via warehouse.processing_jobs

## Property Intelligence Brain

- **Table**: `warehouse.property_intelligence` (2 rows, one per property)
- **Format**: Blackstone-style JSON analysis with sections: kosten_analyse, versicherungen, mieter, wartung, rechtliches, handlungsbedarf, rent_roll
- **Generation**: `scripts/generate-brain.js` — queries all document intelligence for a property, sends to GPT-4o with structured prompt
- **Staleness trigger**: Pipeline step 8b sets `is_current=false` on the property brain when new documents are processed; brain must be regenerated
- **Validation**: Output validated for required JSON keys with retry on failure; diff check prevents overwriting with degraded data
- **Chat endpoint**: `POST /api/properties/[id]/chat` — uses brain + document intelligence as context for property Q&A
- **Contract tests**: `src/tests/brain-contract.test.ts` validates property_intelligence JSON structure against expected schema

## Cost Classification

- `cost_class` (text) and `umlagefaehig` (boolean) on `warehouse.document_intelligence`
- `cost_class` (text) on `warehouse.documents` — set by pipeline via COST_CLASS_MAP
- Automatically populated by pipeline step 8b for new documents
- Existing 397 rows have NULL (backfill scripts exist: `scripts/backfill-cost-class.js`)
- SQL views aggregate costs: `warehouse.v_cost_overview` (by property, cost_class, year)

## Dashboard Redesign

- **"Seit deinem letzten Besuch"** orientation card at top (uses `last_seen_at` from memberships)
- **Portfolio KPI strip**: Objekte, Einheiten, Miete/Monat, Leerstand — reads from brain rent_roll data
- **Immobilienbestand table**: Replaces property cards with a holdings table showing units, rent, vacancy per property
- **Immobilien-Analyse panel**: Single interactive panel with property selector, key findings, and rent roll table — replaces side-by-side brain cards
- **Status bar**: Green dot + "System läuft normal" at bottom

## UI/Navigation

- **Proda-style sidebar**: 60px icon-only collapsed by default, expands to show labels on hover/click
- **Chevron toggle** on sidebar-content border edge (top-aligned) for expand/collapse
- **Fixed shell layout**: Header and sidebar fixed, content area scrolls independently
- **Settings flyout** with user info and logout (replaces separate settings page)
- **All UI in German** — no dual-language labels

## Property Detail Page

- Meta bar: document count, review count, applied count
- Brain insight line between meta bar and tabs (one-line AI summary)
- Compact category list view (replaces folder cards)
- Tabs: Dokumente, Kosten, Stammdaten, Protokoll
- Triage overlay with PDF preview, extraction fields, intelligence summary, apply/reject actions

## SQL Views (warehouse schema)

- `v_cost_overview`: cost aggregation by property, cost_class, year
- `v_vendor_summary`: vendor aggregation by property
- `v_insurance_status`: applied insurance documents with intelligence
- `v_open_actions`: documents with pending action signals
- `v_property_summary`: doc and photo counts per property
- `v_unit_timeline`: exists but has permission issue (SELECT not granted)

## Test Coverage

| Suite | Count | Location |
|-------|-------|----------|
| Playwright E2E | 11 | `e2e/*.spec.ts` |
| Golden file | 16 | `src/tests/fixtures/`, run via `src/tests/run-golden.ts` |
| Brain contract | 2 | `src/tests/brain-contract.test.ts` |

## Known Issues

- connector.apply() fails for angebot/vollmacht/informationsmaterial doc_types
- 6 failed documents (HEIC, large PDFs)
- Vendor name duplication (83 extracted, ~50 real)
- viewer_safe incorrectly flags Mieteingänge summaries as false
- unit_ref inconsistent across documents
- Cost amounts include purchase prices
- cost_class/umlagefaehig NULL on existing 397 intelligence rows
- v_unit_timeline permission issue

## Deferred

- Full-text search, cost aggregation API
- Auto-apply learning, vendor normalization
- IBAN, due_date, payment_status extraction
- purchase_price/purchase_date on Property
- Dark mode, mobile, i18n
- GoBD correction flow
