---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-11
legal_grounding:
  - statute: BGB §535
    description: >
      Vertragstypische Pflichten beim Mietvertrag — defines the lease
      contract: the landlord must provide the leased premises and maintain
      them in a condition suitable for use; the tenant must pay the agreed
      rent. This is the statutory anchor for every field extracted from a
      Mietvertrag.
  - statute: BGB §557
    description: >
      Mieterhöhungen nach Vereinbarung oder Gesetz — governs under which
      conditions rent may be increased. Subsections §557a (Staffelmiete)
      and §557b (Indexmiete) define two structured increase mechanisms that
      affect how kaltmiete claims evolve over time.
  - statute: BGB §573
    description: >
      Ordentliche Kündigung des Vermieters — the landlord may only
      terminate a residential lease for cause (Eigenbedarf, breach, or
      economic exploitation). Relevant because the Mietvertrag defines
      the tenancy relationship that termination rules protect.
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
      Kaltmiete is base rent only — the tenant's payment for the right
      to use the premises, excluding all ancillary costs.

      Synonyms that map to kaltmiete: "Grundmiete", "Nettomiete",
      "Nettokaltmiete". These terms are interchangeable in practice and
      always refer to the base rent component.

      Terms that do NOT map to kaltmiete: "Bruttomiete", "Inklusivmiete",
      "Warmmiete", "Bruttowarmmiete". These bundle Nebenkosten into a
      single figure. When encountered, the kaltmiete component cannot
      be cleanly separated and the field's absence_state must be set
      to "ambiguous".
gotchas:
  - id: nachtrag_supersession
    real_failure_reference: weber_900_vs_1000
    description: |
      A Nachtrag or Mieterhöhung document modifies kaltmiete with a
      later valid_from date. The Mietvertrag extractor must NOT merge
      the Nachtrag's value into the original Mietvertrag's extraction.
      Each document is extracted as-of-its-own-time. Supersession is
      resolved in the claim layer, not at extraction.

      Concrete case (HHS55 1.OG, J.H. Weber): the original Mietvertrag
      from 2010 stated €900 Kaltmiete. A 1. Nachtrag set it to €1,000
      effective 2015. Both extractions are individually correct — €900
      from the Mietvertrag, €1,000 from the Nachtrag. Only the claim
      layer's temporal resolution determines the current value. An
      extractor that reports €1,000 on the original Mietvertrag has
      leaked a future Nachtrag into the wrong document context.
  - id: indexmiete_vs_staffelmiete
    description: |
      Indexmiete (BGB §557b) ties rent to the Verbraucherpreisindex
      (consumer price index). The lease contains a formula, not a
      fixed schedule. Downstream, this produces a stable claim that
      requires a periodic recomputation job when the index is published.

      Staffelmiete (BGB §557a) specifies pre-agreed rent increases at
      fixed dates (e.g., "ab 01.01.2027: €1,050; ab 01.01.2028: €1,100").
      Downstream, this produces multiple pre-emitted claims with future
      valid_from dates.

      Both clause types appear in residential leases. Conflating them
      produces wrong claim emission patterns. For v2 launch, both are
      out of scope for structured extraction but must be detected and
      flagged with absence_state: requires_human_review if present.
  - id: bruttomiete_misinterpretation
    description: |
      A Mietvertrag using "Bruttomiete" or "Inklusivmiete" terminology
      bundles Nebenkosten into a single rent figure. The kaltmiete
      field cannot be cleanly extracted because the base rent component
      is not stated separately. The extractor must set kaltmiete's
      absence_state to "ambiguous" rather than guessing a split.

      This is the extraction-time counterpart of the
      kaltmiete_excludes_nebenkosten normalization rule. The rule
      defines the vocabulary boundary; this gotcha defines the failure
      mode when the boundary is crossed.
  - id: gewerbe_misclassification
    description: |
      A Gewerbemietvertrag (commercial lease) is legally distinct from
      a Wohnraummietvertrag (residential lease). Different BGB sections
      apply: commercial leases are governed primarily by general lease
      law (BGB §535 ff.) without the residential tenant protections of
      BGB §573 ff. Rent regulation, termination protection, and deposit
      limits differ fundamentally.

      The classifier may misroute a Gewerbemietvertrag as doc_type
      "mietvertrag" (which in this system means residential). Detection
      signals: the tenant is a GmbH, UG, or AG; the use clause
      (Nutzungsklausel) mentions "Gewerbe", "Büro", or "Praxis"; the
      lease references HGB rather than or in addition to BGB.

      Concrete case (HHS55 1.OG, J.H. Weber Versicherungsmakler GmbH):
      a commercial tenancy that must NOT be treated under §573
      residential termination rules. Applying residential extraction
      schemas to a commercial lease produces structurally wrong claims.
