# Task 1.5c — Expand mietvertrag schema with 3 declared fields

Task type: t2 M (logic + schema change + envelope migration). No production data corruption risk: existing v2 envelopes remain on schema_version 2026-05-11-v1 and continue to render correctly. New extractions land on 2026-05-13-v1.

Reference docs (in repo):
- `domain_knowledge/mietvertrag.md` — already declares `nebenkostenvorauszahlung`, `kaution`, `landlord_identity` under `fields_governed`. Schema has been lagging behind.
- `docs/extraction-v2/extraction-v2-architecture.md` §3.1 (envelope shape), §11 (dual-path migration plan)
- `schemas/mietvertrag/schema.yaml` — current schema at version 2026-05-11-v1

Code touched:
- `schemas/mietvertrag/schema.yaml` — bump `schema_version` to `2026-05-13-v1`. Add 3 field definitions. Update `prompt_fragment_template` with the new per-field sections.
- Generator outputs (regenerated, do NOT edit by hand):
  - `schemas/mietvertrag/generated/prompt_fragment.ts`
  - `schemas/mietvertrag/generated/envelope_validator.ts`
  - `schemas/mietvertrag/generated/field_labels.json`
- `src/lib/extraction-display.ts` — extend `V2_FIELDS.mietvertrag` with 3 new entries + add a `formatLandlord` helper that mirrors `formatTenantIdentity`.
- `supabase/functions/process-document/index.ts` — extend `V2_PROMPTS.mietvertrag.fieldSpecs` with severity for the 3 new fields.
- `src/tests/triage-document-shape.test.ts` — extend the v2 Lena envelope fixture; add 3 fixture rows; assert new fields render correctly with proper severity injection and formatting.
- `src/tests/envelope-validator.test.ts` — add fixtures for the new field types in happy path; verify severity injection on the 3 new fields.
- `ARCHITECTURE_STATE.md` — note Phase 1.5c.

NOT touched in this task:
- The 4 other doc-type schemas (kuendigung, mieterhoehung, mietvertragsnachtrag, wohnungsuebergabeprotokoll). Their fields stay at current scope. Their generated outputs regenerate untouched because their YAML didn't change.
- `verifiers/` directory. The new money/structured fields reuse existing verifiers via `verifier_refs`.
- Claim emitters (Task 1.7) or applier (Task 1.8). Out of scope.
- The Edge Function's pipeline structure itself — only the per-field `fieldSpecs` map gets new severity entries.

## Context

After Phase 1 Tasks 1.5 + 1.5b + 1.6 shipped, Lena Everding's Mietvertrag (KO132 1.OG) renders 4 v2 fields in the triage overlay. Paul Mietvertrag, re-extracted on May 13, also renders 4 v2 fields. Both are intentional minimal — the original Task 1.2 brief deferred several fields the domain knowledge already declares.

That deferral was a Phase 1 simplification. We're now extending it to its committed minimum. Domain knowledge's `fields_governed` block already lists 8 fields; the schema only declares 5. This task closes 3 of the 3 missing gaps:
- **nebenkostenvorauszahlung** — Nebenkosten advance payment (€/month). Critical for Betriebskostenabrechnung in Phase 2.
- **kaution** — security deposit (€). Legal cap = 3x Kaltmiete (BGB §551). Critical for compliance check and Hofmann/Eigentümerwechsel handling later.
- **landlord_identity** — Vermieter party (structured). Mirrors `tenant_identity` shape. Needed for Eigentümerwechsel detection (matching Käufer/Verkäufer to Vermieter in Übergabeprotokolle).

After Phase 1.5c, the schema is on 2026-05-13-v1. The remaining 5 fields_governed entries (kaltmiete, mietbeginn, mietende, tenant_identity, unit_ref) were already in the schema.

Domain knowledge does NOT need editing — `fields_governed` already lists these 3, and `normalization_rules` / `gotchas` do not change. The generator's cross-reference validator will simply stop warning about "fields_governed entry X not yet in schema fields" for these 3 fields.

