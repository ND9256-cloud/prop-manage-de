---
doc_type: mieterhoehung
default_claim_kind: assertion
last_updated: 2026-05-27
legal_grounding:
  - statute: BGB §557
    description: >
      Mieterhöhungen nach Vereinbarung oder Gesetz — the general statutory
      anchor for residential rent increases. Distinguishes increases by
      mutual agreement from the statutory mechanisms (§558, §559, §560).
  - statute: BGB §558
    description: >
      Mieterhöhung bis zur ortsüblichen Vergleichsmiete — increase to the
      local comparable rent. A unilateral landlord notice; the tenant has a
      Zustimmungsfrist (consent window) that delays the effective date.
      Capped by the Kappungsgrenze (15-20% over three years).
  - statute: BGB §559
    description: >
      Mieterhöhung nach Modernisierung — increase after qualifying
      modernization. Unilateral landlord notice with form requirements.
  - statute: BGB §559b
    description: >
      Geltendmachung der Erhöhung (Modernisierung) — form and content
      requirements for a valid §559 Modernisierungsmieterhöhung.
  - statute: BGB §560
    description: >
      Veränderungen von Betriebskosten und Indexmiete — index-based rent
      adjustment formulas (Indexmiete tied to the Verbraucherpreisindex).
normalization_rules:
  - id: effective_date_required_for_closure
    field: effective_date
    description: |
      A Mieterhöhung without an effective_date cannot produce a closure
      intent. The new kaltmiete claim is still emitted with reduced
      confidence ("low") and the closure intent is omitted entirely. The
      case surfaces in triage for manual effective_date setting. The
      emitter never falls back to notice_date for valid_from of the
      closing edge — notice_date is informational only.
  - id: signature_requirements_per_grundlage
    field: tenant_signature_present
    description: |
      §558 (Vergleichsmieten) and §559 (Modernisierung) are unilateral
      landlord notices — tenant signature is NOT required for legal
      validity. Indexmiete and bilateral Mietvertragsnachtrag amendments
      with rent-change scope DO require tenant signature. The emitter uses
      landlord_signature_present as the closure prerequisite;
      tenant_signature_present is informational and preserved for
      downstream legal review.
gotchas:
  - id: scope_narrowed_to_rent_change
    real_failure_reference: nachtrag_misclassified_as_mieterhoehung
    description: |
      This doc_type covers ONLY rent-change amendments. Non-rent Nachträge
      (pet clauses, parking, ancillary-cost reallocation) belong to
      mietvertragsnachtrag. Misclassification causes silent data loss: the
      emitter expects new_kaltmiete and throws when it is absent, or — worse
      if a stray rent figure is present — produces a wrong kaltmiete claim.
  - id: kappungsgrenze_15_percent
    description: |
      §558 increases are capped at 15% within three years (some
      municipalities tighten this to 15% absolute; others allow 20%). The
      emitter does NOT enforce the cap — that is a downstream presenter and
      legal-review concern. Extraction must preserve previous_kaltmiete so
      the cap can be evaluated against the prior rent.
  - id: tenant_consent_requirement
    description: |
      Bilateral rent-change amendments (where both parties sign) are legally
      distinct from unilateral §558/§559 notices. Both arrive as the
      mieterhoehung doc_type, but the consent path matters for
      enforceability. The emitter records tenant_signature_present so
      downstream can distinguish the two without re-reading the document.
  - id: effective_date_vs_notice_date
    description: |
      §558 increases require a Zustimmungsfrist (consent window) that delays
      the effective_date well past notice_date. The emitter uses
      effective_date for the new claim's valid_from and for the closure
      edge, never notice_date. If effective_date is absent and notice_date
      is present, the emitter does NOT default to notice_date — it omits the
      closure intent (see normalization_rule effective_date_required_for_closure).
  - id: future_dated_increase_no_immediate_closure
    description: |
      A Mieterhöhung with effective_date > today produces a future-dated
      kaltmiete claim. The closure edge is effective_date - 1 day. The
      applier applies the closure as part of the same transaction; the OLD
      claim's valid_to is set to the day before the increase takes effect.
      A resolver query with as_of_date < effective_date still returns the
      OLD rent (correct).
  - id: staffelmiete_mid_schedule_amendment
    real_failure_reference: staffelmiete_amendment_ambiguity
    description: |
      If the unit has existing future-dated Staffelmiete claims (pre-emitted
      from a Mietvertrag with a Staffelplan), a Mieterhöhung arriving
      mid-schedule creates ambiguity: does the new agreement supersede the
      entire Staffelplan or just the next step? The emitter sets the closure
      intent's blocker_status to "requires_review" if the source extraction
      signals Staffelmiete context (field staffelmiete_context == true). The
      applier ALSO independently checks open future-dated kaltmiete claims
      via §5.5.5 (checkStaffelmieteConflict) and blocks regardless. Two
      layers of safety; a human adjudicates in triage.
  - id: closure_prerequisites
    description: |
      The emitter omits the closure intent entirely (still emitting the new
      kaltmiete claim with reduced confidence) if any prerequisite fails:
      missing effective_date, missing unit_ref, document_status of "draft"
      or "unsigned", or landlord_signature_present not true. The new claim
      is emitted as low-confidence so it appears in triage but does not
      silently overwrite the open kaltmiete via close_overlapping_only
      semantics. The triggering kaltmiete_amended event claim and the
      closure are emitted together or not at all.
