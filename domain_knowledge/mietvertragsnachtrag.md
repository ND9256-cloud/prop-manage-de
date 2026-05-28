---
doc_type: mietvertragsnachtrag
default_claim_kind: reference
last_updated: 2026-05-28
legal_grounding:
  - statute: BGB §311 Abs. 1
    description: >
      Amendment of an existing contract by mutual agreement. A
      Mietvertragsnachtrag is a bilateral modification of the lease — it
      requires both parties' consent, distinguishing it from a unilateral
      §558/§559 Mieterhöhung.
  - statute: BGB §550
    description: >
      Written-form requirement for leases longer than one year. Material
      amendments to such leases generally require written form to remain
      enforceable; the Nachtrag is that written instrument.
fields_governed:
  - nachtrag_scope
  - unit_ref
  - effective_date
  - tenant_identity
  - landlord_signature_present
  - tenant_signature_present
  - document_status
  - rent_change_payload
  - tenant_identity_change_payload
  - deposit_change_payload
  - ancillary_cost_change_payload
  - term_change_payload
  - usage_right_change_payload
  - other_change_descriptor
normalization_rules:
  - id: nachtrag_scope_canonical_values
    field: nachtrag_scope
    description: |
      nachtrag_scope must normalize to exactly one of: rent_change,
      tenant_identity_change, deposit_change, ancillary_cost_change,
      term_change, usage_right_change, other. Classify by WHAT the
      amendment changes, never by the document title (many Nachträge are
      titled generically). When multiple scopes are present, see the
      multi_scope_documents gotcha.
gotchas:
  - id: scope_classification_accuracy_critical
    description: |
      The nachtrag_scope drives whether this document supersedes rent
      (delegated to the Mieterhöhung emitter) or merely records a reference
      claim. A rent_change misclassified as usage_right_change would fail to
      update the rent; a usage_right_change misclassified as rent_change
      would route to the Mieterhöhung emitter and fail (no new_kaltmiete).
      Classification accuracy is the single most consequential extraction
      decision for this doc_type.
  - id: multi_scope_documents
    description: |
      A single Nachtrag may change several terms at once (e.g. rent AND
      parking). At launch the emitter handles the PRIMARY scope only. If the
      extraction signals multiple scopes, nachtrag_scope is set to the
      rent_change scope if rent is among them (rent supersession is the
      highest-stakes action); otherwise to "other", and the document is
      flagged requires_review so a human can adjudicate the secondary terms.
      Emitting partial multi-scope claims silently is worse than deferring.
  - id: rent_change_delegates_to_mieterhoehung
    description: |
      When nachtrag_scope == "rent_change", this emitter does NOT implement
      rent supersession itself. It builds a Mieterhöhung-shaped extraction
      from rent_change_payload + the common fields and delegates to
      emitMieterhoehungClaims. This keeps a single source of truth for the
      close_overlapping_only kaltmiete supersession logic. A bilateral
      rent-change Nachtrag and a unilateral §558 notice produce identical
      claim shapes via the same emitter.
  - id: non_rent_scopes_emit_reference_claims_only
    description: |
      All non-rent scopes (tenant_identity_change, deposit_change,
      ancillary_cost_change, term_change, usage_right_change, other) emit a
      single reference-kind claim with predicate "amendment_present" and
      value carrying the scope + payload + status
      "unsupported_requires_review". They produce NO closure intents and
      NEVER close tenant_active, kaltmiete, or any other claim. A tenant
      identity change Nachtrag does not close the tenant_active claim — the
      tenancy continues, only a name/party detail changed.
  - id: misclassified_as_mieterhoehung
    description: |
      If the Step 4 classifier wrongly routes a non-rent Nachtrag to the
      mieterhoehung doc_type, the Mieterhöhung emitter throws (new_kaltmiete
      absent) and the extraction surfaces in triage with a classification
      error. This is the SAFE failure: a loud rejection in triage rather
      than silent rent corruption. The Step 4 prompt must classify by what
      changes, not by the word "Nachtrag" or "Mieterhöhung" in the title.
adversarial_fixtures_required:
  - nachtrag_pet_clause_usage_right
  - nachtrag_tenant_identity_change
  - nachtrag_bilateral_rent_change
  - nachtrag_misclassified_as_mieterhoehung_at_step4
  - nachtrag_multi_scope_rent_and_parking
closes: []
---

# Mietvertragsnachtrag — domain knowledge

A Mietvertragsnachtrag is a bilateral amendment to an existing lease. Unlike a
§558/§559 Mieterhöhung (a unilateral landlord notice), a Nachtrag is signed by
both parties and can change any term: rent, deposit, ancillary costs, lease
duration, permitted use, or party details.

## Why this doc_type exists separately from Mieterhöhung

Originally all amendments were funneled into the Mieterhöhung doc_type. That
caused silent data loss: a pet-clause Nachtrag has no new rent, so a
rent-centric emitter either rejected it (losing the amendment record) or, worse,
emitted garbage. Splitting Mietvertragsnachtrag out lets non-rent amendments be
recorded as reference claims while rent-change amendments still get correct
supersession via delegation.

## The scope discriminator

`nachtrag_scope` is classified by WHAT the amendment changes:
- **rent_change** — changes the Kaltmiete. Delegated to the Mieterhöhung emitter.
- **tenant_identity_change** — a party detail changes (marriage name change, a
  co-tenant added/removed). The tenancy continues; only a detail changes.
- **deposit_change** — the Kaution amount or terms change.
- **ancillary_cost_change** — Nebenkosten allocation or prepayment changes.
- **term_change** — lease duration, notice period, or end date changes.
- **usage_right_change** — permitted use changes (pets, subletting, parking,
  commercial use).
- **other** — anything not covered above, or multi-scope documents deferred
  for human adjudication.

## The delegation pattern

When `nachtrag_scope == "rent_change"`, this emitter does not reimplement rent
supersession. It constructs a Mieterhöhung-shaped extraction from the
rent_change_payload and the common fields, then calls the Mieterhöhung emitter.
This guarantees a bilateral rent-change Nachtrag and a unilateral §558 notice
produce identical claim shapes and identical close_overlapping_only behavior —
one source of truth for rent supersession. The actual closure intent (against
the prior `kaltmiete` claim, `close_overlapping_only`, `close_at = effective_date
- 1 day`) is produced by `emitMieterhoehungClaims`; this doc_type's
`closes` array is therefore empty in the front-matter (the closure is owned by
the delegate, not declared here).

## Non-rent scopes are reference-only

Every non-rent scope emits a single reference-kind claim
(predicate "amendment_present") carrying the scope and payload, with status
"unsupported_requires_review". These claims are informational: they record that
an amendment exists and what it concerns, surfaced in triage, without mutating
any resolver-backed fact. Critically, a tenant_identity_change Nachtrag does NOT
close the tenant_active claim — the tenancy persists; only a detail changed.

## References

Architecture: §4.2 (claim_kind includes `reference`), §4.4 (emitter purity),
§5.5 (closure pattern — delegated to Mieterhöhung), §6.3 (this file format).
Legal: BGB §311 Abs. 1, §550. Sibling doc_type: Mieterhöhung
(`domain_knowledge/mieterhoehung.md` — the delegation target).
