# Task 1.1 — Domain knowledge: `mietvertrag.md`

Reference docs (in repo at `docs/extraction-v2/`):
- `extraction-v2-architecture.md` §6.3 (file format example), §6.4 (consumer contract), §1 (the Weber/Hofmann/Paul/Kuru cases)
- `extraction-v2-implementation-plan.md` Task 1.1 section

Schema reference:
- `domain_knowledge/_schema.yaml` (meta-schema definition)
- `src/tests/domain-knowledge.test.ts` (runtime Zod validator — authoritative)

This is a **t1 task** (content authoring, low review burden). Phase 0 is complete; Phase 1 begins here. The goal is to populate `domain_knowledge/mietvertrag.md` from its current empty stub to a fully-fleshed file that will drive schema authoring (Task 1.2), prompt construction, and adversarial fixture creation.

## What exists now

`domain_knowledge/mietvertrag.md` is a stub with empty arrays:

```yaml
---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding: []
fields_governed: []
normalization_rules: []
gotchas: []
adversarial_fixtures_required: []
closes: []
---

<!-- TODO: populated in Task 1.1 -->
```

## What needs to be in it

The front-matter must be machine-readable YAML conforming to `domain_knowledge/_schema.yaml`. Below it, a free-form prose section explains nuances for human readers.

### Front-matter requirements

Update `last_updated` to today's date in ISO 8601 (YYYY-MM-DD).

**`legal_grounding`** — array of `{statute, description}` entries. Required entries:

- `BGB §535` — Vertragstypische Pflichten beim Mietvertrag (lease contract definition; landlord's duty to provide the leased premises and maintain them; tenant's duty to pay rent)
- `BGB §557` — Mieterhöhungen nach Vereinbarung oder Gesetz (rules under which rent may be increased; baseline that Mieterhöhung is regulated, not freely set)
- `BGB §573` — Ordentliche Kündigung des Vermieters (termination rules; relevant because the Mietvertrag defines the relationship that a Kündigung ends)

These three are the core. Optionally include `BGB §556` (Vereinbarungen über Betriebskosten) if relevant to the Nebenkostenvorauszahlung field, but only if it adds clarity — the architecture mentions only the three above as the canonical set.

**`fields_governed`** — array of strings naming the fields this doc_type can produce evidence for. Required entries (per implementation plan):

- `kaltmiete`
- `nebenkostenvorauszahlung`
- `kaution`
- `mietbeginn`
- `mietende`
- `tenant_identity`
- `landlord_identity`
- `unit_ref`

Note: `mietende` is included even though most residential leases are open-ended. The presence/absence pattern matters — an open-ended lease produces `mietende` with `absence_state: not_applicable` rather than omitting the field.

**`normalization_rules`** — array of `{id, field, description}` entries. Required entry:

- `id: kaltmiete_excludes_nebenkosten`
  - `field: kaltmiete`
  - `description`: explain that Kaltmiete is base rent only. Synonyms that map to kaltmiete: "Grundmiete", "Nettomiete". Terms that do NOT map to kaltmiete: "Bruttomiete", "Inklusivmiete" (these bundle Nebenkosten and require absence_state="ambiguous" because the kaltmiete component cannot be cleanly extracted).

Use a multi-line YAML string (the `|` style) for the description so it's readable.

**`gotchas`** — array of `{id, description, real_failure_reference (optional)}` entries. Required entries:

1. `id: nachtrag_supersession`
   - `real_failure_reference: weber_900_vs_1000`
   - `description` (multi-line): explain that a Nachtrag or Mieterhöhung document modifies kaltmiete with a later valid_from date. The Mietvertrag extractor must NOT merge the Nachtrag's value into the original Mietvertrag's extraction. Each document is extracted as-of-its-own-time. Supersession is resolved in the claim layer, not at extraction. Reference the Weber case (HHS55 1.OG): original Mietvertrag from 2010 had €900 Kaltmiete; a 1. Nachtrag set it to €1,000 in 2015. Both extractions are correct; only the claim layer determines the current value.

2. `id: indexmiete_vs_staffelmiete`
   - `description` (multi-line): explain the distinction. Indexmiete clauses tie rent to the consumer price index (Verbraucherpreisindex), producing a stable claim that requires a recomputation job. Staffelmiete clauses specify pre-agreed rent increases at fixed dates, producing multiple pre-emitted claims with future valid_from dates. Both clauses exist in residential leases; conflating them produces wrong claim emission. For v2 launch, both are out of scope but must be detected and flagged with `absence_state: requires_human_review` if present.

3. `id: bruttomiete_misinterpretation`
   - `description` (multi-line): a Mietvertrag using "Bruttomiete" or "Inklusivmiete" terminology bundles Nebenkosten into a single rent figure. The kaltmiete field cannot be cleanly extracted; absence_state must be `ambiguous`. This is closely related to the `kaltmiete_excludes_nebenkosten` normalization rule but is its own failure mode worth flagging.

4. `id: gewerbe_misclassification`
   - `description` (multi-line): a Gewerbemietvertrag (commercial lease) is legally distinct from a Wohnraummietvertrag (residential lease). Different BGB sections apply, different tenant protections, different rent regulation. The classifier may misroute a Gewerbemietvertrag as `mietvertrag` (residential). Reference the Weber case (HHS55 1.OG, J.H. Weber Versicherungsmakler GmbH) — commercial tenancy that must NOT be treated under §573 residential termination rules. Detection signals: tenant is a GmbH/UG/AG, use_clause mentions "Gewerbe" or "Büro", lease references HGB rather than BGB.

