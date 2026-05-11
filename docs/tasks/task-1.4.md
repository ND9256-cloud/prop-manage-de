# Task 1.4 — Domain knowledge: `wohnungsuebergabeprotokoll.md`

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §4.5 (doc-type taxonomy / Übergabeprotokoll exception), §1 (Hofmann case), §6.3 (file format)
- `extraction-v2-implementation-plan.md` Task 1.4 section

Schema reference:
- `domain_knowledge/_schema.yaml` (meta-schema)
- `src/tests/domain-knowledge.test.ts` (Zod validator)
- `domain_knowledge/mietvertrag.md` (the Task 1.1 reference — same shape, different content)

This is a **t1 task** (content authoring, low review burden). It populates `domain_knowledge/wohnungsuebergabeprotokoll.md` from its current stub to a fully-fleshed file. This doc_type is structurally different from Mietvertrag because **it can close other claims** — the file's `closes` array is non-empty, and the closure logic is the load-bearing decision that prevented the Hofmann bug.

## What's at stake

The Wohnungsübergabeprotokoll is a single document name covering three semantically different events:

- **Einzug** — a tenant moves in. Triggers tenant-active claim emission.
- **Auszug** — a tenant moves out. Closes tenant-active and related claims for that unit.
- **Eigentümerwechsel** — property ownership transfers. Emits owner claim. **Does NOT close tenant claims** — the tenants stay; only the landlord changes.

A 4th value, `unklar`, emits no claims and forces human review.

The Hofmann case (HHS55 DG): a November 2025 Eigentümerwechsel-Übergabeprotokoll documented a property sale from Cornelia Bernhardt to Denn Immobilienverwaltung eGbR. Dr. Hellen Hofmann was an active tenant (since 2021, €900/month) and remained one. The previous (legacy) extraction pipeline conflated Eigentümerwechsel with Mieterwechsel and effectively closed Hofmann's tenancy, dropping the monthly rent total from €1,900 to €1,000. Getting the Übergabeprotokoll closure logic right is operationally critical.

## What exists now

`domain_knowledge/wohnungsuebergabeprotokoll.md` is a stub with empty arrays:

```yaml
---
doc_type: wohnungsuebergabeprotokoll
default_claim_kind: event
last_updated: 2026-05-08
legal_grounding: []
fields_governed: []
normalization_rules: []
gotchas: []
adversarial_fixtures_required: []
closes: []
---

<!-- TODO: populated in Task 1.4 -->
```

Note: `default_claim_kind: event` is already correct (per implementation plan acceptance criteria). Do not change it. Mietvertrag uses `assertion`; Übergabeprotokoll uses `event`. Different claim_kind because Übergabeprotokoll documents a discrete moment, not an ongoing state.

## Front-matter requirements

Update `last_updated` to today's date in ISO 8601 (YYYY-MM-DD).

### `legal_grounding`

Übergabeprotokolle have less direct statutory backing than Mietverträge — they're primarily a documentation practice. Two relevant entries:

