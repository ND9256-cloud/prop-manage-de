---
doc_type: wohnungsuebergabeprotokoll
default_claim_kind: event
last_updated: 2026-05-11
legal_grounding:
  - statute: BGB §535
    description: >
      Vertragstypische Pflichten beim Mietvertrag — the landlord must
      provide the leased premises in a condition suitable for contractual
      use. The Übergabeprotokoll documents the physical handover that
      satisfies (or fails to satisfy) this obligation. It is the evidentiary
      record of the premises' condition at the moment possession transfers.
  - statute: BGB §548
    description: >
      Verjährung der Ersatzansprüche und des Wegnahmerechts — upon return
      of the leased premises, the landlord's claims for damages and the
      tenant's right to remove improvements are subject to a six-month
      limitation period. The Auszug-Übergabeprotokoll triggers this
      period and documents the condition baseline against which damage
      claims are assessed.
fields_governed:
  - uebergabe_typ
  - unit_ref
  - uebergabe_datum
  - kaeufer
  - verkaeufer
  - mieter_in
  - mieter_out
  - meter_readings
  - damages_noted
normalization_rules:
  - id: uebergabe_typ_canonical_values
    field: uebergabe_typ
    description: |
      The uebergabe_typ field must be normalized to one of four canonical
      values: Einzug, Auszug, Eigentümerwechsel, or unklar.

      Free-form variants must be mapped as follows:
      - "Einzugsprotokoll" → "Einzug"
      - "Auszugsprotokoll" or "Wohnungsrückgabe" → "Auszug"
      - "Eigentümerwechsel-Protokoll", or any document that references
        Käufer/Verkäufer or a Kaufvertrag → "Eigentümerwechsel"
      - Anything ambiguous, missing a clear primary signal, or containing
        contradictory indicators → "unklar" (forces human review)

      The canonical value drives all downstream behavior: claim emission,
      claim closure, and blocker checks. A wrong uebergabe_typ produces
      wrong claims. When in doubt, "unklar" is always the safe default.
gotchas:
  - id: eigentuemerwechsel_does_not_invalidate_tenants
    real_failure_reference: hofmann_unklar
    description: |
      An Übergabeprotokoll with uebergabe_typ = "Eigentümerwechsel"
      documents a property sale — the transfer of ownership from one
      landlord to another. The tenants stay; only the landlord changes.
      Under BGB §566 ("Kauf bricht nicht Miete"), existing lease
      agreements survive a change of ownership automatically.

      The closure logic must emit an owner claim (or close the previous
      owner claim) and must NOT close any tenant_active or kaltmiete
      claims for the property or any of its units. The blocker_check
      on the Eigentümerwechsel closes entry enforces this constraint
      structurally.

      Concrete case (HHS55 DG, November 2025): an Eigentümerwechsel-
      Übergabeprotokoll documented the sale from Cornelia Bernhardt
      (Verkäufer) to Denn Immobilienverwaltung eGbR (Käufer). Dr. Hellen
      Hofmann was a sitting tenant in the DG unit since 2021, paying
      €900/month Kaltmiete. A pipeline that conflated Eigentümerwechsel
      with Mieterwechsel closed Hofmann's tenant_active and kaltmiete
      claims, dropping the property's monthly rent total from €1,900
      to €1,000. The fix is the dispatch on uebergabe_typ and the
      blocker_check on the Eigentümerwechsel closure rule.
  - id: ambiguous_uebergabe_typ_forces_human_review
    description: |
      If the document does not clearly signal Einzug, Auszug, or
      Eigentümerwechsel, extraction must set uebergabe_typ = "unklar"
      and absence_state = "requires_human_review". The emitter must
      skip claim emission entirely for unklar Protokolle. This is the
      safe default — better no claim than a wrong claim.

      Common ambiguity sources include: contractor walkthrough protocols
      (Begehungsprotokolle) that use Übergabeprotokoll templates,
      dual-purpose inspection records, drafts without signatures, and
      documents where both tenant change and owner change signals are
      present without a clear primary event.
  - id: meter_readings_are_evidence_not_claims
    description: |
      Zählerstände (meter readings for Strom, Gas, Wasser, Heizung)
      documented in an Übergabeprotokoll establish a baseline for
      utility accounting but are not directly emitted as claims by the
      v2 pipeline at launch. They are stored in the envelope's
      fields.meter_readings and surface in the triage UI for human
      reference.

      Downstream consumption — utility cost allocation, Nebenkosten-
      abrechnung generation, consumption delta computation between
      Einzug and Auszug readings — is Phase 2+ scope. At launch,
      meter readings are evidence, not actionable claims.
adversarial_fixtures_required:
  - einzug_explicit
  - auszug_explicit
  - eigentuemerwechsel_explicit
  - ambiguous_unklar
  - mixed_einzug_and_eigentuemerwechsel