## Decision summary (pre-baked)

- **Fields:** nebenkostenvorauszahlung, kaution, landlord_identity. Nothing else (no Warmmiete, no Garagenmiete, no Wohnfläche — those have different architectural homes).
- **Schema version bump:** 2026-05-11-v1 → 2026-05-13-v1. Existing v2 envelopes (Lena, Paul) keep their old version stamp; new extractions get the new stamp.
- **Re-extraction post-task:** Lena + Paul will be manually re-queued by Nils after merge, NOT by Claude Code. The task brief stops at code + tests.

## Repo conventions

- npm (not pnpm).
- Tests via `npx tsx -r dotenv/config src/tests/<file>.ts`.
- Pipe potentially-paged commands through `| cat`.
- Branch protection enforced on main — feature branch + PR only.
- Edge Function does NOT auto-deploy; Nils redeploys manually after merge.
- German UI strings.

## Field specifications

### Field 1: `nebenkostenvorauszahlung`

```yaml
- id: nebenkostenvorauszahlung
  german_label: "Nebenkostenvorauszahlung"
  severity: important
  requiredness: optional
  type: money
  verifier_refs:
    - monetary-verbatim
  description: |
    Monthly advance payment for Nebenkosten/Betriebskosten, separate
    from Kaltmiete. Synonyms: "Nebenkostenvorauszahlung", "NK-Vorauszahlung",
    "Betriebskostenvorauszahlung", "Vorauszahlung Nebenkosten". May appear
    as a separate line item alongside Kaltmiete or as a sum within a Warmmiete
    breakdown.
    
    If the contract uses Inklusivmiete or only states Warmmiete without
    breaking out NK, set absence_state: ambiguous. If the contract genuinely
    doesn't include NK (some commercial or short-term leases), set
    absence_state: not_applicable.
    
    normalized_value: integer in minor units (cents) + currency code,
    e.g. { amount: 18000, currency: "EUR" } for €180.00.
  used_in_resolvers: false
  customer_visible: true
```

### Field 2: `kaution`

```yaml
- id: kaution
  german_label: "Kaution"
  severity: important
  requiredness: optional
  type: money
  verifier_refs:
    - monetary-verbatim
  description: |
    Security deposit (Mietkaution). German residential leases cap kaution
    at 3x the monthly Kaltmiete per BGB §551 (Mietkautionsobergrenze).
    The deposit may be paid in up to 3 monthly installments by the tenant.
    
    Extract the TOTAL kaution amount, not an installment. If the contract
    says "Kaution: 3 Monatsmieten" without a specific euro figure, set
    absence_state: ambiguous (the resolver will compute 3 × kaltmiete
    separately — extraction's job is to capture explicit values only).
    
    If the contract is kautionsfrei (no deposit required), set
    absence_state: not_applicable.
    
    normalized_value: integer in minor units (cents) + currency code,
    e.g. { amount: 195000, currency: "EUR" } for €1,950.00 (3x €650 Kaltmiete).
  used_in_resolvers: false
  customer_visible: true
```

### Field 3: `landlord_identity`

```yaml
- id: landlord_identity
  german_label: "Vermieter"
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
    The landlord party to the lease. Structurally identical to tenant_identity.
    For natural persons (e.g., "Petra Denn"), name is the full name as
    written. For legal entities (e.g., "Denn & Denn Verwaltungs GbR"),
    set is_legal_entity: true and populate legal_form (e.g., "GbR").
    
    German indicators that signal legal_entity: GmbH, UG, AG, eG, GbR,
    KG, OHG, e.V., GmbH & Co. KG.
    
    For Eigentümerwechsel scenarios (property ownership transfer), the
    landlord_identity in the original Mietvertrag may NOT match the
    current Vermieter — that's expected. The current Vermieter is
    determined by the most recent ownership document (Eigentümerwechsel
    Übergabeprotokoll or Kaufvertrag), not by re-extracting the Mietvertrag.
    Extraction's job is to capture what's written in THIS document.
    
    For multiple landlords (joint ownership like a GbR with multiple
    partners), extract the named entity (e.g., "Denn & Denn Verwaltungs GbR")
    OR the first listed natural person if no entity is named.
  used_in_resolvers: true
  customer_visible: true
```