adversarial_fixtures_required:
  - draft_unsigned
  - mietvertrag_with_nachtrag_attached
  - indexmiete_clause
  - staffelmiete_clause
  - gewerbemietvertrag_misclassified_as_residential
  - with_handwritten_amendment
closes: []
---

# Mietvertrag — domain knowledge

## Why this matters

The Mietvertrag is the foundational tenancy document. Per BGB §535, it establishes the landlord's obligation to provide the premises and the tenant's obligation to pay rent. Nearly every claim the system makes about a unit's occupancy — rent amount, deposit, parties, tenancy start and end — traces back to a Mietvertrag or to a document that modifies one (Nachtrag, Mieterhöhung).

In the v2 extraction pipeline, the Mietvertrag's role is strictly to assert facts as-of-the-document's-own-time. It does not resolve conflicts, does not incorporate later amendments, and does not determine the "current" rent. That resolution happens downstream in the claim layer.

## The fields

**kaltmiete** — the monthly base rent excluding Nebenkosten. Found in the contract's rent section, usually under a heading like "Miete" or "Mietzins." Common synonyms that map directly: Grundmiete, Nettomiete. Terms that do NOT map: Bruttomiete, Inklusivmiete, Warmmiete — these bundle operating costs and the kaltmiete component cannot be cleanly separated.

**nebenkostenvorauszahlung** — the monthly advance payment for ancillary costs (Betriebskosten). Typically stated alongside or immediately after the Kaltmiete. Per BGB §556, landlord and tenant may agree that the tenant pays a Vorauszahlung toward operating costs.

**kaution** — the security deposit, usually expressed as a multiple of Kaltmiete (the statutory cap under BGB §551 is three months' Nettokaltmiete). Stated in the deposit clause.

**mietbeginn** — the date the lease takes effect. Nearly always explicit; rarely requires inference.

**mietende** — the date the lease ends, if fixed-term. Most German residential leases are unbefristet (open-ended), in which case the extraction produces mietende with `absence_state: not_applicable` rather than omitting the field. The presence/absence pattern carries information.

**tenant_identity** and **landlord_identity** — the parties to the contract. These appear on the first page or in a preamble. For tenant_identity, watch for multiple tenants (Mietgemeinschaft) sharing one lease.

**unit_ref** — the unit identifier, typically an address plus floor/position (e.g., "EG links", "1.OG rechts", "DG"). Template-based contracts sometimes carry boilerplate unit references from a different unit — the Paul case demonstrated this: a template pre-filled with the wrong address that was only partially corrected by hand. The extractor must take unit_ref from the filled-in fields, not from headers or footers that may be template artifacts.

## The gotchas in practice

**Nachtrag supersession (weber_900_vs_1000).** At HHS55 1.OG, the Weber Mietvertrag from 2010 stated €900 Kaltmiete. A 1. Nachtrag in 2015 raised it to €1,000. Both documents are in the system. The extractor must report €900 for the Mietvertrag and €1,000 for the Nachtrag — each document extracted as-of-its-own-time. The claim layer handles temporal resolution. An extractor that contaminates the Mietvertrag extraction with the Nachtrag's value breaks the entire supersession model.

**Indexmiete vs. Staffelmiete.** Both are structured rent increase mechanisms permitted under BGB §557a/§557b. Indexmiete ties rent to the consumer price index; Staffelmiete defines a fixed schedule of future increases. They produce fundamentally different claim emission patterns downstream. For v2 launch, both are out of extraction scope but must be detected and flagged with `absence_state: requires_human_review`.

**Bruttomiete misinterpretation.** When a contract uses Bruttomiete or Inklusivmiete terminology, the Kaltmiete component is not separately stated. The extractor must not guess a split — it sets `absence_state: ambiguous` on the kaltmiete field.

**Gewerbe misclassification.** The Weber case at HHS55 1.OG involved J.H. Weber Versicherungsmakler GmbH — a commercial tenant. A Gewerbemietvertrag is governed by different rules than a Wohnraummietvertrag: no §573 termination protection, no §557 rent increase limits, no §551 deposit cap. If the classifier routes a commercial lease into the residential extraction path, every downstream claim is structurally wrong. Detection signals: tenant is a legal entity (GmbH/UG/AG), use clause mentions "Gewerbe" or "Büro", contract references HGB.

## What this doc_type does not do

Mietvertrag does NOT close other claims. It only asserts. A Mietvertrag does not end a previous tenancy — that is the role of a Kündigung or Aufhebungsvertrag (separate domain knowledge files). Similarly, a Nachtrag's modification of rent is handled by the Nachtrag's own extraction and the claim layer's temporal resolution, not by the Mietvertrag extractor retroactively updating its output.

## References

Architecture: §6.3 (file format), §6.4 (consumer contract), §1 (design principles and real failure cases). Legal: BGB §535 (lease obligations), §556 (Betriebskosten agreements), §557/§557a/§557b (rent increases), §573 (landlord termination).