- `BGB §535` — Vertragstypische Pflichten beim Mietvertrag (referenced because the Übergabeprotokoll documents the handover that satisfies the landlord's obligation to provide premises in usable condition)
- `BGB §548` — Verjährung der Ersatzansprüche und des Wegnahmerechts (relevant because the Auszug-Übergabeprotokoll triggers a 6-month limitation period for landlord damage claims)

Do not invent additional citations. These two cover the operational relevance.

### `fields_governed`

The fields the Übergabeprotokoll produces evidence for. Required entries:

- `uebergabe_typ` (the critical enum that drives all downstream behavior)
- `unit_ref` (which unit was handed over)
- `uebergabe_datum` (the date of handover)
- `kaeufer` (for Eigentümerwechsel only — the new owner)
- `verkaeufer` (for Eigentümerwechsel only — the previous owner)
- `mieter_in` (for Einzug — the new tenant)
- `mieter_out` (for Auszug — the departing tenant)
- `meter_readings` (Zählerstände — Strom, Gas, Wasser, Heizung)
- `damages_noted` (list of damages or defects documented)

9 entries total. Optional fields are allowed; the Übergabeprotokoll often only fills the ones relevant to its type.

### `normalization_rules`

One rule:

- `id: uebergabe_typ_canonical_values`
  - `field: uebergabe_typ`
  - `description` (multi-line): explain the four canonical values (Einzug, Auszug, Eigentümerwechsel, unklar) and the disambiguation signals. Free-form variants must be normalized: "Einzugsprotokoll" → "Einzug"; "Auszugsprotokoll" or "Wohnungsrückgabe" → "Auszug"; "Eigentümerwechsel-Protokoll" or any document referencing Käufer/Verkäufer or a Kaufvertrag → "Eigentümerwechsel"; anything ambiguous → "unklar" (forces human review).

### `gotchas`

Three gotchas, in order of severity:

1. **`id: eigentuemerwechsel_does_not_invalidate_tenants`** (THE critical one)
   - `real_failure_reference: hofmann_unklar`
   - `description` (multi-line): explain that an Übergabeprotokoll with `uebergabe_typ = "Eigentümerwechsel"` documents a property sale. The tenants stay; only the landlord changes. The closure logic must emit an owner claim (or close the previous owner claim) and must NOT close any tenant claims for the unit. Reference the Hofmann case (HHS55 DG): November 2025 Eigentümerwechsel-Übergabeprotokoll between Cornelia Bernhardt (Verkäufer) and Denn Immobilienverwaltung eGbR (Käufer); Dr. Hellen Hofmann was a sitting tenant since 2021 and remained one. A pipeline that conflates Eigentümerwechsel with Mieterwechsel drops her from the rent roll.

2. **`id: ambiguous_uebergabe_typ_forces_human_review`**
   - `description` (multi-line): if the document doesn't clearly signal Einzug, Auszug, or Eigentümerwechsel, extraction must set `uebergabe_typ = "unklar"` and absence_state = "requires_human_review". The emitter must skip claim emission entirely for unklar Protokolle. This is the safe default — better no claim than a wrong claim. Common ambiguity sources: contractor walkthrough protocols, dual-purpose Begehungsprotokolle, drafts without signatures.

3. **`id: meter_readings_are_evidence_not_claims`**
   - `description` (multi-line): Zählerstände documented in an Übergabeprotokoll establish a baseline for utility accounting but are not directly emitted as claims by the v2 pipeline at launch. They're stored in the envelope's `fields.meter_readings` and surface in the triage UI for human reference. Downstream consumption (utility cost allocation, Nebenkostenabrechnung generation) is Phase 2+.

### `adversarial_fixtures_required`

Per architecture §11.1, the canonical fixture set for Übergabeprotokoll. Five entries:

- `einzug_explicit`
- `auszug_explicit`
- `eigentuemerwechsel_explicit`
- `ambiguous_unklar`
- `mixed_einzug_and_eigentuemerwechsel`

The last one (mixed) tests the worst case: a document that contains both tenant change AND owner change signals. Correct behavior depends on which is primary; ambiguous documents must default to `unklar`.

### `closes`

This is the load-bearing part of the file. The `closes` array is non-empty for this doc_type. Three entries, conditional on `uebergabe_typ`:

1. **When uebergabe_typ == "Auszug": close kaltmiete claim for the unit**
   ```yaml
   - target_predicate: kaltmiete
     target_subject_pattern: "unit:<unit_ref>"
     close_mode: close_overlapping_and_future
     when: "uebergabe_typ == 'Auszug'"
     valid_to_source: uebergabe_datum
     match_requirements:
       property_id: same_as_protocol
       unit_ref: from_protocol
   ```

2. **When uebergabe_typ == "Auszug": close tenant_active claim for the unit**
   ```yaml
   - target_predicate: tenant_active
     target_subject_pattern: "tenant:<mieter_out>"
     close_mode: close_overlapping_and_future
     when: "uebergabe_typ == 'Auszug'"
     valid_to_source: uebergabe_datum
     match_requirements:
       property_id: same_as_protocol
       unit_ref: from_protocol
       tenant_name: from_protocol_mieter_out
   ```

3. **When uebergabe_typ == "Eigentümerwechsel": close owner claim for property (NOT tenant claims)**
   ```yaml
   - target_predicate: owner
     target_subject_pattern: "property:<property_id>"
     close_mode: close_overlapping_only
     when: "uebergabe_typ == 'Eigentümerwechsel'"
     valid_to_source: uebergabe_datum
     match_requirements:
       property_id: same_as_protocol
       previous_owner: from_protocol_verkaeufer
     blocker_check:
       - "MUST NOT close any tenant_active claims for this property"
       - "MUST NOT close any kaltmiete claims for this property"
   ```

Note the `blocker_check` on the third entry — this is an explicit guard against the Hofmann bug. The emitter must verify these conditions before applying closures.

Note also: `Einzug` is NOT in the closes list. Einzug emits NEW claims (tenant_active, kaltmiete for the unit) but does not close prior claims. The previous tenant's Auszug-Übergabeprotokoll (if it exists) is what closes those.

## Free-form prose section

Below the front-matter, 400-700 words of human-readable prose. Structure:

```markdown
# Wohnungsübergabeprotokoll — domain knowledge

## Why this matters

Brief framing: a single document type whose semantic content depends on
a single field (uebergabe_typ). Three different events under one name.
The closure logic must dispatch on uebergabe_typ; conflating types
breaks the rent roll.

## The four uebergabe_typ values

Walk through each:
- Einzug: tenant moves in. Emits tenant_active and kaltmiete claims.
- Auszug: tenant moves out. Closes tenant_active and kaltmiete claims.
- Eigentümerwechsel: ownership transfers. Closes owner claim only.
- unklar: ambiguous. Emit nothing, force human review.

## The Hofmann case

Walk through the concrete failure: HHS55 DG, November 2025
Eigentümerwechsel-Übergabeprotokoll. Verkäufer Cornelia Bernhardt,
Käufer Denn Immobilienverwaltung eGbR. Dr. Hellen Hofmann sitting
tenant. Wrong closure dropped her from the rent roll. The fix is the
dispatch on uebergabe_typ and the blocker_check on the Eigentümerwechsel
closure rule.

## Disambiguation signals

How to recognize each type from document structure:
- Einzug signals: tenant signature with "übernehme die Wohnung",
  Übergabe-/Einzugsdatum, meter readings as starting baseline
- Auszug signals: "Rückgabe" or "Wohnungsrückgabe", tenant signature
  with "übergebe die Wohnung", damages noted, meter readings as
  closing values
- Eigentümerwechsel signals: Käufer + Verkäufer named, reference to
  Kaufvertrag, no Mieter signature (or Mieter as bystander), property
  identifier rather than unit identifier
- unklar signals: any mix, missing primary signature, draft status,
  generic walkthrough language

## What this doc_type does

Übergabeprotokoll is a claim closer (primarily) and a baseline
recorder (for meter readings, damages). Its emitter must dispatch on
uebergabe_typ before doing anything else.

## References

Cite §4.5 (doc-type taxonomy), §1 (Hofmann case), BGB §535, §548.
```

## Verifying

After writing, run:

```bash
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
```

Expected: `✓ 5 domain knowledge files validated`.

If validation fails: the front-matter doesn't conform to meta-schema. The most likely failure is malformed YAML in the `closes` entries (nested `match_requirements`, `blocker_check` as array of strings).

Also verify the file reads naturally as a domain expert would write it. Bullet-point prose is a smell; full sentences with cited cases is the bar.

## Branch + push

```bash
git checkout main
git pull
git checkout -b feature/task-1.4-uebergabeprotokoll-domain-knowledge

# (edit domain_knowledge/wohnungsuebergabeprotokoll.md per spec)

npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts

git add domain_knowledge/wohnungsuebergabeprotokoll.md
git commit -m "v2: populate wohnungsuebergabeprotokoll.md domain knowledge (Task 1.4)"

git push -u origin feature/task-1.4-uebergabeprotokoll-domain-knowledge
```

Report back the branch URL. Nils opens the PR.

## Acceptance gates (verify before reporting completion)

- `domain_knowledge/wohnungsuebergabeprotokoll.md` no longer a stub
- Front-matter has: 2 legal_grounding, 9 fields_governed, 1 normalization_rule, 3 gotchas, 5 adversarial_fixtures_required, 3 closes entries
- `default_claim_kind: event` (NOT assertion)
- `last_updated` is today's date
- `eigentuemerwechsel_does_not_invalidate_tenants` gotcha has `real_failure_reference: hofmann_unklar`
- The Eigentümerwechsel closes entry has the `blocker_check` array with both MUST NOT lines
- The Auszug-related closes entries use `close_mode: close_overlapping_and_future`
- The Eigentümerwechsel closes entry uses `close_mode: close_overlapping_only`
- Free-form prose section is 400-700 words, references the Hofmann case by name, walks through all four uebergabe_typ values
- `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts` exits 0 with `✓ 5 domain knowledge files validated`
- `npx tsc --noEmit` silent
- Branch pushed to origin

## Constraints

- Do NOT modify any other domain_knowledge/*.md file.
- Do NOT modify `domain_knowledge/_schema.yaml` (meta-schema is locked).
- Do NOT modify `src/tests/domain-knowledge.test.ts` (validator is locked).
- Do NOT add fields_governed beyond the 9 specified.
- Do NOT cite BGB sections beyond §535 and §548. Over-citation dilutes the file.
- Do NOT add closes entries beyond the 3 specified. Einzug emits new claims but does not close any.
- The `blocker_check` on the Eigentümerwechsel closure is mandatory — it's the structural defense against the Hofmann bug.
- Do NOT push directly to main. Use feature branch + PR workflow.
- Pipe git commands through `| cat`.