closes:
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:<unit_ref>"
    close_mode: close_overlapping_and_future
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: uebergabe_datum
    match_requirements:
      property_id: same_as_protocol
      unit_ref: from_protocol
  - target_predicate: tenant_active
    target_subject_pattern: "tenant:<mieter_out>"
    close_mode: close_overlapping_and_future
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: uebergabe_datum
    match_requirements:
      property_id: same_as_protocol
      unit_ref: from_protocol
      tenant_name: from_protocol_mieter_out
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
---

# Wohnungsübergabeprotokoll — domain knowledge

## Why this matters

The Wohnungsübergabeprotokoll is a single document type whose semantic content depends entirely on a single field: uebergabe_typ. Three fundamentally different real-world events — a tenant moving in, a tenant moving out, and a property changing owners — are all recorded under the same document name. The extraction and claim emission logic must dispatch on uebergabe_typ before doing anything else; conflating types breaks the rent roll.

Unlike a Mietvertrag, which asserts ongoing facts, the Übergabeprotokoll records a discrete event at a specific moment in time. This is why its default_claim_kind is `event` rather than `assertion`. The event either happened or it did not; there is no temporal range to resolve.

## The four uebergabe_typ values

**Einzug** — a tenant moves into a unit. The Übergabeprotokoll documents the physical handover of the premises to the new tenant. This event emits new tenant_active and kaltmiete claims for the unit. It does not close any prior claims; the previous tenant's departure is documented by their own Auszug-Übergabeprotokoll, which is a separate document.

**Auszug** — a tenant moves out of a unit. The Übergabeprotokoll documents the return of the premises to the landlord. This event closes the tenant_active and kaltmiete claims for the departing tenant on that unit, effective as of the uebergabe_datum. The close_mode is close_overlapping_and_future because a departure ends both current and any future-dated claims for that tenant on that unit.

**Eigentümerwechsel** — ownership of the property transfers from one landlord to another. The Übergabeprotokoll documents the handover of the property (not of a unit to a tenant). This event closes the previous owner's owner claim and emits a new owner claim for the buyer. Critically, it does NOT close any tenant_active or kaltmiete claims. Under BGB §566 ("Kauf bricht nicht Miete"), existing leases survive a change of ownership. The close_mode is close_overlapping_only because only the current owner claim is affected; there are no future-dated owner claims to consider.

**unklar** — the document does not clearly indicate which of the above events it records. Extraction sets uebergabe_typ to "unklar" and absence_state to "requires_human_review". The emitter skips claim emission entirely. Better no claim than a wrong claim.

## The Hofmann case

At HHS55 DG in November 2025, an Eigentümerwechsel-Übergabeprotokoll documented the sale of the property from Cornelia Bernhardt (Verkäufer) to Denn Immobilienverwaltung eGbR (Käufer). Dr. Hellen Hofmann was a sitting tenant in the DG unit since 2021, paying €900/month Kaltmiete. The legacy extraction pipeline did not distinguish between Eigentümerwechsel and Mieterwechsel. It treated the ownership transfer as a tenant departure, closing Hofmann's tenant_active and kaltmiete claims. This dropped the property's monthly rent total from €1,900 to €1,000.

The fix is structural: the Eigentümerwechsel closure rule carries a blocker_check that explicitly forbids closing tenant_active or kaltmiete claims. The emitter must verify these conditions before applying any closures. This is not a soft guideline — it is an enforced constraint in the closure specification.

## Disambiguation signals

Recognizing the correct uebergabe_typ from document structure requires attention to specific textual and structural signals. Einzug protocols typically contain a tenant signature with language like "übernehme die Wohnung", an Übergabe- or Einzugsdatum, and meter readings recorded as starting baselines. Auszug protocols use "Rückgabe" or "Wohnungsrückgabe" language, contain a tenant signature with "übergebe die Wohnung", often document damages or defects, and record meter readings as closing values. Eigentümerwechsel protocols name a Käufer and Verkäufer, reference a Kaufvertrag, typically lack a Mieter signature (or include the Mieter only as a bystander), and identify the property rather than a specific unit. Documents that exhibit a mix of these signals, lack a primary signature, are in draft status, or use generic walkthrough language should be classified as "unklar".

## What this doc_type does

The Wohnungsübergabeprotokoll is primarily a claim closer (for Auszug and Eigentümerwechsel events) and secondarily a baseline recorder (for meter readings and damages). Its emitter must dispatch on uebergabe_typ before performing any claim operations. Einzug emits new claims but closes nothing. Auszug closes tenant claims. Eigentümerwechsel closes the owner claim only. Unklar does nothing and defers to human review.

## References

Architecture: §4.5 (doc-type taxonomy and the Übergabeprotokoll exception), §1 (the Hofmann case and design principles). Legal: BGB §535 (lease obligations and the handover they require), BGB §548 (limitation period triggered by Auszug handover).