## prompt_fragment_template additions

Insert these 3 sections into the existing `prompt_fragment_template` block AFTER `tenant_identity` (keep alphabetical-ish flow with related parties grouped):

```
### nebenkostenvorauszahlung (Nebenkostenvorauszahlung — monthly advance for Nebenkosten, EUR, optional)

Extract the monthly advance payment for Nebenkosten/Betriebskosten, separately stated from Kaltmiete. Synonyms: NK-Vorauszahlung, Betriebskostenvorauszahlung, Vorauszahlung Nebenkosten.
If the contract uses Inklusivmiete or only states Warmmiete without breaking out NK, set absence_state: ambiguous.
If the contract genuinely doesn't include NK, set absence_state: not_applicable.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 18000, currency: "EUR" } for €180.00.

### kaution (Kaution — security deposit, EUR, optional)

Extract the TOTAL Kaution amount, not an installment. If the contract says "Kaution: 3 Monatsmieten" without a euro figure, set absence_state: ambiguous.
If the contract is kautionsfrei, set absence_state: not_applicable.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 195000, currency: "EUR" } for €1,950.00.

### landlord_identity (Vermieter — the landlord party)

Extract the landlord as written on the contract. Structurally identical to tenant_identity.
normalized_value: { name: <full name or entity name>, is_legal_entity: <bool>, legal_form: <optional string for entities> }.
Legal-entity indicators: GmbH, UG, AG, eG, GbR, KG, OHG, e.V., GmbH & Co. KG. Set is_legal_entity: true and populate legal_form.
For multiple landlords / joint ownership, extract the named entity (e.g., "Denn & Denn Verwaltungs GbR") OR the first listed natural person if no entity is named.
```

## Steps

### 1. Bump schema_version + add 3 fields to schema.yaml

Open `schemas/mietvertrag/schema.yaml`. Change `schema_version: "2026-05-11-v1"` to `schema_version: "2026-05-13-v1"`.

Append the 3 new `fields:` entries AFTER the existing 5. The order matters because it determines the order in the generated prompt and the renderer iteration order. Recommended:

```
1. kaltmiete           (existing)
2. unit_ref            (existing)
3. tenant_identity     (existing)
4. landlord_identity   (NEW — keep parties together)
5. mietbeginn          (existing)
6. mietende            (existing)
7. nebenkostenvorauszahlung  (NEW — keep money fields together near kaltmiete? no, after tenant info is fine)
8. kaution             (NEW)
```

Actually — let me simplify: just append the 3 new fields to the end. The renderer order is V2_FIELDS.mietvertrag iteration order, which you control separately in extraction-display.ts. Order in schema.yaml affects only the generated prompt fragment's section order — and that's not user-visible.

Insert the 3 new fields into the `prompt_fragment_template:` block as documented above. Insert in section order: after tenant_identity, before mietbeginn.

### 2. Regenerate generated artifacts

```bash
npm run gen:schemas
```

Verify:
- `schemas/mietvertrag/generated/prompt_fragment.ts` now includes the 3 new sections in `PROMPT_FRAGMENT` and has `SCHEMA_VERSION = "2026-05-13-v1"`.
- `schemas/mietvertrag/generated/envelope_validator.ts`'s `FIELD_DEFS` now includes 3 new entries with correct types, severities, and (where applicable) enumValues.
- `schemas/mietvertrag/generated/field_labels.json` includes the 3 new German labels.
- The "fields_governed entry X not yet in schema fields" warnings for `nebenkostenvorauszahlung`, `kaution`, `landlord_identity` disappear from the gen output.

