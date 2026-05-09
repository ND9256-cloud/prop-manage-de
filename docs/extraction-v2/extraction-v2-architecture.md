# Extraction v2 — Architecture Document

**Status:** Pass 1, draft for review.
**Owner:** Nils.
**Scope:** Architecture only. No schemas, no code, no implementation prompts.
**Length budget:** ~12 pages dense markdown. If a section does not earn its inches, it should be cut.
**Date:** 2026-05-08.

---

## 0. How to read this document

This document is the durable reference for the v2 extraction system. It will be re-read whenever a new doc type is added, a new resolver is built, a new model is evaluated, or a regression appears. It is not marketing material and not a research report. It is the architecture contract that prompts, schemas, code, evals, and the property brain must conform to.

Conventions:

- **Cited:** sourced from public engineering material. Treat as fact.
- **Inferred:** pattern-matched from indirect evidence (public APIs, blog posts, papers). Treat as reasonable but not gospel.
- **Decided:** an architectural choice made for PropManager DE specifically. Reasoning given but the decision is the artifact.
- **Open:** unresolved. Listed at the end.

The document red-teams itself in §17. Don't skip it.

The architecture is grounded throughout in real failures from KO132 and HHS55 (Weber, Paul, Kuru, Hofmann cases) documented in `pass1-context-from-build-sessions.md`. Architectural primitives that don't trace to real failures or real product needs are flagged for cutting.

---

## 1. Design principles and non-goals

### 1.1 Principles (priority order)

1. **Correct current property facts, not correct extractions.** The product surface is "what is the current Kaltmiete for unit 1.OG?" not "what was extracted from document X?". Every architectural decision is judged against whether it improves the resolved-fact answer. The Weber/Paul/Kuru cases (3 of 5 tenants in your corpus need temporal supersession) prove this is not optional — extracting €900 correctly from the Mietvertrag while the brain reports €900 as the current rent is a system failure even though the extraction was right.

2. **Auditability.** Every customer-facing important fact traces to document, field, quote, and extraction run. GoBD pushes the system toward auditability for tax-relevant records; PropManager's stricter product standard extends this principle to all customer-facing facts. Top-in-class extraction makes the audit trail cheap to maintain; mediocre extraction makes it impossible.

3. **Evolvability.** The model landscape will change in 12 months. Prompts will change in 3. Schemas will change in 6. The architecture must allow these to change without rewriting downstream layers. Versioning is first-class.

4. **Evalability.** If a change cannot be measured, it cannot be approved. Every primitive must be testable against ground truth or against a deterministic rule. "We think this is better" is not a reason to merge.

5. **Cost-awareness.** Quality at any cost is not the goal; quality at sustainable unit economics is. The $1.17 wasted on two failed Weber brain regenerations is the canonical case — incorrect upstream extraction is paid for in repeated downstream reasoning.

6. **Operational realism.** Solo builder, ~4-5 hours/week labeling, no 24/7 quality desk. The system must degrade gracefully when the human loop is interrupted.

### 1.2 Non-goals

Explicitly **out of scope** for v2:

- **Perfect legal reasoning.** Extract facts, resolve them. Don't interpret legal validity.
- **Full Nebenkostenabrechnung schema.** NKA is pressure-tested in §15. Schema deferred.
- **Full conflict-resolution graph.** One resolver (`rent_for_unit`) fully designed. Others follow the same pattern; not pre-designed.
- **Custom ML training.** All extraction via API to general models. No fine-tuning, no embeddings, no local inference.
- **Fully automated adjudication.** Human stays in the loop on disagreements. Active learning makes the human's time efficient, not absent.
- **Cross-property fact graph.** Brain works one property at a time. "This owner controls 3 properties" is v3.
- **Public quality dashboard at launch.** Gated dashboard at launch; public migration at month 4–6 contingent on gold-set diversity.

---

## 2. The pipeline, as it must be

The v1 pipeline (live now): documents → extractions (Haiku Step 5 + Sonnet Step 8b) → property brain. Extractions stored as JSONB, brain reads them ad-hoc. Works at 634 documents, will break at 6,000.

The v2 pipeline:

```
Documents
    │
    ▼
Extractions          ◄── envelope (§3), single-pass Sonnet (§11)
    │                    deterministic verifiers (§10)
    │                    multi-provider routing-ready (§9)
    ▼
Claims               ◄── temporal/snapshot/event assertions (§4)
    │                    immutable, append-only
    ▼
Resolved facts       ◄── resolvers (§5)
    │                    rent_for_unit fully designed
    ▼
Composer             ◄── deterministic snapshot assembly (§5.4)
    │                    no LLM, calls resolvers, emits PropertySnapshot
    ▼
Presenter            ◄── LLM, renders only (§5.4.6)
    │                    consumes ResolvedFact, cannot invent values
    ▼
Customer
```

Each layer has a **strict contract**. Extractions never leak into resolvers; resolvers never re-parse OCR. The contracts:

- **Documents → Extractions:** A document, OCR text, and doc_type produce an Extraction Envelope (§3).
- **Extractions → Claims:** An extraction is consumed by a **claim emitter** (one per doc_type) producing zero, one, or many claims. Claim emitters are pure functions: extraction in, claims out, no I/O. Every claim points back to its source extraction.
- **Claims → Resolved facts:** Resolvers query the claim store and return facts with provenance. A resolver answers exactly one question. Pure functions: query in, fact + provenance out.
- **Resolved facts → Composer:** A deterministic composer (§5.4) calls resolvers and assembles a `PropertySnapshot`. No LLM. No direct extraction or claim access. Pure composition.
- **PropertySnapshot → Presenter (optional):** An LLM presenter renders snapshot fields into customer-facing prose, including chat answers. The presenter cannot invent values; it can only render what the composer (via resolvers) already produced.

The boundary discipline is the entire point. v1's failure mode is the brain reading extraction JSONB directly and re-resolving inline via prompt — making every brain change a potential extraction-format change and producing the Weber/Hofmann bugs. v2 makes the boundary impermeable: the only LLM that touches customer-facing facts is the presenter, and the presenter is structurally forbidden from doing reasoning.

---

## 3. The extraction envelope

Every extracted field, regardless of doc_type, conforms to this envelope. Non-negotiable.

### 3.1 Field-level envelope

| Property | Type | Purpose |
|---|---|---|
| `raw_value` | string | Verbatim text from the document. What the model literally saw. |
| `normalized_value` | typed | Parsed/canonical form. Money as integer minor units + currency. Dates as ISO 8601. Enums as canonical keys. |
| `evidence` | object | `{ quote, page, bbox \| null }`. Quote justifies the value. |
| `confidence` | enum | `high \| medium \| low`. Calibrated against eval data, not free-form percentage. |
| `absence_state` | enum | One of 8 (§3.2). |
| `validation_status` | enum | `valid \| failed_format \| failed_verifier \| requires_human_review`. |
| `severity` | enum | `critical \| important \| nice_to_have`. Set in schema, copied into extraction for eval. |

Evidence is **mandatory** unless `absence_state` is one of the absence states. A field with a value and no evidence is rejected by the envelope validator.

**Why raw_value AND normalized_value:** the Paul case. Haiku extracted `"EG Geschoss links – mitte – rechts"` from a Mietvertrag form template — the literal checkbox-label text on the page. The semantic answer is `"EG"`. Both must be stored: `raw_value` for provenance and audit, `normalized_value` for everything downstream. If only normalized_value were stored, we couldn't audit whether the normalization was correct. If only raw_value were stored, every consumer would re-do the normalization differently.

### 3.2 The 8 absence states

A field is never just "missing" or "present." It is in one of:

