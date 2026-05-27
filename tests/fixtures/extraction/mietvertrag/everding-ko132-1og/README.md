# Everding KO132 1.OG — Phase 1 verification fixture

The canonical Mietvertrag for verifying the v2 extraction pipeline end-to-end.

**Source document:** `20250208_Lena Everding MV_signed.pdf`
**Property:** KO132 (Korbacher Straße 132, Schauenburg), unit 1.OG
**Tenant:** Everding, Lena
**Kaltmiete:** €650 / month
**Lease start:** 2025-04-01 (open-ended)

## Files

- `source.pdf` — the original signed Mietvertrag, 8.2 MB
- `expected.json` — the deterministic v2 envelope produced by Sonnet against
  this PDF on extraction_run_id `883934f6-5367-4575-98ea-a692da4f66f6`,
  schema_version `2026-05-21-v1`

## Updating the fixture

Re-extracting this PDF produces an envelope with new UUIDs but the same
`fields.*` content (modulo Sonnet stochasticity on edge fields). If the schema
version changes or extraction logic materially changes, regenerate:

1. Trigger a re-extraction (insert a row into `warehouse.processing_jobs`)
2. Pull the new envelope from `warehouse.document_extractions_v2`
3. Diff against `expected.json`; if material differences are intentional,
   replace expected.json.

## What this fixture verifies

The Phase 1 gate test (`src/tests/integration/everding-end-to-end.test.ts`)
feeds `expected.json` through emitter → applier → resolver and asserts the
resolver returns €650 with `single_active_claim` status. If the test fails,
Phase 1 is broken and must be fixed before any Phase 2 work proceeds.