### 3. Extend V2_FIELDS in extraction-display.ts

Open `src/lib/extraction-display.ts`. Add `formatLandlord` that mirrors `formatTenantIdentity`:

```typescript
function formatLandlord(nv: unknown): string {
  if (nv == null) return "";
  if (typeof nv === "object" && nv !== null && "name" in nv) {
    return (nv as { name: string }).name;
  }
  return String(nv);
}
```

Extend `V2_FIELDS.mietvertrag` to include the 3 new entries. UI display order — pick what makes sense visually:

```typescript
const V2_FIELDS: Record<string, V2FieldDef[]> = {
  mietvertrag: [
    { fieldId: "kaltmiete", label: "Kaltmiete", format: formatMoney },
    { fieldId: "nebenkostenvorauszahlung", label: "Nebenkostenvorauszahlung", format: formatMoney },
    { fieldId: "kaution", label: "Kaution", format: formatMoney },
    { fieldId: "unit_ref", label: "Einheit", format: formatString },
    { fieldId: "tenant_identity", label: "Mieter", format: formatTenantIdentity },
    { fieldId: "landlord_identity", label: "Vermieter", format: formatLandlord },
    { fieldId: "mietbeginn", label: "Mietbeginn", format: formatDate },
    { fieldId: "mietende", label: "Mietende", format: formatDate },
  ],
};
```

Money fields cluster at top (financial), then unit reference, then parties (Mieter immediately above Vermieter), then dates.

### 4. Extend V2_PROMPTS.mietvertrag.fieldSpecs in index.ts

Open `supabase/functions/process-document/index.ts`. Find the `V2_PROMPTS.mietvertrag.fieldSpecs` block (currently at around line 94). Add the 3 new entries:

```typescript
fieldSpecs: {
    kaltmiete: { id: "kaltmiete", type: "money", severity: "critical" },
    unit_ref: { id: "unit_ref", type: "enum", enum_values: ["EG", "1.OG", "2.OG", "3.OG", "4.OG", "DG", "Keller", "Souterrain"], severity: "critical" },
    tenant_identity: { id: "tenant_identity", type: "structured", severity: "critical" },
    landlord_identity: { id: "landlord_identity", type: "structured", severity: "critical" },
    mietbeginn: { id: "mietbeginn", type: "date", severity: "critical" },
    mietende: { id: "mietende", type: "date", severity: "important" },
    nebenkostenvorauszahlung: { id: "nebenkostenvorauszahlung", type: "money", severity: "important" },
    kaution: { id: "kaution", type: "money", severity: "important" },
},
```

This is the data the pipeline injects into the envelope before validation (Task 1.5b severity-injection behavior).

### 5. Extend src/tests/envelope-validator.test.ts

The existing happy-path test (assertion 1) uses a `fullEnvelope()` helper. Extend that helper to include the 3 new fields. Add them as present-with-evidence in the happy path; this also exercises the validator's severity-injection check for the new fields.