1. **`present`** — value extracted with evidence.
2. **`absent`** — document does not contain this information, consistent with the doc_type. (Mietvertrag without Staffelmiete clause.)
3. **`illegible`** — OCR or scan quality prevents extraction. Information might exist; we can't read it.
4. **`ambiguous`** — multiple plausible values exist. Model must not guess. (Two different Kaltmiete values appear, possibly indicating Nachtrag.)
5. **`contradicted`** — document contradicts itself or a deterministic verifier. (Extracted amount doesn't appear verbatim in OCR.)
6. **`not_applicable`** — field not relevant to this document instance. (`vermieter_handelsregister_nummer` on a private-individual landlord's Mietvertrag.)
7. **`inferred`** — value derived rather than extracted. Evidence may point to multiple input quotes. Inferred values are second-class; resolvers may filter.
8. **`requires_human_review`** — model declined. Used when confidence is low and severity is high. Triggers triage UI.

The 8-state model exists because "optional" is a garbage bin. Without it, every sometimes-missing field is ambiguous in a different way and downstream consequences (verifiers, claim emissions, review priority) are conflated. The Hofmann case is the canonical example: tenant status was "unklar" because the brain conflated "no Kündigung exists therefore tenant is active" with "Übergabeprotokoll exists therefore tenant moved out" — different absence states with different resolver semantics.

### 3.3 Document-level envelope

| Property | Type | Purpose |
|---|---|---|
| `schema_version` | string | Schema version this extraction was produced against. |
| `prompt_version` | string | Hash or semver of the prompt used. |
| `model` | string | Provider + model identifier (`anthropic/claude-sonnet-4-20250514`). |
| `extraction_run_id` | uuid | Unique per extraction attempt. Enables replay. |
| `source_document_id` | uuid | FK to `warehouse.documents.id`. |
| `doc_type` | string | Classified doc_type. |
| `lifecycle` | object | See §3.4. |
| `human_review_status` | enum | `not_reviewed \| accepted \| corrected \| rejected`. |
| `created_at` | timestamp | When extraction was produced. |

### 3.4 The lifecycle sub-envelope

This is what makes the claim layer possible. Every extraction must answer:

| Property | Type | Purpose |
|---|---|---|
| `issue_date` | date \| null | When document was issued. |
| `effective_date` | date \| null | When document content takes effect. May differ from issue_date. |
| `signed_date` | date \| null | When signed, if applicable. |
| `expiry_date` | date \| null | When content stops being effective, if known. |
| `document_status` | enum | `draft \| active \| expired \| superseded \| cancelled \| unclear`. |
| `supersedes_document_id` | uuid \| null | Previous version this replaces. |
| `amended_by_document_id` | uuid \| null | A Nachtrag that modifies (not replaces) this. |
| `lifecycle_evidence` | object | Evidence for any non-null lifecycle field. |

Lifecycle is required for every doc_type. §4.5 addresses doc types where the temporal model genuinely doesn't fit.

---

## 4. The claim layer

### 4.1 Why claims exist

An extraction is a fact about a document. ("This Mietvertrag says Kaltmiete is €650.") A claim is a fact about the world. ("Unit 1.OG of property KO132 has Kaltmiete €650, valid from 2025-04-01, sourced from this Mietvertrag.")

The two are not the same. One Mietvertrag produces multiple claims (Kaltmiete, deposit, tenant identity, lease start). One claim may be supported by multiple extractions (a Mieterhöhung Nachtrag and the original Mietvertrag both contribute to rent history). Some extractions produce no claims (a misclassified document, or a doc_type with no resolver yet).

The Weber case is the canonical motivation. Mietvertrag extraction said €900 (correct, that's what the document said). 1. Nachtrag extraction said €1,000 (also correct). The brain wrote €900 as current rent because it had no claim layer to resolve the supersession. The brain regenerated twice trying to fix this with prompt edits. Cost: $1.17 in API calls, several hours of debugging, and a system that could regress whenever the brain prompt changed. Claims solve this once.

### 4.2 Claim schema

```
Claim {
  id: uuid
  property_id: uuid
  subject: string                 // e.g., "unit:1.OG", "property", "tenant:lena_everding"
  predicate: string               // e.g., "kaltmiete", "owner", "active_insurance"
  value: jsonb                    // typed by predicate
  claim_kind: enum                // "assertion" | "snapshot" | "event" | "reference"
  source_type: enum               // "document_extraction" | "human_adjudication" | "system_derivation"
  valid_from: date
  valid_to: date | null           // null means "currently valid" until superseded
  source_document_id: uuid | null // null only when source_type = human_adjudication with no document
  source_extraction_run_id: uuid | null
  source_field_path: string | null
  human_actor_id: uuid | null     // populated when source_type = human_adjudication
  confidence: enum
  evidence_id: uuid | null        // FK to evidence record (null for human-adjudicated without quote)
  created_at: timestamp
  superseded_at: timestamp | null
  superseded_by_claim_id: uuid | null
}
```

**The `source_type` field codifies the human-override path.** When Nils knows the current rent is €1,000 because the Mieterhöhung paper is missing or contradictory, he does not edit a resolver, does not add a UI table override, does not "quick-fix" anywhere. He creates a claim with `source_type = "human_adjudication"`. It enters the same claim store as document-derived claims, follows the same immutability rules, and is consumed by the same resolvers. Provenance is preserved (which human, when, why) via `human_actor_id` and an audit log entry.

This rule prevents the slow accumulation of override mechanisms. There is exactly one way to assert a fact in the system: emit a claim. Document-derived, human-adjudicated, system-derived — same primitive, different `source_type`.

`system_derivation` is reserved for v3 NKA-style derived claims (claim computed from other claims). v2 does not produce system-derivation claims.

### 4.3 Claim immutability

Claims are append-only. A claim is never edited. When a new fact about the same `(property_id, subject, predicate)` arrives, a new claim is appended with later `valid_from`. The previous claim's `valid_to` is set (and `superseded_by_claim_id` is set), but the claim itself is not modified.

This is the GoBD-friendly pattern. It also lets the resolver answer "what was the Kaltmiete on 2024-01-15?" without separate code.

Corrections (a human edits an extracted value in the triage UI) emit a new claim with `valid_from = original_valid_from` and `superseded_by_claim_id` referencing the original. This is distinct from a Nachtrag, which has its own `valid_from`. The claim store can distinguish "supersession by correction" from "supersession by amendment" via the type of triggering event.

### 4.4 Claim emitters

A claim emitter is a pure function: `(extraction, document_metadata) => EmissionResult`. One emitter per (doc_type, schema_version). Versioned with the schema.

```
EmissionResult {
  claims_to_insert: Claim[]        # new claims this extraction produces
  closure_intents: ClaimClosure[]  # proposed writebacks to existing open claims
}

ClaimClosure {
  target_predicate: string         # e.g., "kaltmiete"
  target_subject: string           # e.g., "unit:DG"
  target_property_id: uuid
  valid_to: date                   # the date to set on matching open claims
  reason_claim_id?: uuid           # the event claim that justifies this closure
  match_requirements: {            # additional match constraints
    tenant_identity?: string
    policy_id?: string
    ...
  }
}
```

Emitters are pure: extraction in, EmissionResult out, no I/O. They do not read the claim store. They do not write to the claim store. They produce **intent** — claims to insert and closures to apply. A separate **claim-store transaction applier** validates and applies both atomically (§5.5).

Example for Mietvertrag:

```
mietvertrag_claim_emitter(extraction):
  if extraction.lifecycle.document_status == "draft":
    return EmissionResult([], [])                  # drafts produce nothing
  if extraction.lifecycle.document_status == "cancelled":
    return EmissionResult([], [closure_for_cancelled_lease])

  claims = []
  if extraction.fields.kaltmiete.absence_state == "present":
    claims.push(Claim(
      claim_kind = "assertion",
      subject = f"unit:{extraction.fields.unit_ref.normalized_value}",
      predicate = "kaltmiete",
      value = extraction.fields.kaltmiete.normalized_value,
      valid_from = extraction.lifecycle.effective_date,
      valid_to = null,
      source_type = "document_extraction",
      ...
    ))
  # similar for deposit, tenant, lease_start, lease_end
  return EmissionResult(claims, [])  # Mietvertrag itself emits no closures
```

Example for Mieterhöhung Nachtrag:

```
mieterhoehung_claim_emitter(extraction):
  new_claim = Claim(
    claim_kind = "assertion",
    subject = f"unit:{extraction.fields.unit_ref.normalized_value}",
    predicate = "kaltmiete",
    value = extraction.fields.new_kaltmiete.normalized_value,
    valid_from = extraction.fields.effective_date.normalized_value,
    valid_to = null,
    source_type = "document_extraction",
    ...
  )
  closure = ClaimClosure(
    target_predicate = "kaltmiete",
    target_subject = new_claim.subject,
    target_property_id = extraction.property_id,
    valid_to = new_claim.valid_from - 1 day,
    reason_claim_id = new_claim.id,
    match_requirements = {}
  )
  return EmissionResult([new_claim], [closure])
```

The emitter never touches the database. The transaction applier (§5.5) takes the EmissionResult, validates closures against safety rules (only close open claims, only same property, only allowed predicate pairs, require tenant match where configured), and applies everything in one transaction.

Emitters are testable in isolation with no database. CI test: assert emitter source files do not import any database client, claim store module, or async I/O primitive.

**Derived claims (claims that depend on existing claims) are NOT produced by emitters.** This is the v3 NKA case: NKA needs to compute "sum of Vorauszahlungen for period" from existing rent claims. That is a separate primitive — a **derivation job** — explicitly distinct from emitter behavior. See §17 for the NKA architectural extension.

All non-trivial doc-type-specific business logic (what claims to emit, when, with what validity) lives in the emitter. The resolver layer doesn't get raw extractions; the prompt layer doesn't get database access. Layers are clean.

### 4.5 Doc-type taxonomy: the snapshot/event problem

ChatGPT correctly flagged that the temporal-validity model breaks for some doc types. The context document confirms this with the Hofmann/Übergabeprotokoll case. Taxonomy:

**Type A — Temporal-assertion documents.** The document asserts something is true over a time range. Mietvertrag, Versicherungspolice, Mieterhöhung. Claim layer fits naturally: `valid_from` = effective date, `valid_to` = expiry or superseded.

**Type B — Snapshot documents.** Document captures state at a moment. Zählerstandsprotokoll, Energieausweis (asserts a state on the issue date that's *assumed* stable until invalidated, but isn't a temporal assertion in the legal sense). Claim model handles by setting `valid_from = observed_at`, `valid_to = null`, and `claim_kind = "snapshot"`. Resolvers query snapshot claims with semantics like "what was the meter reading nearest to date X?" rather than "what is currently valid?".

**Type C — Event documents.** Document records that something happened. Kündigung, Mahnung. These don't extend over time. They are events with consequences. Emitter produces a claim with `predicate` like `lease_terminated`, `value = null`, `valid_from = event_date`, `valid_to = event_date`, `claim_kind = "event"`. The event triggers downstream side effects via a "claim closer" job (e.g., a Kündigung event causes the corresponding Mietvertrag's Kaltmiete claim to gain a `valid_to` of the Kündigung date).

**Type D — Reference documents.** Document is a static fact about an entity. Grundbuchauszug (mostly), Grundsteuerbescheid (for the assessment year). Behaves like Type A but with weaker time semantics — typically `valid_from = issue_date`, `valid_to = null` until a new version arrives.

**The Wohnungsübergabeprotokoll exception.** The context document is explicit: Übergabeprotokoll is *three different documents under one name* depending on the `uebergabe_typ` field:

- `uebergabe_typ = "Einzug"` → Type C event (tenant moves in). Triggers tenant-active claim emission.
- `uebergabe_typ = "Auszug"` → Type C event (tenant moves out). Triggers tenant-active claim closing.
- `uebergabe_typ = "Eigentümerwechsel"` → Type C event (ownership transfers). Triggers owner claim emission. **Does NOT invalidate tenant claims.** This is the Hofmann bug.
- `uebergabe_typ = "unklar"` → emit no claims, force human review.

The Übergabeprotokoll schema must extract `uebergabe_typ` as a critical-severity field with explicit enum values. The emitter dispatches on this value. This is not optional cleverness — it is the load-bearing decision that prevented the system from understanding Hofmann's tenancy.

The architecture **labels claim_kind explicitly per doc_type schema**. The schema YAML declares it. Emitters dispatch on it. Resolvers handle it. Without this, snapshots get forced into temporal-assertion semantics and information is silently lost.

### 4.6 DerivationRecord: tracking what depends on what

Once the system has claims, closures, resolved facts, snapshots, and (in v3) derived claims, a question becomes inevitable: **when something changes, what must be recomputed or invalidated?**

If a normalization rule for `kaltmiete` changes, which extractions need re-running? If a Mieterhöhung emitter version bumps, which closures need re-applying? If a domain knowledge gotcha for Übergabeprotokoll is updated, which claims become suspect? Six months in, without an answer, the system either over-recomputes (expensive) or under-recomputes (silently stale).

A lightweight primitive solves this without building a graph database:

```
DerivationRecord {
  id: uuid
  output_type: enum                 // "claim" | "closure" | "resolved_fact" |
                                    //  "property_snapshot" | "derived_claim"
  output_id: uuid                   // FK into the corresponding table
  input_claim_ids: uuid[]           // claims this output depends on
  input_extraction_run_ids: uuid[]  // extractions this output derives from
  rule_refs: string[]               // domain knowledge file refs
                                    // e.g., "domain_knowledge/mieterhoehung.md#nachtrag_supersession"
  emitter_version: string | null
  resolver_version: string | null
  composer_version: string | null
  created_at: timestamp
}
```

Every time the system **derives** something — a claim from an extraction, a closure from an event claim, a ResolvedFact from claims, a PropertySnapshot from resolvers — it writes a DerivationRecord linking output to inputs and the rule versions used.

This is not a DAG database. It is a flat append-only log of "this came from those, using these rules." The system never traverses the log graph-style; it only queries it on specific events:

- **Rule change:** "find all DerivationRecords with `rule_refs` containing X" → list of outputs to re-derive.
- **Cache invalidation:** PropertySnapshot composed_at + claim_snapshot_version is a hash over its DerivationRecord. New claim arrives → hash changes → cache invalidated for that property.
- **Audit explanation:** "why did this PropertySnapshot say €1,000?" → DerivationRecord shows resolver version, rule refs, claim IDs, extraction IDs. The chain is reconstructable in seconds, not via prompt archaeology.
- **Emitter version bump:** "find all claims with `emitter_version < N` for doc_type X" → re-emission candidate list.
- **Shadow comparison (legacy brain vs composer migration, §5.4.9):** for each property, compare the composer's PropertySnapshot to the legacy brain's output, log divergences with full DerivationRecord context.

The DerivationRecord is what makes the architecture's correctness *operationally maintainable*. Without it, every rule change triggers either a paranoid full recompute or a silent stale-data risk.

**Scope discipline:** DerivationRecords are written, never read in customer-facing hot paths. Reading is for tooling, audit, and migration jobs. The normal pipeline never traverses derivation graphs.

**Storage decision: separate `warehouse.derivation_records` table.** Not a JSONB column on claims/closures/snapshots. Reasoning:

1. **Query patterns.** "What outputs derived from this extraction run?" and "What outputs reference this domain rule?" are common audit/migration queries. Both are clean SQL on a normalized table; both are awkward against JSONB (full table scans, brittle indexes).
2. **GIN index on `input_claim_ids` UUID array** supports the NKA dependency-invalidation case (in v3): "find all derivation records whose input_claim_ids contain claim X" is a fast indexed lookup.
3. **Tenant isolation gate.** A separate model annotated `@tenant-scoped-via property_id` fits the existing CI gate cleanly. JSONB inside another tenant-scoped row would still be tenant-isolated but the static-analysis story is messier.
4. **GoBD-friendly.** Append-only by design (no UPDATE permitted; same trigger-blocked-DELETE pattern as `warehouse.documents`).
5. **Migration cost is small.** ~30 minutes of generator code time vs. years of slower audit queries.

The trade-off is one extra table in the schema. Worth it.

---

## 5. The resolution layer

### 5.1 Resolvers in general

A resolver is a pure function: `(query_parameters, as_of_date) => ResolvedFact`. Answers exactly one question. Queries the claim store, applies resolution rules, returns a fact with provenance.

```
ResolvedFact {
  query: { subject, predicate, as_of_date, ... }
  value: jsonb | null              # null if no claim resolves
  confidence: enum
  source_claim_ids: uuid[]         # the chain of claims used
  source_document_ids: uuid[]
  resolution_rule_applied: string  # e.g., "latest_active_claim"
  conflicts: Conflict[] | []
  generated_at: timestamp
}
```

Resolvers do not access extractions or documents directly. They access the claim store. Boundary enforced.

Resolvers do not contain doc-type-specific logic. If a resolver needs to know "Mietvertrag Nachträge supersede the parent contract's rent," that logic belongs in the **claim emitter for Nachtrag** (which sets `valid_from` correctly), not in the rent resolver. The resolver only knows about claims.

### 5.2 The `rent_for_unit` resolver, end-to-end

**Question:** "What is the Kaltmiete for unit `<unit_ref>` of property `<property_id>` as of date `<as_of_date>`?"

**Inputs:**
- `property_id: uuid`
- `unit_ref: string` (canonical: "EG", "1.OG", "DG")
- `as_of_date: date` (default: today)

**Algorithm:**

1. Query claim store: all claims where `property_id = X`, `subject = "unit:<unit_ref>"`, `predicate = "kaltmiete"`, `claim_kind = "assertion"`, `valid_from <= as_of_date`, `(valid_to IS NULL OR valid_to > as_of_date)`.
2. **Zero claims:** return `value = null, confidence = low, resolution_rule = "no_active_claim"`. (Lena Everding case if her Mietvertrag hasn't been processed yet.)
3. **One claim:** return that claim's value, confidence = claim's confidence, `resolution_rule = "single_active_claim"`. (Hofmann: simple case, original Mietvertrag's claim is the only active one.)
4. **Multiple claims (the conflict case):**
   - Sort by `valid_from` descending, then `created_at` descending.
   - Take the most recent. This is `winner`.
   - Other claims become `Conflict` entries with reason `"superseded_by_later_claim"`.
   - Return winner's value, `resolution_rule = "latest_active_claim_with_conflicts"`.
5. **Confidence downgrade:** if any conflicts existed, downgrade confidence by one step.

**Walkthrough against the five real cases from KO132/HHS55:**

- **Lena Everding (KO132 1.OG, €650, 2025):** Mietvertrag emits one assertion claim, `valid_from = 2025-04-01`, `valid_to = null`. Resolver returns €650, `single_active_claim`, confidence = high.
- **Julija Paul (KO132 EG, €575, original €525):** Mietvertrag emits claim A (€525, `valid_from = 2022-06-01`). Mieterhöhung document emits claim B (€575, `valid_from = effective_date_of_increase`). Mieterhöhung emitter additionally sets claim A's `valid_to` to the day before B's `valid_from`. As-of-today, only B satisfies the query. Resolver returns €575, `single_active_claim` (because A is no longer in the result set), confidence = high.
- **Saniye Kuru (KO132 DG, €470, original €440):** Same pattern as Paul.
- **Weber GmbH (HHS55 1.OG, €1,000, original ~€900):** Mietvertrag emits claim A (€900, `valid_from = 2010-06-01`). 1. Nachtrag emits claim B (€1,000, `valid_from = 2015-01-01`). Same pattern. Resolver returns €1,000.
- **Dr. Hofmann (HHS55 DG, €900, no Nachträge):** Mietvertrag emits one claim. Resolver returns €900, `single_active_claim`. **Does NOT pick up the November 2025 Eigentümerwechsel-Übergabeprotokoll** because that document's emitter (Type C event with `uebergabe_typ = "Eigentümerwechsel"`) emits an owner claim, not a tenant claim, and does not close any tenant claims. The Hofmann bug is now structurally debuggable: a wrong answer would require a wrong `uebergabe_typ` extraction, a wrong emitter dispatch, or a wrong resolver — each isolated, testable, and reproducible. See §5.4.7 for the precise meaning of "structurally debuggable."

**Edge cases the resolver handles:**

- **Mieterhöhung Nachtrag:** Nachtrag's emitter returns an EmissionResult with the new claim (valid_from = effective_date_of_increase) AND a closure_intent targeting the previous Kaltmiete claim (valid_to = effective_date - 1). The transaction applier (§5.5) inserts the new claim and applies the closure atomically. The emitter itself does no I/O.
- **Kündigung:** Kündigung emitter returns an `EmissionResult` containing a `lease_terminated` event claim AND a closure intent for the corresponding tenant's Kaltmiete claim. The transaction applier (§5.5) inserts the claim and applies the closure atomically. No separate cron job; no eventual-consistency window.
- **Two competing Mietverträge (data error or fraud):** both produce assertion claims with overlapping intervals. Resolver returns winner = latest, conflicts = the others, confidence downgraded. Triage UI surfaces.
- **Indexmiete clause:** Mietvertrag emitter notes the clause type but emits a claim for the *current* rent. A separate job recomputes index-adjusted rents periodically and emits new claims with `valid_from` matching index dates.
- **`as_of_date` before any claim:** returns `value = null, resolution_rule = "no_claim_for_date"`.

**What this resolver does NOT contain:**
- No knowledge of Mietvertrag structure
- No OCR text parsing
- No prompt invocation
- No multi-doc-type joins ("does this property have active insurance" is a different resolver)
- No write operations *except* the controlled Nachtrag write-back, which is in the Mieterhöhung emitter, not the resolver

This is the template. Other resolvers (`owner_of_property`, `active_insurance_for_property`, `last_meter_reading_for_unit`) follow the same shape.

### 5.3 The "resolver as dumping ground" failure mode

ChatGPT flagged that resolvers must not become a dumping ground for unresolved extraction ambiguity. Real risk. The discipline:

- If extraction is ambiguous, the field's `absence_state` is `ambiguous` and the emitter emits no claim.
- If the document is a draft, the emitter emits no claims.
- If two documents contradict each other, both emit claims and the resolver flags the conflict.
- The resolver is **never** the place where "we couldn't figure out which value is right" gets handled with prompt-based reasoning.

CI test: assert that resolvers do not call any LLM API and do not import any prompt module. Mechanically enforced.

### 5.4 The composer and presenter pattern (the brain, decomposed)

**The boundary statement.** In v2, the brain is not a reasoning system. It is decomposed into a deterministic **composer** that assembles resolver outputs and an optional LLM **presenter** that renders already-resolved facts. Any component that reads raw extraction outputs and infers current property facts is part of the resolver layer, not the brain.

#### 5.4.1 What the v1 brain is and what it isn't

The current `scripts/generate-brain.js` plays two roles, and conflating them is the source of the Weber and Hofmann bugs:

- **Role A — Aggregation.** Take 100+ documents about a property, summarize what's there.
- **Role B — Reasoning under uncertainty.** Resolve conflicts across documents into current facts.

Role A is genuine product value. Role B is what the resolver layer (§5.1–§5.3) exists to do. The current brain does Role B via prompt — which is exactly the pattern that produced "current rent = €900" in the Weber case (extraction said €900, the Nachtrag was processed separately, the brain reconciled them via prompt and got it wrong).

**Decision: the v1 brain is deprecated, not improved.** Its use cases (property summary, chat) are preserved. Its implementation is replaced.

#### 5.4.2 The three-component split

```
PropertySnapshot (data)
    ▲
    │ produced by
    │
Composer (deterministic, no LLM)
    ▲
    │ calls
    │
Resolvers (§5)
```

```
User question / request for prose summary
    ▼
Intent parser / query planner (LLM-assisted, produces QueryPlan)
    ▼
Resolver call(s)
    ▼
ResolvedFact (with provenance, explanation, status)
    ▼
Presenter (LLM, renders only)
    ▼
Customer-facing answer with provenance
```

Three components: **composer** (assembles snapshots), **planner** (routes chat questions to resolvers), **presenter** (renders prose from resolved facts). The composer and planner are decision-makers; the presenter is a rendering surface.

#### 5.4.3 The composer

The composer takes a property and assembles a `PropertySnapshot` by calling resolvers. Pure TypeScript, no LLM calls.

```
PropertySnapshot {
  core: CorePropertySnapshot           # always present
  modules: {
    rent_roll?: RentRollSnapshot       # lazy
    ownership?: OwnershipSnapshot      # lazy
    insurance?: InsuranceSnapshot      # lazy
    costs?: CostSnapshot               # lazy
    handover?: HandoverSnapshot        # lazy
    ...
  }
  metadata: {
    composed_at: timestamp
    claim_snapshot_version: string     # hash of relevant claim IDs
    resolver_versions: { [name]: version }
    completeness: { [module]: "complete" | "partial" | "unavailable" }
    warnings: Warning[]
  }
}
```

The module split matters. The composer does NOT call all resolvers blindly. Surfaces request the modules they need; composer satisfies on demand. This prevents the snapshot becoming a gravity well where every future resolver gets dumped into a single mega-object.

**Module categories:**

- **Default modules** (always composed): core property metadata, current rent_roll, current ownership. Cheap to resolve, shown on dashboard.
- **Lazy modules** (composed on request): insurance status, cost summaries, handover history. Computed when a surface asks.
- **Experimental / feature-flagged modules**: anything new. Hidden behind eval gates until accuracy is proven.

#### 5.4.4 ResolvedFact: the unit of currency

Every important fact in a `PropertySnapshot` is wrapped:

```
ResolvedFact<T> {
  value: T
  confidence: "high" | "medium" | "low"
  status: "resolved" | "conflicted" | "missing" | "stale" | "unsupported"
  provenance: ProvenanceRef[]          # claim IDs + document IDs + quotes
  explanation: StructuredExplanation   # machine-readable reasoning chain
  resolver: { name: string, version: string }
}
```

The composer produces these. The presenter consumes them. The presenter cannot construct one. This is what enables chat to answer "Warum steht da €1.000?" without an LLM reconstructing reasoning — the explanation is already attached.

#### 5.4.5 The intent parser (chat routing)

A user's chat question goes through a planner before reaching resolvers:

```
User: "Was zahlt Hofmann aktuell?"
  ▼
Intent parser (LLM-assisted)
  ▼
QueryPlan {
  intent: "current_rent_for_tenant"
  entities: { tenant_name: "Hofmann" }
  required_resolvers: ["resolve_units_for_tenant", "rent_for_unit"]
  answer_mode: "authoritative_resolved_fact"
  ambiguity_status: "resolvable"
  clarification_needed: null
}
  ▼
Resolver execution → ResolvedFact[]
  ▼
Presenter renders answer with provenance
```

**Three answer modes**, set by the planner based on whether resolvers exist for the question:

```
AnswerMode =
  | "authoritative_resolved_fact"     # resolver(s) cover this question
  | "document_search_summary"         # no resolver covers it, but documents are searchable
  | "not_supported"                   # neither path applies
```

**`authoritative_resolved_fact`** is the default and the only mode that produces current property facts. Behavior described above.

**`document_search_summary`** is the controlled escape hatch for exploratory questions where no resolver exists but documents and metadata are still useful. Example: "Are there any unusual costs in 2025?". No `unusual_cost_detection` resolver exists. The planner routes to document_search_summary mode. The presenter is allowed to:

- Retrieve relevant documents (full-text search, doc_type filter, date filter)
- Surface already-extracted line items from those documents
- Surface verifier flags (`failed_verifier`, `requires_human_review`) on those documents
- List candidate items with citations to source documents

The presenter in this mode **must not**:
- Calculate derived values ("total costs are X")
- Choose between conflicting claims
- Conclude whether something is "unusual" or "high"
- Produce a current property fact
- Resolve ambiguity from the documents

The answer is explicitly labeled as **exploratory**, not authoritative. The presenter prefaces with "Ich habe keine endgültige Antwort darauf, aber folgende Dokumente sind relevant…" or similar. The customer sees retrieval, not reasoning.

This preserves usefulness without recreating Brain v2 through the chat side door. The line is: **the system can always retrieve and surface evidence; it can only resolve facts when a resolver exists.**

**`not_supported`** is reserved for questions where neither resolution nor meaningful retrieval applies (questions about other properties, requests for legal advice, etc.). The presenter says so explicitly.

**The hard rule (refined):** the LLM may choose which resolver to call OR route to document_search_summary. It may never answer the resolver's question itself, never produce a current property fact in summary mode, never invent values not present in retrieved documents. **The system never produces an authoritative answer without a resolver.** This is the structural prevention of "helpful chat" silently becoming Brain v2.

The planner can be LLM-assisted because routing is bounded reasoning over a known list of resolvers and a known answer-mode taxonomy. The output is a constrained plan structure, not facts.

#### 5.4.6 The presenter — explicit constraints

The presenter consumes `PropertySnapshot` or `ResolvedFact[]` and produces customer-facing prose. It is the only LLM call in the brain replacement.

**The presenter MUST NOT:**
- Read raw OCR text
- Read `document_intelligence` rows directly
- Read claims directly
- Infer current facts from extracted claims
- Resolve conflicts between competing claims
- Choose between alternative values
- Introduce values not present in the input ResolvedFact / PropertySnapshot
- Suppress provenance for critical or important facts
- Answer questions for which no resolver exists

**The presenter MAY:**
- Summarize resolved facts in natural German
- Explain provenance already attached to resolved facts
- Render uncertainty already computed by resolvers (e.g., "Die Kaltmiete ist mit hoher Sicherheit €1.000.")
- Translate structured `StructuredExplanation` objects into prose ("…seit Januar 2015 laut 1. Nachtrag zum Mietvertrag")
- Refuse questions not covered by resolvers ("Diese Frage kann ich aktuell nicht beantworten.")

These constraints are CI-enforced where possible (test: presenter input must be `ResolvedFact[]`-typed, presenter cannot import claim store or extraction modules) and prompt-enforced where not (test: a small adversarial fixture set asks the presenter to invent values, expects refusal).

#### 5.4.7 What "structurally debuggable" actually means

Earlier drafts of this document used phrasing like "Weber bug structurally impossible." That overclaims. The honest formulation:

**With v2 architecture, the Weber bug is wrong only if extraction, claim modeling, resolver logic, or source documents are wrong — not because an LLM silently re-resolved the fact differently.**

Resolvers don't make correctness automatic. They make failures **localized, reproducible, inspectable, and testable**. When the rent shown is wrong, you can:

1. Read the resolver's output: which claims did it use?
2. Inspect those claims: which extractions produced them?
3. Inspect those extractions: which documents and which fields?
4. Each layer is testable in isolation.

The v1 brain's failure mode was that all of these were entangled in a single prompt. Debugging meant prompt archaeology. v2's failure mode is that *one specific layer* is wrong, and you can find which one in minutes.

#### 5.4.8 The Blackstone JSON: compatibility, not destiny

The current brain produces a Blackstone-format JSON (11 sections). This format is consumed by existing UI surfaces. **Decision: the composer initially emits a Blackstone-compatible projection for backward compatibility, but the canonical v2 output is `PropertySnapshot`.** Surfaces are migrated to consume `PropertySnapshot` directly over time. Once no surface depends on the Blackstone projection, it is deleted.

The Blackstone format was shaped by v1 prompt limitations. Treating it as the canonical v2 contract would freeze those limitations into the architecture. The composer is designed around resolved facts, provenance, uncertainty, and module boundaries — those are the v2 primitives.

#### 5.4.9 Migration: kill switch, not parallel run

During migration there may be a period where the legacy brain still exists alongside the composer. **This is dangerous and must be tightly bounded.**

**Hard rule:** No customer-facing surface may display a current fact from both legacy brain output and resolver/composer output. Current facts come from the composer only. The legacy brain may run in **shadow mode** for comparison/eval purposes, but its output is never shown to customers during the migration window.

If a divergence between legacy brain and composer is detected, the surface shows the composer's value (with provenance) and an internal warning is logged for investigation. The legacy brain's value is never the customer-facing source of truth, even temporarily.

Migration order:
1. Composer + presenter built and tested against KO132/HHS55.
2. Composer's output replaces brain output on all customer-facing surfaces, in one cutover.
3. Legacy brain runs in shadow mode for 30 days for eval comparison.
4. If shadow comparison shows composer ≥ brain on quality metrics, legacy brain is deleted.
5. Domain rules from `scripts/generate-brain.js` are migrated to claim emitters and domain knowledge files **before** the cutover, not after.

The brain prompt that currently encodes "Wenn Nachträge zum Mietvertrag existieren, verwende die aktuelle Miete aus dem neuesten Nachtrag" disappears. That rule lives in the Mieterhöhung claim emitter (which returns a new claim plus a closure_intent for the previous claim) and in `domain_knowledge/mieterhoehung.md` (the gotcha). The presenter doesn't know about Nachträge; it just renders whatever ResolvedFact the resolver produced.

#### 5.4.10 Cost and performance

| Aspect | Legacy brain | Composer + presenter |
|---|---|---|
| Property summary regeneration | LLM call, ~$0.10-0.50, seconds | DB queries + composition, <$0.001, milliseconds |
| Chat question answering | LLM with full context, ~$0.05-0.20 | Planner LLM (small) + resolver query + presenter LLM (small), ~$0.02-0.05 |
| Cost when underlying data changes | Full regeneration | Only affected resolver re-runs; cached snapshots invalidated by claim hash |
| Determinism | Same data, different answers possible | Same claims → identical PropertySnapshot |
| Provenance | None in output | Attached to every important fact |
| GoBD audit trail | Reasoning step opaque | Full chain claim → extraction → document → quote |

Migration cost is real but bounded: ~600 lines of brain prompt + script replaced by ~200-300 lines of composer + ~100 lines of planner + ~150 lines of presenter prompt. Domain rules from the brain prompt migrate to emitters and domain knowledge files, where they belong.

### 5.5 The claim-store transaction applier and closure pattern

§5.2 references closure of open claims when an event-kind claim arrives: when a Kündigung is processed, the lease_terminated event needs to set `valid_to` on the matching active Kaltmiete claim. Without closing, terminated tenants still resolve as active. This is load-bearing for `rent_for_unit` correctness from day one.

#### 5.5.1 The pattern

**Claim closing is emitted synchronously, applied transactionally — by the claim-store transaction applier, not by emitters.**

Emitters return EmissionResult containing `claims_to_insert` and `closure_intents` (§4.4). They do no I/O. A small, auditable claim-store transaction applier takes the EmissionResult and:

1. Validates the closures against safety rules (see 5.5.4).
2. Performs claim-aware blocker checks (see 5.5.5).
3. Inserts the new claims.
4. Applies the closures using the closure intent's declared `close_mode` (see 5.5.3).
5. Writes a DerivationRecord (§4.6) capturing what was emitted/closed and why.
6. Commits, or rolls back the whole batch on any failure.

This pattern keeps emitters pure and testable, while preserving synchronous consistency for customer-facing facts. A bad emitter can propose a bad closure, but the applier's safety rules catch it before any DB state changes.

#### 5.5.2 Closing matrix

A handful of event types have closing semantics. Codified per doc type in domain knowledge front-matter, applied by the transaction applier. Each closing rule declares its target predicates, match criteria, and `close_mode`:

| Triggering event | Closes | Match criteria | close_mode |
|---|---|---|---|
| `lease_terminated` (Kündigung) | Active `kaltmiete`, `nebenkostenvorauszahlung`, `kaution`, `tenant_active` claims for the same `(property_id, subject=unit:X)` | tenant identity match required | `close_overlapping_and_future` |
| `policy_terminated` (Versicherungs-Kündigung) | Active `active_insurance` claim for `(property_id, subject=property)` | policy_id match | `close_overlapping_and_future` |
| `ownership_transferred` (Eigentümerwechsel via Übergabeprotokoll or Kaufvertrag) | Active `owner` claim for `(property_id, subject=property)` | none | `close_overlapping_and_supersede_future` |
| `tenant_moved_out` (Übergabeprotokoll Auszug) | Same as `lease_terminated` | tenant identity match | `close_overlapping_and_future` |
| `kaltmiete_amended` (Mieterhöhung / Mietvertragsnachtrag-rent-change) | Active `kaltmiete` claim for `(property_id, subject=unit:X)` | unit_ref match required, tenant identity optional | `close_overlapping_only` |

**`ownership_transferred` does NOT close tenant claims.** This is the Hofmann case codified. The transaction applier rejects an EmissionResult whose closure_intents would close tenant claims via an ownership-transfer event. CI test verifies.

#### 5.5.3 The three close_modes

Different closing rules need different temporal semantics. Closing only the currently-open claim ("close at most one claim per predicate") is wrong for some cases and right for others. The architecture defines three `close_mode` values, declared per closing rule:

**`close_overlapping_only`** — sets `valid_to` on currently-open claims whose interval overlaps the closure date. SQL: `WHERE property_id = ? AND subject = ? AND predicate = ? AND valid_from <= $closure_date AND (valid_to IS NULL OR valid_to > $closure_date)`. Used by Mieterhöhung — the previous Kaltmiete is superseded by the new one, but pre-emitted Staffelmiete claims with future `valid_from` should NOT be closed (they are legitimate future rent steps).

**`close_overlapping_and_future`** — additionally invalidates claims with `valid_from > closure_date`. SQL adds `OR valid_from > $closure_date` to the WHERE clause. Used by Kündigung — the lease ends, so any pre-emitted future Mieterhöhungen on this lease become invalid (the lease they would have applied to no longer exists).

**`close_overlapping_and_supersede_future`** — same query as `close_overlapping_and_future`, but writes `superseded_by_claim_id` (not just `valid_to`) to preserve chain integrity. Used by Eigentümerwechsel — the previous owner's claim is closed, and any speculative future-dated owner claims are explicitly superseded with a chain reference for audit.

The closure intent shape:

```
ClosureIntent {
  target_subject: string                 // e.g., "unit:EG"
  target_predicates: string[]            // e.g., ["kaltmiete", "tenant_active", ...]
  close_at: date                         // closure date drives valid_to
  close_mode: "close_overlapping_only"
            | "close_overlapping_and_future"
            | "close_overlapping_and_supersede_future"
  match: {
    tenant_identity?: string
    policy_id?: string
    lease_id?: string
  }
  match_strictness: "required" | "optional" | "absent"
  blocker_status: "none" | "requires_review"  // emitter-set; applier respects
}
```

#### 5.5.4 Transaction applier safety rules

The applier validates every closure_intent against:

- **Only close open or future claims as appropriate to close_mode.** `close_overlapping_only` cannot close future claims. `close_overlapping_and_future` and `close_overlapping_and_supersede_future` may. Each mode has its declared SQL pattern and the applier rejects mode/query mismatches.
- **Same property.** A closure cannot reach across `property_id` boundaries.
- **Allowed predicate pairs.** A closure's `target_predicate` must be in an allowlist for the triggering event predicate. (`lease_terminated` may close `kaltmiete`, may NOT close `owner`.) The allowlist is generated from domain knowledge front-matter.
- **Match requirements satisfied per match_strictness.** If `match_strictness: "required"` and the closure specifies `match: { tenant_identity: "X" }`, the applier verifies the target claim's tenant identity matches via the fuzzy-match function (see 5.5.6). Failure = closure rejected. If `match_strictness: "optional"`, fuzzy match is attempted; failure = closure proceeds with confidence downgrade rather than rejection.
- **No retroactive reach into already-superseded history.** Closures cannot modify claims that already have a `superseded_by_claim_id`. Already-superseded historical claims are immutable beyond the original closure that retired them.
- **blocker_status respected.** If the emitter set `blocker_status: "requires_review"` (e.g., Mieterhöhung detected open Staffelmiete claims), the applier inserts the new claim but does NOT apply the closure. The case surfaces in triage; human creates an explicit human-adjudication closure if appropriate.
- **Logged provenance.** Every applied closure writes a DerivationRecord linking the closure to its triggering event claim.

If any closure fails validation, the entire EmissionResult is rejected — no partial application. The extraction is logged as `failed_applier_validation`, surfaced for human review.

#### 5.5.5 Claim-aware blockers

Some closure prerequisites require the applier to query the claim store before deciding whether to apply a closure. These are NOT extraction-time decisions because the extracted document alone doesn't have enough information. The applier checks:

- **Multi-tenant partial termination check.** For Kündigung-triggered closures, the applier queries: `SELECT * FROM warehouse.claims WHERE property_id = ? AND subject = ? AND predicate = 'tenant_active' AND valid_to IS NULL`. If the count of currently-active tenants exceeds the count of terminating parties extracted from the Kündigung document, OR if not all active tenants are present in the terminating-parties list (per fuzzy match), the applier marks the closure with `blocker_status: "requires_review"` and does not apply it. The new event claim is still inserted; the closure is suspended.
- **Eigentümerwechsel + vacant-possession check.** For Eigentümerwechsel-triggered closures, if the source extraction contains language indicators like `"mietfrei"`, `"geräumt"`, `"bezugsfrei"` (declared in domain knowledge front-matter), the applier emits an `occupancy_conflict` warning event but applies the owner closure normally. Vacant-possession language never causes tenant-claim closure (this is the Hofmann safeguard).
- **Mieterhöhung + Staffelmiete conflict check.** If a Mieterhöhung emits a closure_intent for `kaltmiete` and the applier finds open future-dated Staffelmiete claims for the same unit, the closure is marked `requires_review` and the case surfaces in triage. The new Mieterhöhung claim is inserted; the previous Kaltmiete is NOT auto-closed pending human decision about whether the bilateral amendment supersedes the Staffelplan.

These checks are explicitly in the applier rather than the emitter because they require reading the claim store, which would violate emitter purity (§4.4).

#### 5.5.6 Tenant identity fuzzy matching

Tenant names appear differently across documents. "Max Müller" in the Kündigung may match "Müller, Max" or "Max Heinrich Müller" in the original Mietvertrag. The applier uses a deliberately simple fuzzy-match function:

1. Normalize both names: lowercase, strip Anrede ("Herr", "Frau", "Dr."), split on whitespace and commas into token sets.
2. Check if the smaller token set is a subset of the larger token set.
3. Exact subset → match, full confidence.
4. Partial overlap (some tokens match, some don't) → match flagged for review.
5. No overlap → no match.

**No Levenshtein distance.** It produces false positives on short German names (e.g., "Bauer" vs "Baumer" are very close edit-distance but legally different people). Token-subset matching is conservative — it misses some legitimate matches (forcing review) but rarely produces false positives.

This function lives in the applier, has no LLM dependency, and is unit-tested with German-name fixtures.

#### 5.5.7 Implementation discipline

- **Synchronous, transactional.** Applier operates in the same DB transaction as event-claim insertion. No cron, no eventual-consistency window.
- **Idempotent on retry.** Applying the same EmissionResult twice produces identical state — duplicate-claim insert is rejected by uniqueness constraint, closure of already-closed claim is the validation failure above.
- **Partial index for the common query.** The migration adds `CREATE INDEX idx_claims_open ON warehouse.claims (property_id, subject, predicate) WHERE valid_to IS NULL`. This makes "find currently-active claims" O(log n) regardless of historical claim volume.
- **CI test per closing rule.** A fixture-based test asserts each closing rule fires correctly across all three close_modes: insert a Mietvertrag → assert open Kaltmiete claim. Insert matching Kündigung → assert Kaltmiete and future Mieterhöhung claims both closed. Insert matching Mieterhöhung → assert previous Kaltmiete closed but future Staffelmiete claims untouched.
- **Bounded blast radius.** A bad emitter cannot corrupt the claim store — only propose corrupting it. The applier's validation is the firewall.

#### 5.5.8 What this is NOT

- **Not a separate cron job.** Eventual consistency creates customer-visible windows of stale state. Rejected.
- **Not a generic rule engine.** The closing matrix is enumerated per doc type. A generic "when X happens, do Y" engine is the kind of premature abstraction that becomes a debugging nightmare.
- **Not LLM-decided.** Closures are deterministic enum dispatch, never model reasoning.
- **Not emitter-owned.** Emitters propose; the applier disposes. This is the load-bearing distinction.
- **Not order-dependent.** The closure logic is interval-aware (close_mode declares semantics), so processing a Kündigung after a Mieterhöhung produces the same final state as processing them in chronological order.

---

## 6. The domain knowledge layer

### 6.1 The problem

German real-estate rules currently live in: brain prompt (`scripts/generate-brain.js`), Step 5 extraction prompts, Step 8b intelligence prompts, future `extraction_schemas.ts`, your head, and the eventual research wiki. When a court ruling clarifies "Kaltmiete vs. Grundmiete," that update has to land in five places. It won't.

### 6.2 The solution

One markdown file per doc_type at `domain_knowledge/<doc_type>.md`. Strict front-matter schema. Consumed by tests. If a consumer ignores it, the tests fail.

### 6.3 File format

```markdown
---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §535
    description: Lease contract definition
  - statute: BGB §557
    description: Rent increase rules
  - statute: BGB §573
    description: Termination rules
fields_governed:
  - kaltmiete
  - nebenkostenvorauszahlung
  - kaution
  - mietbeginn
  - mietende
  - tenant_identity
  - landlord_identity
  - unit_ref
normalization_rules:
  - id: kaltmiete_excludes_nebenkosten
    field: kaltmiete
    description: |
      Kaltmiete is base rent only. If the contract uses "Grundmiete"
      synonymously, that maps to kaltmiete. If the contract uses
      "Bruttomiete" or "Inklusivmiete," that does NOT map to kaltmiete
      and the field's absence_state must be set to "ambiguous."
gotchas:
  - id: nachtrag_supersession
    description: |
      A Nachtrag dated after the original Mietvertrag may modify
      kaltmiete. The Nachtrag is a separate document with its own
      doc_type=mieterhoehung. The Mietvertrag extractor must NOT
      merge the Nachtrag's value into the original Mietvertrag's
      extraction. Extraction is per-document; supersession is in
      the claim layer.
    real_failure_reference: weber_900_vs_1000
  - id: indexmiete_vs_staffelmiete
    description: |
      Indexmiete clauses are formulas tied to the consumer price
      index. Staffelmiete clauses specify pre-agreed rent increases
      at fixed dates. Different downstream claim patterns: Indexmiete
      = stable claim with recomputation job; Staffelmiete = multiple
      pre-emitted claims with future valid_from dates.
adversarial_fixtures_required:
  - draft_unsigned
  - mietvertrag_with_nachtrag_attached
  - indexmiete_clause
  - staffelmiete_clause
  - gewerbemietvertrag_misclassified_as_residential
---

# Mietvertrag — domain knowledge

(Free-form prose explaining nuances, with citations. Read by humans;
not parsed by code. Front-matter is the machine-readable contract.)
```

Real examples from the context document, codified:

**Übergabeprotokoll** front-matter must include the `uebergabe_typ` enum (Einzug/Auszug/Eigentümerwechsel/unklar) as a critical field, and a gotcha referencing the Hofmann case.

**Grundbuchauszug** front-matter must include a `dem_to_eur_conversion` normalization rule: preserve original DEM, derive EUR at 1.95583 DM = 1 EUR, store both.

**All cost-bearing doc types** must reference a `umlagefaehig` rule grounded in BetrKV, with Grundsteuer as a worked example (umlagefähig under BetrKV §2 Nr. 1).

### 6.4 The consumer contract

This is the answer to "domain knowledge as contract, not prose." Architecture enforces:

1. **Schema YAML for each doc_type** must declare `domain_knowledge_ref: domain_knowledge/<doc_type>.md`. CI test verifies the file exists.
2. **Schema YAML must reference at least one `legal_grounding` entry** from the front-matter. CI test verifies the reference resolves.
3. **Each `gotcha` must be referenced** by either a prompt fragment, an adversarial fixture in the gold set, or a deterministic verifier. CI enumerates all gotchas, asserts each has at least one referencing artifact. Unreferenced gotchas fail the build.
4. **Each `normalization_rule` must be referenced** by either a Zod custom validator (generated from schema YAML) or a deterministic verifier. CI enforces.
5. **`adversarial_fixtures_required` must be present in the gold set.** CI counts fixtures by tag, fails if any required tag has zero fixtures.

**If a developer or LLM agent can change a prompt without touching the domain knowledge file and tests still pass, the layer is fake.** The CI checks above prevent that.

### 6.5 Deno/Node interop constraint

The Edge Function runs on Deno. The YAML→artifacts generator runs on Node (TypeScript build tooling). Generated outputs (prompt fragments as `.ts` modules with explicit `.ts` imports, validation rules as JSON, FIELD_LABELS as JSON) must work in both runtimes. The generator MUST emit outputs in a Deno-compatible form: explicit `.ts` extensions, no Node-specific imports in generated code, no implicit `node:` prefixes.

---

## 7. Authoring primitive

### 7.1 Decision: domain YAML as source of truth

Authoring directly in JSON Schema is verbose, conditional logic is unreadable, and human-maintained JSON Schema drifts from application types. Authoring in TypeScript/Zod couples the schema to a runtime that doesn't run in the Edge Function (Deno + Zod works but the generator is harder to write).

Author in **domain YAML**. Generate everything else.

### 7.2 What the generator produces (phased)

The generator does not produce all seven artifacts at launch. Building generated artifacts before their consumers exist is exactly the "infrastructure for variance you don't have" failure pattern. The phased rollout, with Phase 1 deliberately brutal-narrow:

**Phase 1 — at launch (only artifacts with active consumers, plus the envelope validator):**
1. **Prompt fragment** — Sonnet instructions for this doc type, including required fields, normalization rules from front-matter, and embedded gotcha warnings. Consumed by Step 8b in the Edge Function.
2. **FIELD_LABELS** — German UI labels for the triage overlay. Consumed by the existing triage overlay component.
3. **Minimal envelope validator** — not full JSON Schema, but enough to enforce the architecture's safety boundary at runtime: rejects values without evidence, rejects invalid absence states, rejects invalid enum values, rejects missing severity. Implemented as ~100 lines of TypeScript, generated from the YAML's enum and required-field declarations. **Without this, the extraction envelope is convention rather than contract.**

**Phase 2 — when their consumers are built:**
4. **Full JSON Schema** — for full-shape validation beyond the minimal validator. Built when shape evolution requires it.
5. **Zod schema** — for runtime type safety with refined inference in Next.js code. Built when the first piece of code wants typed extraction output beyond the minimal validator's output.

**Phase 3 — when their consumers are built:**
6. **TypeScript types** — for editor autocomplete and compile-time checks beyond Zod inference.
7. **Eval rubric** — per-field severity weights, exact-match vs normalized-match rules, evidence-correctness rules. Built with the eval harness.
8. **Claim emitter signature stub** — a TypeScript skeleton declaring which claims this doc_type can emit, with TODO bodies for the implementer. Built when the claim store is implemented.

#### 7.2.1 YAML field discipline (preventing rot)

YAML fields drive generated artifacts. If a field has no consumer in the current phase, it's decorative — and decorative YAML rots silently. Two enforcement rules:

**Rule 1: YAML fields are not allowed unless consumed by a currently-generated artifact.** CI validates that every field declared in a `schema.yaml` is referenced by at least one generator output. Unreferenced fields fail the build.

**Rule 2: Experimental fields require explicit expiry.** Forward-looking fields (intended for Phase 2/3 outputs not yet built) must be marked:

```yaml
experimental:
  expires: 2026-08-01
  reason: "needed for planned envelope validator"
```

CI checks the expiry date. After expiry, either the field is consumed by a generated artifact (the planned consumer was built) or it's removed. This prevents "experimental" from becoming the new garbage bin.

Use experimental fields sparingly. The default is: don't add a field until you need it.

**The discipline:** the generator is incremental. Adding a new output requires (a) a real consumer that reads it, (b) a CI test verifying the consumer's contract against the generated output, (c) corresponding YAML fields added at the same time, never in advance.

### 7.3 Generator architecture

- Single Node CLI: `pnpm gen:schemas` reads all `schemas/*/schema.yaml`, validates against a meta-schema, writes outputs into `schemas/*/generated/`.
- Generated files marked with header comment "DO NOT EDIT — generated from schema.yaml."
- CI check: re-run generator, fail if output diff is non-empty (catches manually-edited generated files).
- Pre-commit hook: re-run generator before commit, stage generated outputs alongside source YAML.
- Decision: Generator written in plain TypeScript (Node). ~300 lines. Built once after Pass 1 approval, before Pass 2 schemas are written.

---

## 8. Versioning

### 8.1 What's versioned

- **schema_version** (per doc_type, semver). Incremented when fields are added/removed/changed.
- **prompt_version** (per doc_type, hash of prompt text). Incremented when prompt fragment changes.
- **model** (provider + model identifier).
- **claim_emitter_version** (per doc_type, semver). Incremented when emitter logic changes.
- **resolver_version** (per resolver, semver).

### 8.2 What's NOT versioned in v2

ChatGPT's critique included `dataset_version` and `parser_version`. **Decision: not versioned in v2.** Reasoning: you don't have multiple datasets, and you don't have a custom parser. Adding version dimensions you don't actually have variance on is premature. Add them when they vary.

### 8.3 Migration policy

- Old extractions are **not** automatically re-run when schema changes. Re-running is a deliberate decision per migration.
- Old extraction envelopes remain queryable. Schema bump does not delete history.
- Frozen test set labels migrate via explicit schema-migration scripts. The eval harness reports which labels are valid for which schema version and refuses to score against incompatible versions.
- Claim emitter version bumps trigger emitter re-run on existing extractions, producing new claims with new emitter version. Old claims are superseded.

---

## 9. Multi-provider extraction routing

### 9.1 Architecture

The extraction service accepts a `(doc_type, document)` pair and routes to a model based on a config table: `EXTRACTION_ROUTING[doc_type] = "anthropic/claude-sonnet-4-20250514"` (or `"openai/gpt-5"`, etc.).

The router is a config file, not code. Updates as eval data accumulates.

Production at launch: Anthropic-only. The router exists but every doc_type maps to Sonnet. The point of having the router at launch is that adding a second provider is a config change and an integration, not an architectural change.

### 9.2 Eval harness scope (phased)

**At launch:** the eval harness runs every prompt against **Sonnet and Opus** (both Anthropic, both already integrated, no new API dependencies, no new failure modes). This validates the multi-provider routing infrastructure with zero additional integration surface. Opus-as-evaluator already provides model diversity within the Anthropic family.

**Trigger for adding GPT-5:** when eval data shows a doc type where Anthropic models plateau below the severity-weighted threshold, AND when a hypothesis exists that a different family would handle it better. The integration is the trigger, not a baseline cost.

**Why this matters:** building integrations for models you haven't tested is the multi-provider equivalent of writing schemas with no consumers. The OpenAI API integration is straightforward, but it's also a real surface to maintain (rate limits, JSON shape differences, billing) for value that is currently theoretical. Sonnet + Opus eval at launch is sufficient to validate the abstraction; it is not sufficient to find the best model on every doc type, but at launch you don't know enough to need that.

**Three-role labeling (§12) at launch uses Opus as critic.** Same reasoning: Opus is already integrated, model-diverse within Anthropic family, sufficient for catching model-correlated errors at the scale we operate. GPT-5 as critic is a later upgrade once we have evidence it would catch what Opus misses.

### 9.3 The verifier provider-agnosticism requirement

ChatGPT's critique: deterministic verifiers must validate outputs against field semantics (OCR presence, normalization rules, arithmetic consistency), not against one model's known failure patterns. Otherwise verifiers stop catching issues when the production model changes.

Architectural rule: verifier specs live in domain knowledge files (§6.3 normalization rules) and reference field semantics, not model behaviors. CI test scans verifier code for model-specific identifiers (`sonnet`, `gpt`, `gemini`, etc.) and fails if any are found in verifier source.

### 9.4 Cost implications

**At launch (Sonnet + Opus eval, Sonnet production):** eval cost ~$10-15/month at 150 gold-set documents nightly across two models. Production cost ~$0.02-0.04/doc on Sonnet. This is the realistic launch envelope.

**After GPT-5 integration (if/when triggered):** add ~$5-10/month eval cost. Production cost depends on which model wins per doc type. Multi-provider routing potentially **reduces** production cost when a cheaper model (Gemini Flash, GPT-5 Mini) wins on simpler doc types — but this is realized cost reduction, not a launch promise.

---

## 10. Deterministic verifiers

### 10.1 Why

LLMs share blind spots. Sonnet and Opus both miss the same kinds of things (template-text extraction, plausible-but-hallucinated addresses, comma-separated multi-value strings squeezed into single fields). Same-family critic catches transcription errors but not domain-blind errors.

Deterministic verifiers catch what models miss because they share blind spots. They are unglamorous and reliable.

### 10.2 Verifier patterns

**Verbatim-presence verifier (monetary values).** Every extracted monetary value must appear verbatim in the OCR text (allowing for German number formatting: `1.234,56` or `1234,56`). If it doesn't, set `validation_status = failed_verifier` and `absence_state = contradicted`.

**Date format verifier.** Every extracted date must parse as a valid German date. `01.09.2025,19.09.2025,01.10.2025` (the actual Haiku failure case) fails because it's not a single date — verifier rejects with `failed_format`. The schema separately declares whether a field is a date or a list-of-dates; lists must be arrays in the JSON, not comma-separated strings.

**PLZ (postal code) verifier.** Every extracted German address with a PLZ must check the PLZ against a static lookup of valid German postal codes (5 digits, valid range, matched to a Bundesland). The Kuru "36270 Eosbacher Str." case fails because 36270 doesn't exist near Schauenburg. Verifier marks `confidence = low` and `validation_status = requires_human_review`.

**Enum verifier.** Every extracted enum value must match a canonical key in the schema. Free-form values that don't match an enum are mapped to `absence_state = ambiguous`. The Übergabeprotokoll `uebergabe_typ` enum is the canonical case — extraction must return Einzug, Auszug, Eigentümerwechsel, or unklar (forcing human review). Anything else is rejected.

**Boolean derivation verifier.** When a boolean field is derived from text (e.g., `belastet_mit_grundschuld` from Abteilung III content), the verifier checks for negation/cancellation keywords in the same text. If "gelöscht" or "rotgestrichen" appears in the source quote, the boolean's confidence is downgraded and the field is flagged for review.

**Arithmetic consistency verifier.** When a document contains both line items and a total, the verifier sums the line items and compares to the extracted total. Mismatch beyond tolerance flags `validation_status = failed_verifier`. Used heavily for invoices and (eventually) NKA.

### 10.3 Verifier integration

Verifiers run *after* the model returns extraction, *before* the envelope is committed. A verifier failure can:

- Override `absence_state` to `contradicted` or `ambiguous`
- Downgrade `confidence`
- Set `validation_status = failed_verifier` or `requires_human_review`

Verifier failures do NOT silently delete extracted values. The raw_value is preserved for audit. The downstream consumer (claim emitter) decides whether to emit a claim.

### 10.4 What verifiers are not

Verifiers are not a place for "smart" rules. They are deterministic, fast, model-agnostic, and bounded. If a check requires reasoning, it belongs in the prompt or the claim emitter, not in a verifier.

### 10.5 The `legal_validity_status` framework

A subset of verifiers check formal prerequisites of legal documents — does a Kündigung have a signature, does a Mieterhöhung exceed the 15% Kappungsgrenze, does an Übergabeprotokoll have all required parties signed. These checks **do not adjudicate legal validity** (that's a lawyer's job). They flag whether the document is **operationally safe to apply automatically.**

The architecture defines an enum for capturing this:

```
legal_validity_status:
  - "not_checked"                            # default; no formal checks ran
  - "formal_prerequisites_present"           # signed, all required parties, all required dates
  - "formal_prerequisites_missing"           # missing signature, dates, parties — operationally unsafe
  - "potentially_invalid_requires_review"    # checks raised flags (e.g., Kappungsgrenze exceeded)
  - "disputed"                               # known dispute referenced (Widerspruch, etc.)
```

**Key principles:**

- **Never use the word "invalid."** The system does not declare legal invalidity. It declares "operationally unsafe to apply automatically" or "requires human review before claim emission."
- **`formal_prerequisites_missing` blocks emission of fact claims.** A Kündigung without a signature does not produce closure intents. A Mieterhöhung without an effective_date does not produce a Kaltmiete claim. The document is captured (envelope written, document_status = "draft" or similar) but no claims emit.
- **`potentially_invalid_requires_review` does NOT block emission, but blocks closure.** Example: a Mieterhöhung that exceeds the 15% Kappungsgrenze — the new Kaltmiete claim is emitted (the document says what it says), but the closure intent for the previous Kaltmiete is suspended pending human review. Human can adjudicate via human-adjudication claim if the increase is correct, or reject if the increase is over the cap.
- **`disputed` triggers the conservative path.** Known references to Widerspruch, ongoing court proceedings, or contested terms route to triage with no auto-emission of claims that depend on the disputed fact.

The enum is set per-document during extraction (verifier output), not per-field. It governs emitter behavior (whether to emit claims at all) and applier behavior (whether to apply closures). It is queryable for triage prioritization (documents with `potentially_invalid_requires_review` are higher priority than documents with `formal_prerequisites_present`).

This is what "extract and resolve, do not adjudicate legal validity" means in practice: the system has opinions about whether documents are operationally safe; it never has opinions about legal validity.

---

## 11. Pipeline consolidation: target architecture and migration plan

**Target architecture:** v2 is single-pass Sonnet for extraction. Haiku Step 5 is eventually removed.

**Migration reality:** Haiku Step 5 stays alive during the transition window — for doc types without v2 schemas. Removing it before all doc types are migrated would break extraction for the 100+ doc types not yet in v2 scope.

This section replaces the original "kill Haiku Step 5 in v2" framing. The architecture's spirit is preserved; the migration is honest.

### 11.1 What's wrong with single-pass-Sonnet-at-launch

The architecture's first draft committed to removing Haiku Step 5 when v2 ships. Reasoning: cleaner system, smaller surface area, no prompt drift between Haiku and Sonnet.

That reasoning is correct in the steady state — once all doc types have v2 schemas. It is wrong during the transition. v2 schemas exist for 4 doc types at launch (Mietvertrag, Wohnungsübergabeprotokoll, Mieterhöhung, Mietvertragsnachtrag). The corpus contains ~120 doc types. Removing Haiku Step 5 at launch means the other ~116 doc types lose their extraction data overnight — Sonnet's base intelligence prompt produces summary/tags/entities but NOT the doc-type-specific fields (vendor_name, amount, invoice_date) that the triage overlay reads.

Specific failure mode: Saturday morning after launch, 50 documents process through the new pipeline. Three Mietverträge (work great via v2 path). Forty-seven other doc types (no extraction data — the triage queue shows empty fields). Operator notices Monday. Either rolls back (launch slips) or doesn't notice for weeks (1,000+ documents accumulate degraded extraction).

Either outcome violates the project's stated goal: "trustworthy operational backbone for acquiring an existing Hausverwaltung."

### 11.2 The actual v2 launch plan

**Both extraction paths coexist during the migration window.**

- **Step 5 (Haiku)** continues running for doc types WITHOUT a v2 schema. It writes to legacy `warehouse.document_extractions` as it does today.
- **Step 8b (Sonnet)** runs for every document, as today. For doc types WITH a v2 schema, it produces the full v2 envelope per the prompt fragment from `schemas/<doc_type>/generated/prompt_fragment.ts`. For doc types WITHOUT a v2 schema, it produces the existing intelligence-layer output (summary, tags, entity_name, etc.) but no v2 envelope.
- **A registry** (`schemas/index.ts`, generated) lists which doc types have v2 schemas. The Edge Function checks this registry per document.

So the per-document flow becomes:

```
Document arrives
  ↓
Step 4: classifyDocument (Haiku) — unchanged, returns doc_type
  ↓
  ┌─────────────────────────────────────────────┐
  │ Has v2 schema? (lookup in registry)         │
  └─────────────────────────────────────────────┘
       │                              │
       │ YES                          │ NO
       ↓                              ↓
  Step 8b writes v2 envelope     Step 5 (Haiku) writes
  Claim emitter runs             legacy document_extractions
  Applier validates+applies      Step 8b writes intelligence
                                 (no claim emission)
       │                              │
       └──────────────┬───────────────┘
                      ↓
                 Triage queue
                 (dual-read in §11.3)
```

Both paths coexist for as long as it takes to migrate all doc types. Estimated horizon: 6-12 months depending on customer pressure to extract specific doc types deeply.

### 11.3 Triage overlay dual-read

The triage overlay reads v2 envelope first, falls back to legacy:

```
function loadExtraction(documentId):
  v2 = query warehouse.document_extractions_v2 where source_document_id = documentId, latest
  if v2 exists:
    render v2 envelope (raw_value, normalized_value, evidence, severity, absence_state)
  else:
    legacy = query warehouse.document_extractions where document_id = documentId, is_current = true
    render legacy.extracted_fields with "Legacy-Format" badge
```

The "Legacy-Format" badge is intentional — operators see at a glance which documents have v2 envelope data and which still flow through the legacy Haiku path. This prevents silent UX inconsistency where two adjacent documents in the inbox render with different layouts and the user can't tell why.

### 11.4 The end state and how we get there

The architecture's target is single-pass Sonnet for all doc types. The path:

1. **v2 launch:** 4 doc types route to v2 envelope. ~116 doc types continue via Haiku Step 5 + Sonnet Step 8b legacy intelligence.
2. **Post-launch month 1-2:** add v2 schemas for the next-most-common doc types (Rechnung, Versicherungspolice, Grundbuchauszug, Energieausweis, Grundsteuerbescheid). Each new schema flips that doc type from legacy path to v2 path automatically (registry lookup).
3. **Month 3-6:** continue migrating doc types based on customer-pressure priority.
4. **Month 6-12:** when the registry contains all production doc types, Haiku Step 5 has nothing to handle. Deferred Task D.9 retires Haiku Step 5; legacy `document_extractions` becomes read-only for historical audit.
5. **Steady state:** single-pass Sonnet, as originally designed. Architecture goal achieved without operational disruption.

### 11.5 Cost during transition

Production cost during transition window: marginally higher than steady-state target. Both Haiku ($0.001/doc) and Sonnet ($0.02-0.04/doc) run on every legacy-path document. At 5,000 docs/customer/month, the legacy-path overhead is roughly $5/customer/month — negligible.

Once each doc type migrates to v2, that doc type's documents skip Haiku, returning to single-pass cost. Cost decreases monotonically as migration progresses.

### 11.6 What this isn't

- **Not a permanent dual-extractor architecture.** Steady state is single-pass Sonnet. The dual path is a migration artifact with a kill date (Deferred Task D.9 in the implementation plan).
- **Not maintenance of Haiku prompts.** New v2 schemas don't get Haiku prompts written. The Haiku path runs only on doc types whose Haiku prompts already exist from v1. As doc types migrate, their Haiku prompts can be deleted.
- **Not a retreat from the architecture.** v2 envelope, claim layer, resolvers, composer/presenter — all of these are live at launch for the 4 in-scope doc types. The architecture works end-to-end on day one for the launch slice. The dual path applies only to doc types out of scope for the launch slice.

---

## 12. Three-role labeling

Naming changed from "dual-pass" to honest. The pattern:

- **Extractor:** Sonnet (production model).
- **Critic:** Opus or GPT-5 (model-diverse, different family preferred). Receives the document, schema, and extractor output. Must challenge each field with evidence.
- **Human adjudicator:** Nils. Adjudicates disagreements, low-confidence fields, and high-severity fields. Decides ground truth.

Metric: **model-assisted adjudication disagreement rate.** Honest naming. Not inter-annotator agreement.

### Labeling workflow

1. Extractor runs on a candidate document, produces envelope.
2. Critic runs in critique mode, produces a per-field disagreement report.
3. Triage UI surfaces the document with extractor output and critic disagreements highlighted.
4. Human adjudicates: accept extractor, accept critic, or write own value. Each decision is logged.
5. Final adjudicated values become the ground truth label.

### Disagreement taxonomy tracked

- Both correct: extractor and critic agreed on a value, human accepts.
- Extractor wrong, critic right: critic-overturn.
- Both wrong, human writes own: full-overturn (most expensive, indicates systemic issue).
- Both correct on different things: rare, indicates a schema ambiguity.
- Disagreement on absence_state but not value: usually indicates a schema-level "is this required?" question.

These categories are tracked over time. Full-overturn rate trending up is the strongest signal that something is structurally wrong.

---

## 13. Eval and the gated dashboard

### 13.1 What runs nightly

CI runs eval against the gold set: each doc_type, each candidate model, all metrics. Output is JSON.

### 13.2 Metrics

- **Per-field exact-match** (raw_value)
- **Per-field normalized-match** (normalized_value)
- **Evidence correctness** (does the evidence quote actually justify the value?)
- **Absence-state correctness** (did the extractor pick the right absence state?)
- **Severity-weighted error rate** (critical fields weighted higher than nice-to-have)
- **Verifier hit rate** (how often did verifiers catch issues vs. accept silently?)
- **Calibration** (when the model says "high confidence," is it actually right at high rate?)

### 13.3 The gated dashboard

A static page at `prop-manage-de.de/quality` (or subdomain) behind auth (NextAuth, granted to prospects deliberately). Shows current accuracy per doc_type, 90-day trend charts, methodology, gold-set methodology, regression history.

Migration to fully public at month 4–6 contingent on:
- Gold set reaches 100+ documents per deep doc type
- Gold set spans 3+ properties (KO132, HHS55, plus first customer's docs)
- 90 days of stable metrics with no >5pp regressions

### 13.4 Regression alerts

CI alerts to Discord on >2pp drop on any severity-weighted metric. Alert at 3:05am, you investigate during the day. Public page shows the dip but you have hours of buffer.

---

## 14. Active learning loop

### 14.1 Mechanism

Triage UI corrections automatically tag the document as a gold-set candidate. Weekly labeling cycle pulls candidates ranked by:

1. Highest severity-weighted error caught by adjudication
2. Lowest extractor confidence on critical fields
3. Doc types with smallest current gold sets (coverage balancing)

### 14.2 Graceful degradation

ChatGPT's critique: "the loop compounds only if labeling actually happens weekly." Real risk for a solo builder.

**Decision:** the system must work without weekly labeling. If labeling skips a week:
- The gold set doesn't grow but doesn't degrade.
- Eval still runs nightly against existing labels.
- Triage corrections still feed the candidate queue (FIFO with the priority above), waiting for the next labeling session.
- The dashboard surfaces "X candidate documents waiting" as a soft nag, not a blocker.
- There is **no** automated promotion of candidate documents into the gold set without human adjudication. Self-labeling is forbidden.

The active learning loop is a force multiplier when labeling happens. It is not load-bearing.

---

## 15. Adversarial fixtures

### 15.1 Why

Real corpora don't hit edge cases at frequency. KO132 + HHS55 has 0 draft Mietverträge, 0 Gewerbemietverträge, 0 Mietverträge with Indexmiete clauses, 1 Eigentümerwechsel-Übergabeprotokoll. Without synthetic adversarial fixtures, the eval can't measure how the system handles these cases.

### 15.2 Generation

Synthetic documents generated by Claude (a *different* Claude session/model than the extractor — explicitly different family if possible). Each fixture:

- Has a `domain_knowledge` reference to the gotcha it stresses
- Is labeled with expected envelope output (the synthetic is generated *along with* its ground truth)
- Is tagged with one of the `adversarial_fixtures_required` tags from the doc_type's domain knowledge
- Is reviewed by you before entering the gold set (synthetic generation is not self-labeling)

### 15.3 Required fixtures by doc type

From the domain knowledge files (§6.3 `adversarial_fixtures_required`):

- **Mietvertrag:** draft_unsigned, with_nachtrag_attached, indexmiete_clause, staffelmiete_clause, gewerbemietvertrag_misclassified, mietvertrag_with_handwritten_amendment
- **Versicherungspolice:** active_with_renewal_chain, expired_but_in_file, two_policies_same_property, policy_with_excluded_perils
- **Übergabeprotokoll:** einzug_explicit, auszug_explicit, eigentuemerwechsel_explicit, ambiguous_unklar, mixed_einzug_and_eigentuemerwechsel
- **Grundbuchauszug:** with_struck_through_entries, with_dem_grundschuld, multi_owner_anteil_miteigentum
- **Energieausweis:** verbrauchsausweis_vs_bedarfsausweis, expired_pre_2014, with_modernization_recommendations
- **Grundsteuerbescheid:** pre_reform_pre_2025, post_reform_post_2025

CI test: gold set must contain at least one fixture per required tag. Build fails if any required tag is unrepresented.

---

## 16. Cost model

### 16.1 Per-document extraction

**Steady state (target, after migration completes):** single Sonnet call per document. At current Anthropic pricing (Sonnet 4): ~$0.02-0.04/document depending on size. For 5,000 docs/customer/month: ~$100-200/customer/month.

**Transition window (v2 launch through full migration, est. 6-12 months):** dual path. Doc types with v2 schemas use single-pass Sonnet. Doc types without v2 schemas use Haiku Step 5 + Sonnet Step 8b legacy intelligence. The Haiku overhead is ~$0.001/document. At 5,000 docs/month, with ~80% on the legacy path during early transition, dual-path overhead is ~$5-10/customer/month above the steady-state target. Cost decreases monotonically as doc types migrate to v2.

Adding multi-provider routing where Gemini Flash wins on simple reference doc types (post-launch): estimated ~30% of docs route to Flash once migration is far along, reducing per-customer extraction cost below the steady-state baseline.

Numbers above are estimates based on current pricing; actual cost varies with document size distribution and provider pricing changes.

### 16.2 Per-document verifier cost

Verifiers are deterministic code. Effectively zero per-document cost.

### 16.3 Eval costs

**At v2 launch:** nightly eval at 150 gold-set documents × 2 Anthropic models (Sonnet + Opus) = ~300 calls/day = ~$10-15/month. Adversarial fixture generation (one-time): ~$0.10/fixture × ~50 fixtures = ~$5 one-time.

**Post-launch when GPT-5 routing is added:** add ~$5-10/month eval cost for the third model, contingent on integration trigger from §9.2.

### 16.4 Storage

Claim store growth: ~5-15 claims per document on average. At 5,000 docs/customer/month: ~25,000-75,000 claims/customer/month. At ~1KB per claim (with provenance): ~25-75MB/customer/month. Negligible at Supabase tier.

Evidence storage (the actual quotes + page references): ~500 bytes per evidence record × 5-15 per doc = ~5KB/document = ~25MB/customer/month. Negligible.

DerivationRecord storage: ~1-3 derivation records per claim on average, ~500 bytes each = ~25-100MB/customer/month. Still negligible.

### 16.5 The Weber lesson

The Weber bug cost $1.17 in API calls plus several hours of debugging. The architectural fix (claim layer) is paid for once and prevents the entire class of bug. **Architecture cost is amortized; reasoning cost is per-incident.** Spending more on architecture upfront is the correct economic choice.

---

## 17. NKA pressure test (and what it reveals)

**Headline:** NKA is the highest-value document type in a German Hausverwaltung — it determines what tenants owe, has GoBD implications, and is the document tenants' lawyers most often challenge. v2 does not implement NKA. The architecture is designed to **survive** NKA, not to **launch** with NKA. This is a deliberate scoping decision and it has a real cost: the load-bearing customer use case (NKA accuracy) is explicitly out of v2 scope.

The premise of NKA: a complex multi-line-item document that allocates costs across tenants based on Umlageschlüssel (allocation keys), references prior payments (Vorauszahlungen), produces per-tenant balance owed/refund, and is dispute-prone.

**Test: does the v2 architecture handle each NKA primitive?**

- **Line items.** Each line is a separate extracted record. The envelope handles arrays of structured sub-records. A Mietvertrag's Staffelmiete clause is structurally similar (array of (effective_date, rent_amount) pairs). Architecture accommodates.
- **Allocation keys.** Each line item has an `umlageschluessel` field (enum: Wohnfläche, Personenanzahl, Miteigentumsanteil, etc.). Stored on the extracted line, used by the resolver. Architecture accommodates.
- **Periodized amounts.** Each line has `period_start` and `period_end`. The lifecycle sub-envelope already supports this. Architecture accommodates.
- **Prior payments.** A separate field on the NKA referencing the sum of monthly Vorauszahlungen. The claim layer handles this as a derived claim (NKA emitter computes "sum of Vorauszahlungen for period" from existing rent claims). **Caveat: the NKA emitter must read existing claims to compute the prior-payments derivation. Currently emitters are pure functions of (extraction, document_metadata). NKA requires emitters to be functions of (extraction, document_metadata, claim_store_query_function).** This is a real architecture extension — making emitters claim-aware is a v3 change.
- **Per-tenant facts.** NKA produces per-tenant balance claims (subject = "tenant:X", predicate = "nka_balance_2024"). Architecture accommodates.
- **Calculated vs extracted values.** Architecture's `inferred` absence state handles this. NKA totals can be marked `inferred` if computed by the emitter; verifier checks the computation matches the extracted total.
- **Dispute/audit trail.** The append-only claim layer naturally preserves all history. Architecture accommodates.
- **Corrections (Stornierung & Neuverbuchung).** GoBD pushes toward correction documents (rather than edited values) for tax-relevant records. The claim layer's superseded_by_claim_id pattern matches this expectation cleanly. Architecture accommodates.

### 17.1 The honest accounting

**NKA does not pass v2 as currently specified.** It survives as a known incompatibility with a defined extension path. The rest of the architecture is compatible with NKA, but a new primitive must be introduced before NKA can be implemented correctly.

The required v3 primitive is **claim-aware derived claims with dependency tracking**. This is distinct from the emitter contract (§4.4): emitters are pure (extraction in, EmissionResult out). Derived claims are a separate primitive — they take existing claims as input, compute a derived value, emit a new claim with `source_type = "system_derivation"`, and write a DerivationRecord (§4.6) capturing the dependency.

Specifically, NKA implementation will require:

1. **Controlled claim-store query interface** for derivation jobs (read-only, scoped to declared predicate space, CI-enforced query limits).
2. **Dependency-driven re-derivation** — when underlying rent claims change (Mieterhöhung, correction), all derived NKA claims that depended on them must be re-derived. This is exactly what DerivationRecord (§4.6) is designed to support, but the re-derivation orchestration itself does not exist in v2.
3. **Caching to prevent N+1 explosions** when many NKA documents derive from the same rent claim history.
4. **A separate "derivation job" runtime** distinct from the extraction pipeline. NKA derivation runs after extraction, after claim emission, after closure application — in a separate pass.

Three things to be explicit about:

1. **The extension is non-trivial.** Adding system_derivation as a primitive, plus the orchestration to re-derive on dependency change, plus the safety rails on claim-store reads — this is meaningful new architecture. ChatGPT's review correctly flagged that calling this "one extension" understated the work.

2. **Until v3, NKA is processed but not understood.** v2 will classify NKAs, extract their fields into the envelope, and store them. It will not produce per-tenant balance claims, will not validate the math, will not surface the document on per-tenant property surfaces. NKAs will appear in the document list but the system will not "know" what they say in the same way it knows about Mietverträge.

3. **The customer-facing impact is real.** A property owner asking "how much does Hofmann owe for 2025?" will not get an answer from v2. They will see the NKA in the document list and have to read it themselves. This is the explicit limitation of v2's scope.

### 17.2 Why we ship v2 anyway

The foundational architecture is right. Shipping v2 without NKA and then adding the derivation primitive in v3 is correct sequencing — getting the claim layer, resolver layer, and provenance right first means the v3 NKA work builds on a clean foundation rather than carrying compromises forward.

The risk is shipping v2 and never getting around to v3. To prevent this, NKA gets a hard schedule commitment: **NKA implementation begins within 60 days of v2 first-customer launch.** This is a project-management commitment, not an architectural fix — but the architecture document names the constraint explicitly so it cannot quietly slip. Architectural deferrals that never get un-deferred are the classic v3-never-arrives failure mode.

---

## 18. Cross-industry pattern appendix

Patterns only. Source cited where public; inference flagged. Five patterns, each load-bearing for a specific PropManager primitive. The previous draft had ten; the cut ones are not wrong, just less essential than the architecture work elsewhere in the document.

**1. Stripe's invoice object as durable financial schema (cited).** Stripe's `Invoice` object has explicit lifecycle states (`draft → open → paid|void|uncollectible`), versioned via API versions, with line items as structured sub-records and metadata as freeform. The pattern: the schema encodes lifecycle states explicitly, not as boolean flags, and monetary amounts use integer minor units + currency (never floats). **PropManager implication:** `document_status` enum in §3.4 and integer-minor-units in §3.1 normalized monetary values. Both adopted directly.

**2. Google Document AI processors and HITL (cited).** Google's pattern: a processor is a versioned model + schema + dataset, with explicit train/eval splits and per-field accuracy metrics. The HITL workflow tracks reviewer agreement to distinguish "model wrong" from "schema ambiguous." **PropManager implication:** schema_version + prompt_version + model + extraction_run_id together identify a "processor" in the same sense (lighter, no custom training). The disagreement taxonomy in §12 (extractor wrong / critic wrong / both wrong / schema ambiguity) is the same HITL pattern.

**3. OpenAI Structured Outputs / Anthropic tool use as constrained decoding (cited).** OpenAI's Structured Outputs use JSON Schema as a generation constraint — the model literally cannot output invalid JSON. Anthropic's tool use mode is the equivalent primitive. **PropManager implication:** use tool use mode for Sonnet extraction, not "respond only with JSON" prompting. ~5-10% reliability gain from this alone.

**4. Append-only event sourcing with append-only derivation logs (general well-documented pattern).** Event sourcing uses append-only logs to preserve history; mature event-sourced systems pair this with explicit derivation tracking ("this projection was computed from these events using this version") to support cache invalidation and audit. **PropManager implication:** the claim layer (§4) is structurally an event store with valid_from/valid_to adding temporal validity. The DerivationRecord (§4.6) is the derivation-tracking pair. The claim-store transaction applier (§5.5) is the projection-update boundary.

**5. Provenance-first architectures in audit-heavy domains (general pattern).** Banking, healthcare, and legal-tech systems separate raw + normalized + source pointers with mandatory provenance for every fact surfaced to a user. **PropManager implication:** raw_value + normalized_value + evidence in §3.1 plus the ResolvedFact provenance chain in §5.4.4 plus DerivationRecord in §4.6 — the three together implement the same provenance-first discipline.

These are patterns, not company biographies.

---

## 19. Final red team

How does this architecture still fail?

**1. The claim layer adds latency to product surfaces.** Every brain query now goes through resolvers which query claims which were emitted from extractions. If resolvers are slow (no caching) or claim queries scale poorly, the brain feels slow. **Mitigation:** resolver results cached per (property, query_hash, as_of_date), invalidated on new claim emission. Cache key is small. But if cache invalidation is buggy, we get stale facts and the dashboard shows yesterday's rent.

**2. Closure-intent logic accumulates undocumented domain knowledge.** Today the Mieterhöhung emitter returns a closure intent for the previous Kaltmiete claim. Tomorrow a new claim type emerges (e.g., Mietminderung) and its emitter returns closures with slightly different semantics. Over 12 months, the closing matrix (§5.5.2) becomes an undocumented rule book. **Mitigation:** every closure type is declared in the doc_type's domain knowledge front-matter (a `closes` field referencing the closing matrix entry), and a CI-assisted test asserts that emitter `EmissionResult` matches the declaration. **Honest acknowledgment:** this is a real long-term risk. The only protection is discipline.

**3. The Übergabeprotokoll dispatch on `uebergabe_typ` puts a critical-severity decision on a single extracted enum.** If the model misclassifies a document's `uebergabe_typ`, the entire emission strategy is wrong. The Hofmann case is exactly this — the document's *meaning* depends on the value of one field. **Mitigation:** `uebergabe_typ` is verifier-checked (enum-validated) and additionally cross-checked against doc-content keywords (Käufer/Verkäufer presence → Eigentümerwechsel; Mieter X moves in → Einzug). If the verifier disagrees with the extractor, force human review.

**4. The lifecycle sub-envelope assumes documents have clean date semantics.** Many real documents don't. A Mietvertrag dated "im März 2022" with no signature date and an effective date implied by handover. **Mitigation:** lifecycle dates are nullable; the emitter falls back to inference (e.g., `effective_date = signed_date if present else issue_date else null`). Inferred lifecycle dates produce claims with `confidence = medium` and trigger soft review nags.

**5. Multi-provider routing creates silent quality drift.** GPT-5 wins on Mietvertrag in March, the router updates, in May Anthropic releases Sonnet 5 which is better but the router doesn't know. **Mitigation:** the eval harness runs nightly across all candidate models. **Eval recommends route changes when a candidate model wins by >2pp on the severity-weighted score with no critical-field regression. Route changes require manual approval** (a single PR to update the router config, with the eval data referenced in the PR description). At current scale, manual approval is cheap and protects against eval-set noise driving production model swaps. A regression in the recommended model gets caught in the next nightly eval before the manual approval lands.

**6. The gold set is small (50-100 docs/type at launch). Public dashboard numbers may overpromise.** **Mitigation:** §13.3 — gated until gold set diverse enough. Methodology page explicit about gold set composition. Confidence intervals shown on dashboard, not just point estimates.

**7. The active learning loop depends on Nils labeling weekly. Won't always happen.** **Mitigation:** §14.2 — graceful degradation already specified. System works without weekly labeling, just doesn't improve.

**8. The single-pass-Sonnet decision (§11) may regress quality on simple doc types where Haiku was sufficient.** **Mitigation:** the multi-provider router can route simple doc types to Gemini Flash (or Haiku-tier model) once the eval shows it's sufficient. The single-pass decision is about removing the Haiku→Sonnet *handoff*, not about always using the most expensive model.

**9. The architecture is bigger than 634 documents need.** True. ChatGPT flagged this and it's honest. The architecture is sized for 5,000-50,000 documents per customer at scale, not for current corpus size. The cost of building it now is 4-6 weeks; the cost of building it after first customer is rewriting customer data. The bet is that getting the architecture right before first customer is cheaper than retrofitting it. **If the bet is wrong, the failure mode is:** weeks spent on infrastructure that doesn't pay back for 6+ months of customer growth. Acceptable risk given stated "top in class" goal.

**10. The CI gates may be circumventable.** Tests can be skipped with `git push --no-verify`. Domain knowledge files can be created without tests if the developer hand-writes around the gate. **Mitigation:** the CI gates run server-side on PR, not just locally. Same as Tier 0 hardening pattern. Solo builder can override gates but the override is logged.

These are the failure modes I see. The most worrying are #2 (emitter knowledge accumulation) and #9 (over-architecture for current scale). #2 is a discipline problem with no clean architectural fix. #9 is a deliberate bet — the right one given the stated goal, but real if the bet is wrong.

---

## 20. Open questions

Not decided in this document, deferred or escalated:

1. **Claim emitter contract.** Resolved: §4.4 declares emitters pure, returning `EmissionResult { claims_to_insert, closure_intents }`. The transaction applier (§5.5) is the only writer to the claim store. Derived claims that need to read existing claims are a separate primitive (derivation jobs) introduced in v3 for NKA (§17). No emitter ever writes to the claim store directly.
2. **Resolver caching strategy.** §19.1 mentions per-(property, query_hash, as_of_date) cache. Cache invalidation rules need a separate spec.
3. **The "claim closer" job for Kündigung events.** Resolved: §5.5 specifies the synchronous-transactional pattern. Implementation details (closing matrix per doc type) live in domain knowledge front-matter.
4. **Anthropic vs OpenAI tool use API differences.** Multi-provider routing assumes equivalent structured-output primitives. Real API differences exist (OpenAI's `response_format` vs Anthropic's tool use). Generator must handle both targets. Specification deferred to generator implementation.
5. **Adversarial fixture generation: how synthetic is too synthetic?** Generated fixtures must be realistic enough to be useful but obviously synthetic enough to flag in audit. Watermarking strategy deferred.
6. **GoBD retention policy for evidence records.** Retention until is on the document itself; evidence records are children. Should evidence retention follow the document's retention or be longer? Legal question, not architectural. Flagged for AVV/DPA review.

---

## 21. Decision summary

For review approval. The architecture commits to:

1. ✅ Pipeline: documents → extractions → claims → resolved facts → composer → presenter → customer. Strict layer contracts.
2. ✅ Extraction envelope with raw_value + normalized_value + evidence + confidence + 8 absence states + validation_status + severity, plus document-level lifecycle. **Minimal envelope validator ships in Phase 1 of generator.**
3. ✅ Claim layer, append-only, immutable, with claim_kind taxonomy (assertion/snapshot/event/reference) declared per doc_type. **Claim schema includes `source_type` (document_extraction/human_adjudication/system_derivation) — human overrides are claims, not resolver exceptions.**
4. ✅ Wohnungsübergabeprotokoll dispatch on `uebergabe_typ` (Einzug/Auszug/Eigentümerwechsel/unklar) — Hofmann bug becomes structurally debuggable.
5. ✅ Resolution layer, pure functions, query-only against claim store, no LLM calls. `rent_for_unit` fully designed against KO132/HHS55 cases.
6. ✅ **Emitters return EmissionResult (claims_to_insert + closure_intents). They do no I/O. A claim-store transaction applier validates closures against safety rules and applies claims and closures atomically. This resolves the v1 inconsistency where emitters were both "pure" and "writers."**
7. ✅ **DerivationRecord primitive (§4.6): every system-derived output (claim, closure, resolved fact, snapshot) writes a record linking it to its inputs and rule versions. Not a graph DB; an append-only log queried for cache invalidation, rule-change re-derivation, and audit explanation.**
8. ✅ **Brain decomposed into composer (deterministic, no LLM) and presenter (LLM, renders only). Chat answer modes: `authoritative_resolved_fact` (resolver path), `document_search_summary` (controlled exploratory escape — surface evidence, never resolve facts), `not_supported`. Presenter constraints mechanically enforced where possible, regression-tested where not.**
9. ✅ Domain knowledge files with CI-enforced consumer contract. Markdown-as-prose alone is rejected.
10. ✅ Domain YAML as authoring primitive; generator outputs phased. **Phase 1 includes minimal envelope validator (rejects values without evidence, invalid absence states, invalid enums, missing severity). Decorative YAML rejected — fields require active consumers or explicit experimental-with-expiry markers.**
11. ✅ schema_version, prompt_version, model, claim_emitter_version, resolver_version, composer_version. dataset_version and parser_version explicitly NOT versioned in v2.
12. ✅ **Multi-provider routing architecture-ready. At launch: Sonnet-only production, Sonnet + Opus eval. Route changes require manual approval (PR with eval data referenced) — no auto-routing on >2pp delta.**
13. ✅ Deterministic verifiers, provider-agnostic, CI-enforced not to reference model identifiers.
14. ✅ **Single-pass Sonnet is the v2 target architecture. Haiku Step 5 stays alive during the migration window (§11) for doc types without v2 schemas — removing it at launch would break extraction for ~116 doc types not in v2 scope. Each new v2 schema flips its doc type from legacy path to v2 path automatically. Haiku Step 5 retires in Deferred Task D.9 once all production doc types have v2 schemas (est. 6-12 months).**
15. ✅ Migration plan for triage overlay specified (§11.3): dual-read with "Legacy-Format" badge. Cutover sequence specified.
16. ✅ Three-role labeling at launch uses Opus as critic. Honestly named "model-assisted adjudication."
17. ✅ Eval harness nightly. **At launch: Discord regression alerts + JSON eval artifact in CI. Gated dashboard deferred to post-launch (see §22). Public migration at month 4-6 contingent on gold-set diversity.**
18. ✅ Active learning loop with graceful degradation when labeling skips.
19. ✅ Adversarial fixtures required per doc type, CI-enforced presence.
20. ✅ Cost model documented as estimated ranges, not point projections.
21. ⚠️ **NKA limitation explicit: NKA does not pass v2 as currently specified. It survives as a known incompatibility with a defined extension path. v3 must introduce a new primitive — claim-aware derived claims with dependency tracking — distinct from the emitter contract. Hard commitment: NKA implementation begins within 60 days of v2 first-customer launch.**

For your review. Push back on anything that smells like prestige engineering, premature abstraction, or credibility theater.

---

## 22. Minimum shippable v2 slice

The architecture document does not prescribe a full project plan, but it does need to name what makes v2 launchable. Without a launch slice, "architecture only" becomes a shield against feasibility critique. This section names load-bearing-for-launch vs. aspirational.

### 22.1 Minimum shippable v2 (must exist for v2 to be considered launched)

1. **v2 envelope table** in the database schema, with minimal envelope validator running on inserts.
2. **Single-pass Sonnet extraction** for **Mietvertrag** and **Wohnungsübergabeprotokoll** (the two doc types that exercise the most primitives — temporal supersession via Mieterhöhung, and `uebergabe_typ` dispatch).
3. **Deterministic verifiers** for the critical-severity fields in those two doc types (verbatim-presence for monetary values, date format, enum validity, PLZ check on addresses).
4. **Claim emission** for predicates `kaltmiete`, `tenant_active`, `ownership_transferred`, `lease_terminated`, `tenant_moved_out`. EmissionResult pattern. No direct I/O from emitters.
5. **Claim-store transaction applier** with safety rules from §5.5.3 enforced.
6. **`rent_for_unit` resolver** working end-to-end against all five KO132/HHS55 tenant cases.
7. **Composer core + rent_roll module** producing a `PropertySnapshot` with the `rent_roll` module populated. Other modules can be empty.
8. **Triage overlay dual-read** (v2 envelope first, legacy fallback with "legacy format" badge).
9. **Fixture-based test suite** covering the five tenant cases (Lena, Paul, Kuru, Weber, Hofmann) plus the Hofmann/Eigentümerwechsel non-closure case.
10. **CI eval artifact** — JSON output per nightly run, stored in repo, **Discord regression alert on >2pp drop** on severity-weighted critical-field score.

That's the launch slice. Roughly 50% of the full architecture document, picked specifically to validate the load-bearing primitives (claims, closure, resolver, composer) on the doc types that stress them most.

### 22.2 Deferred from launch slice (post-launch)

- **Gated external dashboard** (§13.3) — Discord alerts + JSON artifacts are sufficient to detect regressions internally. The dashboard is a credibility weapon for prospects, not a launch necessity. Add when first prospect conversation actually requires it.
- **Generator outputs beyond Phase 1** (full JSON Schema, Zod, TypeScript types, eval rubric, emitter stubs).
- **Composer modules beyond rent_roll** (insurance, costs, ownership history, handover history).
- **Resolvers beyond `rent_for_unit`** (`active_insurance_for_property`, `owner_of_property`, etc.).
- **The four "thin schema" doc types** (Grundbuchauszug, Energieausweis, Grundsteuerbescheid, Versicherungspolice). Pass 2 will produce thin schemas for these to validate the meta-model, but they don't ship in the launch slice.
- **Non-Anthropic provider integration** (GPT-5).
- **100-doc/type gold set** — launch with whatever fixtures + adversarial set is realistic to label in the timeline. Active learning grows the gold set post-launch.
- **NKA** — explicit, see §17.

### 22.3 Why this slice is the right cut

It validates every load-bearing primitive: the envelope, the claim layer, the closure pattern, the transaction applier, a resolver, a composer module, the migration path, the eval harness. It does not ship every doc type, every UI surface, or every external credibility surface. If this slice ships and works, the architecture is proven; the rest is iteration. If this slice can't ship in 4-6 weeks, the architecture is too big and we cut more, not less.

The dashboard cut from launch is the most counter-intuitive call. Reasoning: shipping a credibility surface before having credible numbers (gold set < 50 docs/type) makes the surface itself a liability. Discord alerts and CI artifacts are the operational floor; the dashboard is a marketing surface that can wait until the gold set diversifies.

### 22.4 What this section is NOT

This is not a phased implementation plan. It does not specify: what gets built first vs. second, who builds what, how Claude Code tasks are decomposed, what the dependency graph looks like, what migrates from v1 in what order. Those belong in a separate `extraction-v2-implementation-plan.md` produced after architecture approval.

This section is the **scope contract**: what exists vs. what doesn't when v2 is declared launched.