**`adversarial_fixtures_required`** — array of strings (fixture tags). Required entries (per implementation plan):

- `draft_unsigned` — a Mietvertrag missing signatures or marked "Entwurf"
- `mietvertrag_with_nachtrag_attached` — a Mietvertrag bundled with its own Nachtrag in the same PDF
- `indexmiete_clause` — contains a §557b Indexmiete formula
- `staffelmiete_clause` — contains a §557a Staffelmiete schedule
- `gewerbemietvertrag_misclassified_as_residential` — a commercial lease that the classifier might miscategorize
- `with_handwritten_amendment` — printed Mietvertrag with handwritten changes to financial terms

**`closes`** — empty array `[]`. Mietvertrag itself emits no closures. (A Mietvertrag's role in the claim system is to ASSERT a tenancy. Closures of tenancy come from Kündigung documents, not from the original Mietvertrag.)

### Free-form prose section

Below the front-matter, write 300-700 words of human-readable prose explaining the nuances. Structure suggestion (not mandatory):

```markdown
# Mietvertrag — domain knowledge

## Why this matters
Brief framing: the Mietvertrag is the foundational tenancy document.
Most claims about rent, deposit, term, parties, and unit derive from it
(directly or via supersession through Nachträge).

## The fields
Walk through each field, with a sentence on what it asserts and where
in a typical Mietvertrag it appears. For kaltmiete, mention common
synonyms (Grundmiete, Nettomiete) and antonyms (Bruttomiete, Inklusivmiete).
For unit_ref, mention the "EG/1.OG/DG" convention and template-text
risks (the Paul case).

## The gotchas in practice
Walk through nachtrag_supersession with the Weber example as a concrete
case (HHS55 1.OG, €900 → €1,000 via 1. Nachtrag). Walk through
indexmiete_vs_staffelmiete with a sentence on each. Walk through
bruttomiete_misinterpretation. Walk through gewerbe_misclassification
with the Weber case as a worked example of commercial tenancy.

## What this doc_type does not do
Mietvertrag does NOT close other claims. It only asserts. Closures of
tenancy come from Kündigung documents (separate domain knowledge file).
A Nachtrag's effect on rent is handled in the claim layer, not by the
Mietvertrag extractor.

## References
Cite the architecture sections you're matching: §6.3 (file format),
§1 (the real failure cases). Cite BGB section numbers inline where
relevant.
```

Prose must reference specific BGB sections inline where relevant (e.g., "Per BGB §535, the landlord owes ..."). Do not invent legal citations; use only the three primary statutes and §556 if needed. Do not cite case law — this is operational guidance, not legal advice.

## Verifying

After writing, run:

```bash
npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts
```

Expected: `✓ 5 domain knowledge files validated` (still 5, since this fills a stub rather than adding a new file).

If the test fails, the front-matter doesn't conform to the meta-schema. Fix the YAML and re-run.

Also verify the file reads naturally as German real estate domain knowledge — read it through once as a human would. The prose section is for humans; if it reads as boilerplate or AI-generated filler, rewrite.

## Branch + push

Create a feature branch and PR:

```bash
git checkout main
git pull

git checkout -b feature/task-1.1-mietvertrag-domain-knowledge

# Edit domain_knowledge/mietvertrag.md per the spec above

npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts

git add domain_knowledge/mietvertrag.md
git commit -m "v2: populate mietvertrag.md domain knowledge (Task 1.1)"

git push -u origin feature/task-1.1-mietvertrag-domain-knowledge
```

Report back the branch URL. Nils will open the PR and merge after CI passes.

## Acceptance gates (verify before reporting completion)

- `domain_knowledge/mietvertrag.md` is no longer a stub — front-matter is fully populated with all required entries (3 legal_grounding, 8 fields_governed, 1 normalization_rule, 4 gotchas, 6 adversarial_fixtures_required, empty closes)
- `last_updated` is today's date
- All gotchas reference real concerns (no filler entries)
- `weber_900_vs_1000` appears as `real_failure_reference` on `nachtrag_supersession`
- Free-form prose section is 300-700 words, references BGB sections inline, mentions the Weber and Paul cases by name
- `npx tsx -r dotenv/config src/tests/domain-knowledge.test.ts` exits 0 with `✓ 5 domain knowledge files validated`
- `npx tsc --noEmit` silent (no type changes, but verify)
- Branch pushed to origin with the expected commit

## Constraints

- Do NOT modify any other domain_knowledge/*.md file. Other doc types have their own Phase 1 tasks (Task 1.4 for wohnungsuebergabeprotokoll, etc.).
- Do NOT modify `domain_knowledge/_schema.yaml` (the meta-schema is locked).
- Do NOT modify `src/tests/domain-knowledge.test.ts` (the validator is locked).
- Do NOT add new gotchas beyond the four specified. Phase 1 launch scope is the four listed. Indexmiete and Staffelmiete schemas are Phase 2.
- Do NOT cite BGB sections that aren't directly relevant; over-citation dilutes the file's signal.
- Do NOT push directly to main. Use the feature branch + PR workflow.
- Pipe git commands through `| cat`.