adversarial_fixtures_required:
  - paul_mieterhoehung_625_to_650
  - mieterhoehung_draft_unsigned
  - mieterhoehung_with_staffelmiete_context
  - mieterhoehung_missing_effective_date
  - mieterhoehung_indexmiete_recomputation
  - mieterhoehung_misclassified_pet_clause_nachtrag
fields_governed:
  - nachtrag_typ
  - rechtsgrundlage
  - new_kaltmiete
  - previous_kaltmiete
  - effective_date
  - notice_date
  - unit_ref
  - tenant_identity
  - landlord_signature_present
  - tenant_signature_present
  - document_status
  - staffelmiete_context
closes:
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:<unit_ref>"
    close_mode: close_overlapping_only
    when: "landlord_signature_present == true AND effective_date is present AND unit_ref is present AND document_status not in [draft, unsigned]"
    valid_to_source: "effective_date - 1 day"
    match_requirements:
      unit_ref: required
      tenant_identity: optional
    blocker_check:
      - staffelmiete_conflict
---

# Mieterhöhung — domain knowledge

A Mieterhöhung is a rent-increase amendment to an existing Mietvertrag. It is
the first doc_type in the v2 chain that *closes* a prior claim: the new
kaltmiete supersedes the old one as of the increase's effective date. German
tenancy law treats the grounds (Rechtsgrundlagen) differently:

- **§558 (Vergleichsmieten)** — landlord notice citing local comparable
  rents. Unilateral; the tenant has a Zustimmungsfrist (consent window).
  Effective date is typically three months after notice. Capped at 15-20%
  over three years (Kappungsgrenze).
- **§559 (Modernisierung)** — landlord notice after qualifying modernization.
  Unilateral with form requirements per §559b. No consent window in the same
  sense — the tenant may object on hardship grounds, but the increase
  generally takes effect.
- **Indexmiete (§560)** — automatic adjustment formula tied to the consumer
  price index. The Mieterhöhung document declares the new amount; the formula
  was agreed in the original Mietvertrag.
- **Staffelmiete (§557a)** — a pre-agreed schedule in the original Mietvertrag.
  No separate Mieterhöhung document is needed for normal schedule steps; a
  Mieterhöhung document arriving in a Staffelmiete context typically signals a
  renegotiation that supersedes the schedule.
- **Bilateral Mietvertragsnachtrag with rent-change scope** — both parties
  sign a fresh amendment changing the rent. Legally robust; no consent window
  because consent is in the signature.

The emitter does not pick between these — it records `rechtsgrundlage` and
trusts downstream presenters to surface the legal context. What it DOES
enforce is the closure prerequisite chain: no signature, no closure.

## Emission behaviour

For every Mieterhöhung the emitter produces a new `kaltmiete` assertion claim
(subject `unit:<unit_ref>`, valid_from = effective_date). This claim is
emitted **always**, even when closure prerequisites fail — losing the proposed
new rent because of a missing signature is worse than surfacing a
low-confidence claim in triage.

When the closure prerequisites pass (landlord signed, effective_date present,
unit_ref present, document_status not draft/unsigned) the emitter additionally
produces:

1. A `kaltmiete_amended` **event** claim. This is the triggering event the
   claim-store applier dispatches its claim-aware blocker checks on (§5.5.5).
   It is the `reason_claim_id` recorded on every closure the applier writes.
2. A **closure intent** (`ClaimClosure`) targeting the prior open `kaltmiete`
   claim for the same unit, with `close_mode: close_overlapping_only` and a
   close edge of `effective_date - 1 day`.

The event claim and the closure intent are emitted together or not at all: the
applier requires exactly one event claim whenever a closure intent is present.

## Closure safety and Staffelmiete

If the source extraction set `staffelmiete_context == true`, the emitter marks
the closure intent `blocker_status: requires_review`. This is a HEURISTIC
signal from the document text. The applier independently re-checks the claim
store for open future-dated `kaltmiete` claims (`checkStaffelmieteConflict`,
§5.5.5) and blocks the closure regardless of the emitter flag. The applier is
the authoritative source; the emitter's flag is defence in depth.

## What this doc_type does not do

- It does NOT emit `tenant_active`. The tenant claim from the original
  Mietvertrag remains valid through a rent amendment. Mieterhöhung amends
  rent, not tenancy.
- It does NOT enforce the Kappungsgrenze cap — that is downstream legal review.
- It does NOT produce Indexmiete recomputation claims — the index formula is
  recorded for presentation; periodic recomputation is a separate field-level
  resolver (later task).
- It does NOT cover non-rent amendments — those are `mietvertragsnachtrag`.

## References

Architecture: §5.5 (closure pattern), §5.5.2 (closing matrix:
`kaltmiete_amended → kaltmiete`, `close_overlapping_only`), §5.5.3 (close
modes), §5.5.4 (applier safety rules), §5.5.5 (claim-aware blockers), §6.3
(this file format). Legal: BGB §557, §558, §559, §559b, §560, §557a.