Add a new test section "All 8 fields present" that exercises a richly-populated mietvertrag (Lena's contract, with Nebenkosten + Kaution + landlord populated). Use realistic values:
- nebenkostenvorauszahlung: { amount: 18000, currency: "EUR" } / "€180,00"
- kaution: { amount: 195000, currency: "EUR" } / "€1.950,00"  
- landlord_identity: { name: "Denn & Denn Verwaltungs GbR", is_legal_entity: true, legal_form: "GbR" }

Then add a test for severity mismatch on a new field — e.g., kaution with severity="critical" (schema says "important") should be rejected with `severity_mismatch`. This mirrors the existing kaltmiete severity test.

Expected: existing 32 assertions still pass, plus ~5 new assertions for the new fields.

### 6. Extend src/tests/triage-document-shape.test.ts

Extend the v2 envelope fixture (the one used in test section 1 "Lena's v2 Mietvertrag envelope") to include the 3 new fields. Then add new assertions:

- 1p. Has nebenkostenvorauszahlung row (label "Nebenkostenvorauszahlung")
- 1q. nebenkostenvorauszahlung display = "180,00 EUR"
- 1r. Has kaution row (label "Kaution")
- 1s. kaution display = "1.950,00 EUR"
- 1t. Has landlord_identity row (label "Vermieter")
- 1u. landlord_identity display = "Denn & Denn Verwaltungs GbR"
- 1v. Total row count now 7 (4 original visible + nebenkosten + kaution + vermieter; mietende still omitted as not_applicable)

Add a new test section "8. New fields edge cases":
- 8a. nebenkostenvorauszahlung with absence_state="ambiguous" (Warmmiete-only contract) → renders with "— (mehrdeutig)" placeholder
- 8b. kaution with absence_state="not_applicable" (kautionsfrei) → row omitted
- 8c. landlord_identity natural-person case (Lena's contract has Denn & Denn GbR, but earlier contracts had natural persons — use Petra Denn from Paul's contract) → renders display "Petra Denn"

Expected: existing 40 assertions still pass, plus ~9 new assertions.

### 7. Run full regression

```bash
npx tsc --noEmit
echo "(silent = good)"

npm run gen:schemas:check
npx tsx -r dotenv/config src/tests/schemas.test.ts
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
npx tsx -r dotenv/config src/tests/v2-claim-store-migration.test.ts
npx tsx -r dotenv/config src/tests/v2-extraction-envelope-migration.test.ts
npx tsx src/tests/verifiers.test.ts
npx tsx src/tests/verifiers-no-model-identifiers.test.ts
npx tsx src/tests/envelope-validator.test.ts
npx tsx src/tests/triage-document-shape.test.ts
```

Expected:
- gen:schemas:check: still 12 warnings but 3 FEWER from mietvertrag (the "not yet in schema" warnings for the 3 new fields are gone). Net should be 9 warnings.
- envelope-validator.test.ts: ~37 assertions pass.
- triage-document-shape.test.ts: ~49 assertions pass.
- Everything else unchanged.
- tsc silent.

### 8. ARCHITECTURE_STATE.md

Append a "Phase 1.5c" section documenting:
- Schema bumped to 2026-05-13-v1
- 3 fields added: nebenkostenvorauszahlung, kaution, landlord_identity
- domain_knowledge.fields_governed deferred entries now closed for mietvertrag
- Existing v2 envelopes remain on 2026-05-11-v1 (no migration); new extractions land on 2026-05-13-v1
- After merge: Nils manually redeploys Edge Function + re-queues Lena's + Paul's jobs to get them onto the new schema

### 9. Branch + commit + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.5c-mietvertrag-expand-fields

# (implement steps 1-8)

git add schemas/mietvertrag/schema.yaml \
        schemas/mietvertrag/generated/ \
        src/lib/extraction-display.ts \
        supabase/functions/process-document/index.ts \
        src/tests/envelope-validator.test.ts \
        src/tests/triage-document-shape.test.ts \
        ARCHITECTURE_STATE.md

git commit -m "feat(schema): expand mietvertrag schema with 3 fields_governed entries (Task 1.5c)

Adds nebenkostenvorauszahlung, kaution, and landlord_identity to
mietvertrag schema. These fields were already declared in
domain_knowledge/mietvertrag.md fields_governed but had been deferred
during Phase 1 minimal-schema rollout. Closing those deferred entries
now, before Task 1.7 (claim emitter) which needs the right schema to
build against.

Schema version: 2026-05-11-v1 → 2026-05-13-v1. Existing v2 envelopes
remain on the old version (no migration risk); new extractions land
on the new version. To get Lena's and Paul's envelopes onto the new
version, Nils manually re-queues their jobs after deploy.

Field specifications:
- nebenkostenvorauszahlung (money, important) — monthly NK advance.
  Sets ambiguous for Warmmiete/Inklusivmiete contracts; not_applicable
  for kein-NK leases.
- kaution (money, important) — security deposit. Sets ambiguous for
  '3 Monatsmieten' without euro figure; not_applicable for kautionsfrei
  contracts. BGB §551 cap = 3 × kaltmiete is the resolver's job.
- landlord_identity (structured, critical) — Vermieter party, mirrors
  tenant_identity shape. For Eigentümerwechsel scenarios, this captures
  the ORIGINAL Vermieter; the current Vermieter is determined by later
  ownership documents.

Tests:
- envelope-validator.test.ts: full happy-path envelope now includes all
  8 fields. New severity_mismatch assertion for kaution. ~37 assertions
  pass.
- triage-document-shape.test.ts: Lena fixture extended with the 3 new
  fields. New section for absence_state edge cases (ambiguous Warmmiete,
  kautionsfrei not_applicable, natural-person Vermieter). ~49 assertions
  pass.

Renderer: V2_FIELDS.mietvertrag in extraction-display.ts gains 3 new
entries. UI order: money fields cluster (Kaltmiete, NK, Kaution), then
unit ref, then parties (Mieter immediately above Vermieter), then dates.

After merge:
1. supabase functions deploy process-document
2. UPDATE warehouse.processing_jobs SET status='queued' WHERE ... for
   Lena and Paul, to bring their envelopes to 2026-05-13-v1.

No production data corruption risk: existing v2 envelopes remain on
their original schema_version stamp. The renderer renders whatever
fields are present and ignores ones that aren't."

git push -u origin feature/task-1.5c-mietvertrag-expand-fields
```

Report back: branch URL, test outputs, the schema diff (what got added).

## Acceptance gates

- `schemas/mietvertrag/schema.yaml` declares 8 fields (5 existing + 3 new), schema_version 2026-05-13-v1.
- `npm run gen:schemas:check` warnings reduced by 3 (the mietvertrag "not yet in schema" warnings for the 3 new fields are gone).
- All generated artifacts regenerated and committed: prompt_fragment.ts, envelope_validator.ts, field_labels.json.
- `V2_PROMPTS.mietvertrag.fieldSpecs` in index.ts has 8 entries with correct severities.
- `extraction-display.ts` V2_FIELDS.mietvertrag has 8 entries.
- envelope-validator.test.ts passes all assertions (existing + new).
- triage-document-shape.test.ts passes all assertions (existing + new).
- All other regression tests pass.
- tsc silent.
- ARCHITECTURE_STATE.md updated.
- Branch pushed; PR not opened by Claude Code.

## Constraints

- Do NOT touch the 4 other doc-type schemas (kuendigung, mieterhoehung, mietvertragsnachtrag, wohnungsuebergabeprotokoll).
- Do NOT touch domain_knowledge/mietvertrag.md. Its `fields_governed` already declares the 3 new fields; that's the source of truth for what we're adding.
- Do NOT add fields beyond the 3 specified (Warmmiete, Garagenmiete, Wohnfläche, etc. are intentionally out of scope per Nils's decision).
- Do NOT deploy the Edge Function. Deploy is Nils's manual step after merge.
- Do NOT trigger re-extraction of any document.
- Maintain backward compatibility: existing v2 envelopes at schema_version 2026-05-11-v1 must continue to render correctly. The renderer iterates V2_FIELDS, picks fields that exist in the envelope, and ignores absent ones — this is already the existing behavior.
- Pipe git commands through `| cat`.

## What this enables for Task 1.7

When Task 1.7 (Mietvertrag claim emitter) is written, it can emit:
- `kaltmiete` claims (already could)
- `tenant_active` claims (already could)
- `kaution_amount` claims (NEW — for the eventual deposit-tracking resolver)
- `landlord_active` claims (NEW — needed for Eigentümerwechsel claim closure logic)
- `nebenkostenvorauszahlung` claims (NEW — needed for Betriebskostenabrechnung downstream)

Building the emitter on the right schema once is much cheaper than building it twice.
