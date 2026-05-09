# Extraction v2 — Pass 2: Schemas

**Status:** Pass 2, draft for review. Architecture (Pass 1) locked.
**Owner:** Nils.
**Scope:** Schemas for the two launch-slice doc types (Mietvertrag, Wohnungsübergabeprotokoll). Each is comprehensive — every field a German lease or handover protocol typically contains is included. Severity-graded so the launch slice ships only critical fields while the schema itself is durable.
**Format:** Domain YAML per architecture §7. Front-matter for `domain_knowledge/<doc_type>.md` is included alongside.
**Date:** 2026-05-08.

---

## How to read this document

For each doc type:

1. **Domain knowledge front-matter** — what goes in `domain_knowledge/<doc_type>.md`. Legal grounding, normalization rules, gotchas, adversarial fixtures, closing matrix.
2. **Schema YAML** — what goes in `schemas/<doc_type>/schema.yaml`. Field definitions with severity, type, conditions, normalization, verifier references.
3. **Field rationale** — for non-obvious fields, why they're in the schema and how they're used.
4. **Worked examples against KO132/HHS55** — what the schema produces for the five real cases.

Field severity levels:
- **`critical`** — must be extracted correctly. Resolver-load-bearing. Verifier-protected. v2 launch validates and acts on these.
- **`important`** — extracted and stored. Useful for triage, audit, and future resolvers. Validated but does not block at launch.
- **`nice_to_have`** — extracted opportunistically. Not validated. Surfaces in triage if present.

Field requiredness levels (orthogonal to severity):
- **`required`** — must be present on every document of this type. Missing = extraction failure.
- **`conditional`** — required only if `condition` is met (e.g., `Staffelmiete schedule required if mietvertrag_typ == "Wohnraum" AND has_staffelmiete == true`).
- **`optional`** — frequently absent, do not penalize.

The launch slice ships **critical-severity required fields only** as load-bearing. Everything else is captured but not blocking.

---

# Doc type 1: Mietvertrag

## Domain knowledge front-matter

**File:** `domain_knowledge/mietvertrag.md`

```yaml
---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §535
    description: Lease contract definition; obligations of landlord and tenant
  - statute: BGB §551
    description: Deposit caps for residential leases (max 3 months Kaltmiete)
  - statute: BGB §556
    description: Nebenkosten allocation rules
  - statute: BGB §557
    description: Rent increase rules (Mieterhöhung framework)
  - statute: BGB §557a
    description: Staffelmiete (graduated rent) requirements
  - statute: BGB §557b
    description: Indexmiete (index-linked rent) requirements
  - statute: BGB §573
    description: Termination by landlord (residential, ordentliche Kündigung)
  - statute: BGB §573c
    description: Notice periods for termination
  - statute: BGB §575
    description: Befristete Mietverträge (fixed-term residential leases)
  - statute: BGB §550
    description: Form requirements for leases over one year
  - statute: BetrKV §2
    description: Catalogue of umlagefähige Nebenkosten
  - statute: HeizkostenV
    description: Allocation rules for heating costs
  - statute: BGB §535ff (Gewerberaummiete)
    description: Commercial leases — different rules; out of v2 launch scope but identified by mietvertrag_typ
fields_governed:
  - mietvertrag_typ
  - kaltmiete
  - nebenkostenvorauszahlung
  - heizkostenvorauszahlung
  - warmmiete_brutto
  - kaution
  - mietbeginn
  - mietende_befristet
  - mietdauer_unbefristet
  - tenant_identity
  - landlord_identity
  - unit_ref
  - unit_address
  - unit_size_qm
  - unit_rooms_count
  - has_staffelmiete
  - staffelmiete_schedule
  - has_indexmiete
  - indexmiete_basis
  - kuendigungsfrist
  - schoenheitsreparaturen_clause
  - tierhaltung_clause
  - untervermietung_clause
  - mitvermieter
  - hausverwaltung
  - signature_date
  - effective_date
  - included_facilities
  - garage_stellplatz
  - keller_dachboden
normalization_rules:
  - id: kaltmiete_excludes_nebenkosten
    field: kaltmiete
    description: |
      Kaltmiete is base rent only. Mappings:
      - "Grundmiete" → kaltmiete (synonym)
      - "Nettokaltmiete" → kaltmiete (synonym, common in Berlin)
      - "Bruttomiete" or "Inklusivmiete" → kaltmiete absence_state="ambiguous"
        because these terms include Nebenkosten and require human review
        to decompose.
      - "Warmmiete" → never kaltmiete; this is warmmiete_brutto
      Verifier rule: kaltmiete must be ≤ warmmiete_brutto if both extracted.
  - id: monetary_minor_units
    field: any monetary field
    description: |
      Always store as integer minor units (cents) + currency. €650.00 →
      { value: 65000, currency: "EUR", raw_value: "650,00 EUR" }.
      Raw_value preserves German formatting (comma as decimal).
  - id: kaution_max_3_kaltmiete
    field: kaution
    description: |
      Per BGB §551, residential deposit cannot exceed 3x Kaltmiete.
      If extracted kaution > 3 * extracted kaltmiete, set
      validation_status="failed_verifier" and confidence="low".
      Commercial leases have no such cap; rule applies only when
      mietvertrag_typ="Wohnraum".
  - id: unit_ref_normalization
    field: unit_ref
    description: |
      Map raw form-template text to canonical unit identifiers:
      - "EG", "Erdgeschoss", "Erdgeschoß" → "EG"
      - "1. OG", "1.OG", "Erstes Obergeschoss", "1. Stock" → "1.OG"
      - "DG", "Dachgeschoss", "Dachgeschoß" → "DG"
      - "KG", "Keller", "Untergeschoss" → "KG"
      - Form template text like "EG Geschoss links – mitte – rechts"
        (the Paul case) → raw_value preserves it, normalized_value="EG"
        unless additional position info ("links"/"mitte"/"rechts") is
        also extracted, in which case unit_ref="EG_links" or similar.
  - id: dem_to_eur_legacy
    field: any monetary field on pre-2002 documents
    description: |
      For documents dated before 2002-01-01 referencing DM amounts:
      preserve original DM as raw_value and authoritative legal amount.
      Derive EUR at official rate (1 EUR = 1.95583 DM) into
      normalized_value. Both stored. Never replace currency.
  - id: kuendigungsfrist_default
    field: kuendigungsfrist
    description: |
      If not explicitly stated for residential lease, defaults to BGB
      §573c statutory framework (3 months for tenant; 3/6/9 months for
      landlord depending on tenancy duration). Set absence_state="inferred"
      if applying default.
gotchas:
  - id: nachtrag_supersession
    description: |
      A Nachtrag dated after the original Mietvertrag may modify
      kaltmiete, nebenkostenvorauszahlung, or other fields. The Nachtrag
      is a SEPARATE document with its own doc_type=mieterhoehung (for rent
      increases) or doc_type=mietvertragsnachtrag (for other amendments).
      The Mietvertrag extractor must NOT merge the Nachtrag's value into
      the original Mietvertrag's extraction. Extraction is per-document;
      supersession is in the claim layer (architecture §4.4, §5.5).
    real_failure_reference: weber_900_vs_1000
    real_failure_reference: paul_525_vs_575
    real_failure_reference: kuru_440_vs_470
  - id: indexmiete_vs_staffelmiete
    description: |
      Indexmiete (BGB §557b): rent tied to Verbraucherpreisindex (VPI).
      Document states the formula; actual rent recomputes when index
      changes. Schema field: has_indexmiete=true, indexmiete_basis stores
      the base index value and the formula. Downstream: a separate job
      recomputes index-adjusted rents and emits new claims with valid_from
      matching the index date.
      Staffelmiete (BGB §557a): rent steps pre-agreed at signing. Document
      lists future rent amounts and effective dates. Schema field:
      has_staffelmiete=true, staffelmiete_schedule is an array of
      (effective_date, kaltmiete) pairs. Downstream: claim emitter pre-emits
      multiple claims with future valid_from dates.
      Both can coexist (rare but legal). Both → human review.
  - id: gewerbe_misclassified_as_wohnraum
    description: |
      Commercial leases (Gewerbemietverträge) sometimes get misclassified
      as residential because the document layout looks similar. Telltales:
      tenant is a GmbH/AG/UG/eK or contains "Praxis"/"Kanzlei"/"Büro";
      VAT (Umsatzsteuer/MwSt) mentioned in rent breakdown; Wertsicherungsklausel
      (commercial rent indexation) present; no reference to BGB §573ff
      (only residential). If telltales present but mietvertrag_typ extracted
      as "Wohnraum", set absence_state="ambiguous" on mietvertrag_typ.
    real_failure_reference: weber_hhs55_1og_commercial
  - id: draft_unsigned
    description: |
      A Mietvertrag without signatures is a draft. Signature lines may
      exist but be empty, or "ENTWURF" / "DRAFT" watermark present.
      Set document_status="draft". Claim emitter returns no claims for
      drafts (architecture §4.4 example).
  - id: handwritten_amendments
    description: |
      Older Mietverträge often have handwritten amendments crossing out
      printed text and writing in alternatives. OCR may extract both the
      crossed-out text and the handwriting as if both apply. The model
      must prefer handwritten amendments when in conflict, AND include
      the crossed-out text as raw_value so audit shows both. Confidence
      downgraded to "medium" when handwritten amendments detected.
  - id: form_template_text_extraction
    description: |
      Mietvertrag form templates (especially Haus & Grund and similar)
      have checkbox fields like "EG ☐ links ☐ mitte ☐ rechts" where only
      one box is checked. Naive extraction returns the template text
      verbatim ("EG Geschoss links – mitte – rechts"). The model must
      identify the actual checked option AND preserve raw_value for audit.
    real_failure_reference: paul_eg_geschoss_links_mitte_rechts
  - id: kalter_betriebskosten_in_warmmiete
    description: |
      "Warmmiete" colloquially means rent + Nebenkosten + Heizkosten.
      "Pauschalmiete" means rent + everything but tenant pays no extra.
      Some contracts only break down Kaltmiete + Nebenkosten without
      Heizkosten. Extraction must be precise: warmmiete_brutto =
      kaltmiete + nebenkostenvorauszahlung + heizkostenvorauszahlung.
      If subfields don't sum to warmmiete_brutto within tolerance,
      flag arithmetic_consistency verifier failure.
  - id: tenant_identity_multiple
    description: |
      Multiple tenants on one Mietvertrag (e.g., couples, WG) all bear
      Gesamtschuldnerische Haftung (joint and several liability).
      tenant_identity is an array. All tenants must be extracted; missing
      one is a critical-severity failure.
adversarial_fixtures_required:
  - draft_unsigned
  - mietvertrag_with_nachtrag_attached
  - indexmiete_clause
  - staffelmiete_clause
  - gewerbemietvertrag_misclassified_as_residential
  - handwritten_amendments
  - form_template_eg_links_mitte_rechts
  - couple_two_tenants
  - dm_legacy_pre_2002
  - bruttomiete_inklusivmiete_ambiguity
  - kaution_exceeds_3x_kaltmiete
closes:
  []  # Mietvertrag itself emits no closures. Only Mieterhöhung,
      # Mietvertragsnachtrag, Kündigung, and Auszug-Übergabeprotokoll
      # produce closures targeting Mietvertrag-derived claims.
---

# Mietvertrag — domain knowledge

(Free-form prose section explaining nuances, with citations. Read by
humans; not parsed by code. Front-matter is the machine-readable contract.)

## What this doc type is

A German Mietvertrag is the foundational contract governing a tenancy
relationship. v2 distinguishes residential (Wohnraummietvertrag, BGB §535ff
+ §549ff) from commercial (Gewerbemietvertrag, BGB §535ff without the
residential protections). The schema covers both via mietvertrag_typ,
but launch slice is residential-focused.

## Why supersession is the default case, not the edge case

Three of five tenants in our reference corpus (Paul, Kuru, Weber) had
rent amounts that changed via Mieterhöhungen or Nachträge. The original
Mietvertrag's kaltmiete is correct *for that document*. It is no longer
the *current* Kaltmiete. The claim layer handles this; extractors must
NOT pre-resolve.

## Why this schema is comprehensive even though launch ships only critical fields

Top-in-class extraction captures every field a German lease typically
contains, even when the launch pipeline only validates a subset. This
prevents redesign when post-launch resolvers need fields that weren't
originally extracted. Severity grades determine what's load-bearing now;
comprehensiveness keeps the foundation durable.

## Commercial leases are categorized but not deeply extracted at launch

Weber GmbH's HHS55 1.OG lease is a Gewerbemietvertrag (commercial).
Launch-slice extraction captures kaltmiete, unit_ref, tenant_identity,
mietbeginn — common to both lease types. Commercial-specific fields
(Wertsicherungsklausel, Konkurrenzschutz, Optionsrecht, VAT breakdown)
are in this schema as `nice_to_have` and extracted opportunistically.
Deep commercial schema is post-launch (deferred per architecture §22).
```

## Schema YAML

**File:** `schemas/mietvertrag/schema.yaml`

```yaml
doc_type: mietvertrag
schema_version: "2026-05-08-v1"
claim_kind: assertion  # default; document_status="draft" produces no claims
domain_knowledge_ref: domain_knowledge/mietvertrag.md
prompt_fragment_template: |
  Du extrahierst strukturierte Felder aus einem deutschen Mietvertrag.
  Gib für jedes Feld value, raw_value, evidence (mit page und quote),
  confidence (high/medium/low), und absence_state zurück.
  
  Beachte folgende Regeln:
  - Kaltmiete ist die reine Grundmiete OHNE Nebenkosten oder Heizkosten.
    "Bruttomiete" oder "Inklusivmiete" → setze absence_state="ambiguous".
  - Wenn Nachträge zum Mietvertrag im Dokument referenziert werden, ignoriere
    deren Werte für DIESES Dokument. Sie werden separat verarbeitet.
  - Bei Formular-Vorlagen (z.B. "EG ☐ links ☐ mitte ☐ rechts"): identifiziere
    die angekreuzte Option, behalte aber den vollen Vorlagentext als raw_value.
  - Bei handschriftlichen Änderungen: bevorzuge die handschriftliche Version,
    behalte aber den durchgestrichenen Text im raw_value.
  - Mehrere Mieter sind möglich (Ehepaare, WGs); tenant_identity ist immer
    ein Array.
  
  [field instructions inserted by generator]

fields:

  # ─── DOCUMENT CLASSIFICATION (foundational; drives downstream rules) ───

  - id: mietvertrag_typ
    german_label: "Vertragsart"
    severity: critical
    requiredness: required
    type: enum
    enum_values: ["Wohnraum", "Gewerbe", "gemischt", "unklar"]
    description: |
      Wohnraum = residential lease (BGB §549ff applies).
      Gewerbe = commercial lease (BGB §535ff without residential protections).
      gemischt = mixed-use (e.g., apartment with attached office space).
      unklar = cannot determine; force human review.
    classification_hints: |
      Telltales for Gewerbe: tenant is GmbH/AG/UG/eK, "Praxis"/"Kanzlei"/
      "Büro" in unit description, VAT breakdown in rent, Wertsicherungsklausel
      present, no reference to BGB §573ff. If conflicting signals: "unklar".
    verifier_refs:
      - enum_validity

  # ─── RENT (the load-bearing fields for v1 launch) ───

  - id: kaltmiete
    german_label: "Kaltmiete"
    severity: critical
    requiredness: required
    type: money
    normalization_rule_ref: kaltmiete_excludes_nebenkosten
    verifier_refs:
      - monetary_verbatim
      - kaltmiete_le_warmmiete  # if warmmiete_brutto extracted
    description: |
      The base rent excluding Nebenkosten and Heizkosten. Required for
      both Wohnraum and Gewerbe. For Gewerbe, this is the net amount
      before VAT (use kaltmiete_vat_amount for VAT).

  - id: nebenkostenvorauszahlung
    german_label: "Nebenkostenvorauszahlung"
    severity: important
    requiredness: conditional
    condition: "mietvertrag_typ in ['Wohnraum', 'gemischt']"
    type: money
    verifier_refs:
      - monetary_verbatim
    description: |
      Monthly advance payment for Nebenkosten (umlagefähige Betriebskosten
      per BetrKV §2). Settled annually via Nebenkostenabrechnung.

  - id: heizkostenvorauszahlung
    german_label: "Heizkostenvorauszahlung"
    severity: important
    requiredness: optional
    type: money
    verifier_refs:
      - monetary_verbatim
    description: |
      Monthly advance payment for Heizkosten (heating + hot water).
      Settled annually per HeizkostenV. May be absent in newer contracts
      that bundle into nebenkostenvorauszahlung.

  - id: warmmiete_brutto
    german_label: "Warmmiete (Brutto)"
    severity: important
    requiredness: optional
    type: money
    verifier_refs:
      - monetary_verbatim
      - arithmetic_consistency  # warmmiete = kalt + neben + heiz
    description: |
      Total monthly rent including all advance payments. If extracted,
      verify it equals kaltmiete + nebenkostenvorauszahlung +
      heizkostenvorauszahlung within €5 tolerance. Mismatch flags
      validation_status="failed_verifier".

  - id: kaution
    german_label: "Kaution"
    severity: important
    requiredness: optional
    type: money
    verifier_refs:
      - monetary_verbatim
      - kaution_max_3_kaltmiete  # for Wohnraum only
    description: |
      Security deposit. For Wohnraum: max 3x Kaltmiete per BGB §551.
      For Gewerbe: no statutory cap. May be paid in installments
      (handle via separate kaution_payment_terms field).

  - id: kaution_payment_terms
    german_label: "Kautionszahlungsweise"
    severity: nice_to_have
    requiredness: optional
    type: enum
    enum_values: ["einmalig", "drei_raten", "andere", "nicht_geregelt"]
    description: |
      How the deposit is paid. BGB §551 allows three installments for
      residential.

  - id: kaltmiete_vat_amount
    german_label: "MwSt auf Kaltmiete"
    severity: nice_to_have
    requiredness: conditional
    condition: "mietvertrag_typ == 'Gewerbe'"
    type: money
    description: |
      VAT amount on the net Kaltmiete. Commercial leases often charge
      19% VAT (Option zur Umsatzsteuer per UStG §9). Residential is
      VAT-exempt. Out of v2 launch deep handling.

  # ─── PARTIES ───

  - id: tenant_identity
    german_label: "Mieter"
    severity: critical
    requiredness: required
    type: structured_array
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: address_at_signing
        type: address
        required: false
      - field: tenant_type
        type: enum
        enum_values: ["natural_person", "legal_entity"]
        required: false
        description: |
          Determined by name pattern. GmbH/AG/UG/eK/eG → legal_entity.
          Otherwise natural_person.
      - field: handelsregister_nummer
        type: string
        required: false
        condition: "tenant_type == 'legal_entity'"
    description: |
      Array of all tenants on the contract. Couples and WGs produce
      multiple entries. Missing one tenant is a critical failure
      (Gesamtschuldnerische Haftung means all tenants are joint-and-
      severally liable; the system needs to know about all of them).

  - id: landlord_identity
    german_label: "Vermieter"
    severity: critical
    requiredness: required
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: address
        type: address
        required: false
      - field: landlord_type
        type: enum
        enum_values: ["natural_person", "legal_entity", "wohnungseigentuemergemeinschaft", "gbr"]
        required: false

  - id: hausverwaltung
    german_label: "Hausverwaltung"
    severity: important
    requiredness: optional
    type: structured
    item_schema:
      - field: name
        type: string
      - field: contact_address
        type: address
      - field: contact_email
        type: string
      - field: contact_phone
        type: string
    description: |
      Property manager, if separate from landlord. Often the customer
      themselves (in our acquire-a-Hausverwaltung model). Useful for
      automated correspondence routing later.

  # ─── UNIT IDENTIFICATION ───

  - id: unit_ref
    german_label: "Einheit"
    severity: critical
    requiredness: required
    type: enum_extensible
    enum_values: ["EG", "1.OG", "2.OG", "3.OG", "DG", "KG", "EG_links", "EG_rechts", "EG_mitte", "1.OG_links", "1.OG_rechts", "1.OG_mitte", "DG_links", "DG_rechts", "DG_mitte"]
    normalization_rule_ref: unit_ref_normalization
    verifier_refs:
      - enum_validity_extensible
    description: |
      Canonical unit identifier within the property. The form-template
      gotcha (Paul case) is handled by normalization_rule_ref. Extensible
      enum because some buildings have non-standard unit layouts.

  - id: unit_address
    german_label: "Anschrift der Mietsache"
    severity: critical
    requiredness: required
    type: address
    verifier_refs:
      - plz_validity  # the Kuru hallucination case
    description: |
      Full address of the unit. Strasse, Hausnummer, PLZ, Ort. PLZ is
      verifier-checked against German postal code database.

  - id: unit_size_qm
    german_label: "Wohn-/Nutzfläche (qm)"
    severity: important
    requiredness: optional
    type: number
    description: |
      Unit size in square meters. Important for Nebenkosten allocation
      (Umlageschlüssel: Wohnfläche). Often within ±5% tolerance vs.
      actual measurement; 10%+ deviation grounds for rent reduction.

  - id: unit_rooms_count
    german_label: "Zimmeranzahl"
    severity: nice_to_have
    requiredness: optional
    type: number
    description: |
      Room count. German convention: "Zimmer" excludes kitchen and
      bathroom but counts living rooms.

  - id: included_facilities
    german_label: "Mitvermietete Einrichtungen"
    severity: nice_to_have
    requiredness: optional
    type: string_array
    description: |
      Array of free-form descriptions of included items. Examples:
      "Einbauküche", "Kühlschrank", "Waschmaschine", "Garten".

  - id: garage_stellplatz
    german_label: "Garage / Stellplatz"
    severity: nice_to_have
    requiredness: optional
    type: structured
    item_schema:
      - field: included
        type: boolean
      - field: separate_rent
        type: money
        required: false

  - id: keller_dachboden
    german_label: "Keller / Dachboden"
    severity: nice_to_have
    requiredness: optional
    type: structured
    item_schema:
      - field: keller_included
        type: boolean
      - field: dachboden_included
        type: boolean

  # ─── DATES (lifecycle-critical) ───

  - id: mietbeginn
    german_label: "Mietbeginn"
    severity: critical
    requiredness: required
    type: date
    verifier_refs:
      - date_format
    description: |
      Effective date of the lease. Goes into the lifecycle envelope's
      effective_date. Drives valid_from on emitted Kaltmiete claim.

  - id: mietende_befristet
    german_label: "Mietende (befristet)"
    severity: important
    requiredness: conditional
    condition: "is_befristet == true"
    type: date
    verifier_refs:
      - date_format
    description: |
      Termination date for fixed-term leases. Per BGB §575, residential
      Befristung requires statutory grounds. Goes into lifecycle's
      expiry_date if present.

  - id: is_befristet
    german_label: "Befristet"
    severity: important
    requiredness: required
    type: boolean
    description: |
      True = fixed-term lease (Befristung). False = unbefristet
      (open-ended; default for residential).

  - id: signature_date
    german_label: "Unterzeichnungsdatum"
    severity: important
    requiredness: optional
    type: date
    verifier_refs:
      - date_format
    description: |
      When the contract was signed. May differ from mietbeginn.
      Goes into lifecycle's signed_date.

  # ─── RENT ESCALATION CLAUSES ───

  - id: has_staffelmiete
    german_label: "Staffelmiete"
    severity: important
    requiredness: required
    type: boolean
    description: |
      True if contract contains a Staffelmiete clause (BGB §557a).
      If true, staffelmiete_schedule is required.

  - id: staffelmiete_schedule
    german_label: "Staffelplan"
    severity: important
    requiredness: conditional
    condition: "has_staffelmiete == true"
    type: structured_array
    item_schema:
      - field: effective_date
        type: date
        required: true
      - field: kaltmiete
        type: money
        required: true
    description: |
      Array of (effective_date, kaltmiete) pairs for pre-agreed rent
      increases. Each entry pre-emits a future claim with valid_from
      matching effective_date (architecture §4.4 Mieterhöhung pattern,
      applied at extraction time for Staffelmiete).

  - id: has_indexmiete
    german_label: "Indexmiete"
    severity: important
    requiredness: required
    type: boolean
    description: |
      True if contract contains an Indexmiete clause (BGB §557b).
      Mutually exclusive with has_staffelmiete in most contracts;
      both true → human review required.

  - id: indexmiete_basis
    german_label: "Indexmiete-Basis"
    severity: important
    requiredness: conditional
    condition: "has_indexmiete == true"
    type: structured
    item_schema:
      - field: index_type
        type: enum
        enum_values: ["VPI_Deutschland", "VPI_Bundesland", "andere"]
        required: true
      - field: base_index_value
        type: number
        required: true
      - field: base_index_date
        type: date
        required: true
      - field: adjustment_formula
        type: string
        required: false
    description: |
      Index reference for index-linked rent. Usually VPI Deutschland
      (Verbraucherpreisindex Statistisches Bundesamt). Recomputation
      happens via separate downstream job (architecture §5.2 Indexmiete
      edge case).

  # ─── TERMINATION ───

  - id: kuendigungsfrist
    german_label: "Kündigungsfrist"
    severity: important
    requiredness: optional
    type: structured
    item_schema:
      - field: tenant_notice_months
        type: number
        required: true
      - field: landlord_notice_months_short_tenancy
        type: number
        required: false
        description: "Notice period for landlord, tenancy < 5 years"
      - field: landlord_notice_months_medium_tenancy
        type: number
        required: false
        description: "Notice period for landlord, tenancy 5-8 years"
      - field: landlord_notice_months_long_tenancy
        type: number
        required: false
        description: "Notice period for landlord, tenancy > 8 years"
    normalization_rule_ref: kuendigungsfrist_default
    description: |
      Termination notice periods. If absent for residential, BGB §573c
      defaults apply (3/3/6/9 months tenant/landlord-short/-medium/-long).
      Inferred defaults set absence_state="inferred".

  # ─── CLAUSES (extracted, not deeply analyzed at launch) ───

  - id: schoenheitsreparaturen_clause
    german_label: "Schönheitsreparaturen-Klausel"
    severity: nice_to_have
    requiredness: optional
    type: structured
    item_schema:
      - field: present
        type: boolean
      - field: clause_type
        type: enum
        enum_values: ["starre_fristen", "weiche_fristen", "endrenovierungspflicht", "individuell", "andere"]
        required: false
      - field: raw_text
        type: string
        required: false
    description: |
      Cosmetic repairs clause. BGH case law has invalidated many starre
      Fristen (rigid schedules) clauses; tenants increasingly successful
      at challenging these. Schema captures presence and type; legal
      validity assessment is out of v2 scope.

  - id: tierhaltung_clause
    german_label: "Tierhaltung"
    severity: nice_to_have
    requiredness: optional
    type: enum
    enum_values: ["erlaubt", "verboten", "genehmigungspflichtig", "nicht_geregelt"]
    description: |
      Pet-keeping clause. Increasingly relevant for tenant disputes.

  - id: untervermietung_clause
    german_label: "Untervermietung"
    severity: nice_to_have
    requiredness: optional
    type: enum
    enum_values: ["erlaubt", "verboten", "genehmigungspflichtig", "nicht_geregelt"]

  - id: konkurrenzschutz_clause
    german_label: "Konkurrenzschutz (Gewerbe)"
    severity: nice_to_have
    requiredness: conditional
    condition: "mietvertrag_typ == 'Gewerbe'"
    type: structured
    item_schema:
      - field: present
        type: boolean
      - field: scope_description
        type: string
        required: false
    description: |
      Non-compete clause for commercial leases. Landlord agrees not to
      rent neighboring units to direct competitors. Out of v2 launch
      deep handling.

  - id: wertsicherungsklausel_clause
    german_label: "Wertsicherungsklausel (Gewerbe)"
    severity: nice_to_have
    requiredness: conditional
    condition: "mietvertrag_typ == 'Gewerbe'"
    type: structured
    item_schema:
      - field: present
        type: boolean
      - field: index_reference
        type: string
        required: false
    description: |
      Commercial rent indexation clause. Distinct from residential
      Indexmiete (different statutory framework). Out of v2 launch
      deep handling.

  - id: optionsrecht_clause
    german_label: "Optionsrecht (Gewerbe)"
    severity: nice_to_have
    requiredness: conditional
    condition: "mietvertrag_typ == 'Gewerbe'"
    type: structured
    item_schema:
      - field: present
        type: boolean
      - field: option_terms
        type: string
        required: false
    description: |
      Lease renewal option clause. Common in commercial leases.

  # ─── DOCUMENT INTEGRITY ───

  - id: has_handwritten_amendments
    german_label: "Handschriftliche Änderungen"
    severity: important
    requiredness: required
    type: boolean
    description: |
      True if document contains handwritten amendments to printed text.
      Triggers confidence downgrade to medium for affected fields.

  - id: amendment_attachments_referenced
    german_label: "Anlagen / Nachträge im Dokument referenziert"
    severity: important
    requiredness: required
    type: string_array
    description: |
      List of references to Nachträge or Anlagen mentioned in the
      Mietvertrag text. Does NOT extract their content (Nachträge are
      separate documents). Used by triage to flag "expect a Nachtrag
      document for this lease".
```

## Field rationale (non-obvious choices)

**Why `mietvertrag_typ` is critical-severity:** the entire downstream verification logic differs between Wohnraum and Gewerbe. BGB §551 deposit cap only applies to Wohnraum. Indexmiete vs. Wertsicherungsklausel are different statutory frameworks. Misclassification causes verifier failures and wrong claim emissions. Categorization quality is upstream of everything else.

**Why `tenant_identity` is `structured_array`:** the Weber case (commercial lease for J.H. Weber Versicherungsmakler GmbH) and the WG case both produce multiple entries. Single-tenant assumption breaks. Joint-and-several liability (Gesamtschuldnerische Haftung) means missing a tenant is a legal-significance failure, not just incomplete extraction.

**Why `kaltmiete_vat_amount` exists for Gewerbe but is `nice_to_have`:** v2 launch doesn't deeply handle commercial lease economics. But the field is in the schema so when post-launch deep commercial work happens, extractions back to Weber's lease can be re-emitted with VAT data without schema migration.

**Why `staffelmiete_schedule` is `important` not `critical`:** none of the 5 reference cases have Staffelmiete. It's not load-bearing for launch. But when it appears, it pre-emits multiple future claims via the emitter (architecture §4.4 pattern). The handling is real even though the field is not critical for the v1 customer base.

**Why `included_facilities` is `nice_to_have`:** these are extracted opportunistically for triage richness, not for resolver use. No resolver needs to know about Einbauküche.

**Why `amendment_attachments_referenced` is `important` and `required`:** if a Mietvertrag mentions "Nachtrag 1 vom 01.06.2015," the system needs to know to expect that Nachtrag document and not silently drop it. This is the upstream half of the Weber bug — making sure the system is *aware* a Nachtrag should exist.

## Worked examples against KO132/HHS55

### Lena Everding (KO132 1.OG, residential, simple case)

```yaml
mietvertrag_typ: { value: "Wohnraum", absence_state: present, severity: critical }
kaltmiete: { normalized_value: 65000, currency: "EUR", raw_value: "650,00 EUR", absence_state: present, severity: critical }
unit_ref: { normalized_value: "1.OG", raw_value: "1. Obergeschoss", absence_state: present, severity: critical }
tenant_identity: [{ full_name: "Lena Everding", tenant_type: "natural_person" }]
landlord_identity: { full_name: "[Owner]", landlord_type: "natural_person" }
mietbeginn: "2025-04-01"
is_befristet: false
has_staffelmiete: false
has_indexmiete: false
amendment_attachments_referenced: []
```

Claim emitter produces: `kaltmiete = €650 valid_from 2025-04-01 valid_to null`. `rent_for_unit(KO132, "1.OG")` returns €650, single_active_claim.

### Saniye Kuru (KO132 DG, residential, with Mieterhöhung)

Mietvertrag (2019) extraction:
```yaml
mietvertrag_typ: "Wohnraum"
kaltmiete: { normalized_value: 44000, currency: "EUR", raw_value: "440,00 EUR" }
unit_ref: "DG"
tenant_identity: [{ full_name: "Saniye Kuru" }]
mietbeginn: "2019-11-01"
amendment_attachments_referenced: []  # no Nachtrag referenced in original doc
```

Mieterhöhung (separate document, processed separately):
```yaml
new_kaltmiete: { normalized_value: 47000, currency: "EUR", raw_value: "470,00 EUR" }
effective_date: "[date of increase]"
unit_ref: "DG"
```

Mieterhöhung emitter returns `EmissionResult(claims=[new_kaltmiete_claim], closure_intents=[close_previous_kaltmiete])`. After applier runs: `rent_for_unit(KO132, "DG")` returns €470 today, returns €440 if `as_of_date < effective_date`.

### Weber GmbH (HHS55 1.OG, commercial)

```yaml
mietvertrag_typ: "Gewerbe"  # critical-severity classification works
kaltmiete: { normalized_value: 100000, currency: "EUR" }  # net of VAT, post-Nachtrag value handled separately
kaltmiete_vat_amount: { normalized_value: 19000, currency: "EUR" }  # extracted opportunistically, nice_to_have
unit_ref: "1.OG"
tenant_identity: [{ full_name: "J.H. Weber Versicherungsmakler GmbH", tenant_type: "legal_entity" }]
mietbeginn: "2010-06-01"
wertsicherungsklausel_clause: { present: true, index_reference: "VPI Deutschland" }  # nice_to_have
amendment_attachments_referenced: ["1. Nachtrag zum Mietvertrag"]  # important — flags expectation
```

Launch slice: kaltmiete + unit_ref + tenant_identity + mietbeginn extracted as critical. Wertsicherungsklausel extracted as nice_to_have but not validated. The 1. Nachtrag is processed as a separate Mieterhöhung document and supersedes via the same claim layer pattern as Kuru.

### Hofmann (HHS55 DG, residential, with Eigentümerwechsel)

```yaml
mietvertrag_typ: "Wohnraum"
kaltmiete: 90000  # €900
unit_ref: "DG"
tenant_identity: [{ full_name: "Dr. Hellen Hofmann" }]
mietbeginn: "2021-05-15"
amendment_attachments_referenced: []
```

The November 2025 Eigentümerwechsel-Übergabeprotokoll is a SEPARATE document (next schema below) and emits an `owner` claim. It does NOT close Hofmann's `kaltmiete` claim because the Übergabeprotokoll emitter dispatches on `uebergabe_typ = "Eigentümerwechsel"` and that branch does not produce tenant-related closures. `rent_for_unit(HHS55, "DG")` continues to return €900.

---

# Doc type 2: Wohnungsübergabeprotokoll

## Domain knowledge front-matter

**File:** `domain_knowledge/wohnungsuebergabeprotokoll.md`

```yaml
---
doc_type: wohnungsuebergabeprotokoll
default_claim_kind: event  # CRITICAL: dispatches by uebergabe_typ
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §535
    description: General framework for lease handover
  - statute: BGB §548
    description: Limitation period for claims arising from condition at handover
  - statute: BGB §566
    description: "Kauf bricht nicht Miete" — sale does not break the lease;
                relevant for Eigentümerwechsel handovers
  - statute: BGB §577
    description: Tenant pre-emption rights on sale of let property
  - common_law: |
      No formal Übergabeprotokoll statute. Practitioner standard:
      documents condition of property at handover for evidence in
      subsequent disputes (deposit returns, repair obligations).
fields_governed:
  - uebergabe_typ
  - inspection_date
  - property_id_implicit
  - unit_ref
  - parties_present
  - meter_readings
  - condition_summary
  - damages_noted
  - keys_handed_over
  - signatures
normalization_rules:
  - id: meter_reading_normalization
    field: meter_readings.value
    description: |
      Always store as decimal number with units. "1234,56 kWh" →
      { value: 1234.56, unit: "kWh", raw_value: "1234,56 kWh" }.
      Common units: kWh (electricity), m³ (water/gas), MWh (district heating).
  - id: keys_count_normalization
    field: keys_handed_over.count
    description: |
      Integer count. Distinguish key types:
      "Wohnungsschlüssel", "Haustürschlüssel", "Briefkastenschlüssel",
      "Kellerschlüssel", "Garagenschlüssel". Each as separate entry
      with its own count.
gotchas:
  - id: eigentuemerwechsel_does_not_invalidate_tenants
    description: |
      An Übergabeprotokoll documenting an Eigentümerwechsel (ownership
      transfer) does NOT close tenant claims. The emitter dispatches on
      uebergabe_typ:
      - "Einzug" → tenant_active claim (no closures)
      - "Auszug" → tenant_active closure intents for the unit's tenant claims
      - "Eigentümerwechsel" → owner claim + closure intent for previous
        owner; NO tenant closures
      - "unklar" → no claims, force human review
      The Hofmann case (HHS55 DG) is the canonical failure: a November
      2025 Eigentümerwechsel-Übergabeprotokoll for the property must
      not invalidate Hofmann's tenancy.
    real_failure_reference: hofmann_unklar_eigentuemerwechsel_misread
  - id: identifying_uebergabe_typ
    description: |
      The document rarely says "Einzug" or "Auszug" explicitly. Detection:
      - Käufer/Verkäufer language, references to Kaufvertrag → Eigentümerwechsel
      - Mieter "übernimmt" or "zieht ein" → Einzug
      - Mieter "übergibt" or "zieht aus", deposit return discussion → Auszug
      - Mixed signals (e.g., "Verkauf" mentioned but tenant moves in
        same day) → "unklar", force human review
      - Tenant identity changes between successive Übergabeprotokolle
        for the same unit → tenant change, classify per direction
  - id: meter_readings_at_handover_are_evidence_not_claims
    description: |
      Meter readings on a Wohnungsübergabeprotokoll document the state
      AT the inspection moment. They emit snapshot-kind claims with
      claim_kind="snapshot" (architecture §4.5 Type B). Resolvers query
      these snapshots with semantics like "what was the meter reading
      nearest to date X?" Snapshots do not have valid_to; they don't
      "expire," they get superseded by later readings.
  - id: parties_present_distinguishes_handover_type
    description: |
      Who's present can disambiguate uebergabe_typ:
      - Old owner + new owner + property manager → Eigentümerwechsel
      - Old tenant + new tenant + landlord/manager → tenant change
      - Single tenant + landlord/manager → Einzug or Auszug
      - Bank or notary present → Eigentümerwechsel via foreclosure
  - id: eigentuemerwechsel_bezugsfrei_does_not_auto_close_tenants
    description: |
      An Eigentümerwechsel-Übergabeprotokoll may contain language like
      "mietfrei," "geräumt," "bezugsfrei," or "ohne bestehende
      Mietverhältnisse." This MUST NOT trigger auto-closure of tenant
      claims. The German principle "Kauf bricht nicht Miete" (BGB §566)
      means ownership transfer does not end existing tenancies. If
      vacant-possession language is detected:
      - Emit owner claim + closure intent for previous owner (normal
        Eigentümerwechsel behavior, close_mode: close_overlapping_and_supersede_future)
      - Emit an `occupancy_conflict` event marker for human review
      - Do NOT emit any closure intent for tenant predicates
      Only an actual Kündigung or Auszug-Übergabeprotokoll can close
      tenant claims. The vacant-possession claim in the Eigentümerwechsel
      document may be aspirational, contractual between buyer and seller,
      or factually wrong — but it has no power to terminate tenancies
      under German law. The system surfaces the conflict; human decides.
    behavior:
      detect_terms: ["mietfrei", "bezugsfrei", "geräumt", "ohne bestehende Mietverhältnisse", "frei von Rechten Dritter"]
      emit_event: occupancy_conflict
      tenant_closures_emitted: false
adversarial_fixtures_required:
  - einzug_explicit
  - auszug_explicit
  - eigentuemerwechsel_kaufvertrag_referenced
  - eigentuemerwechsel_zwangsversteigerung
  - eigentuemerwechsel_bezugsfrei_with_active_tenant  # Hofmann-class fixture
  - ambiguous_unklar_mixed_signals
  - meter_readings_only_no_uebergabe_typ_clear
  - tenant_change_einzug_auszug_combined  # unusual but legal
closes:
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:{unit_ref}"
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: "inspection_date"
    match_requirements:
      tenant_identity_required: true
  - target_predicate: tenant_active
    target_subject_pattern: "unit:{unit_ref}"
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: "inspection_date"
    match_requirements:
      tenant_identity_required: true
  - target_predicate: nebenkostenvorauszahlung
    target_subject_pattern: "unit:{unit_ref}"
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: "inspection_date"
    match_requirements:
      tenant_identity_required: true
  - target_predicate: kaution
    target_subject_pattern: "unit:{unit_ref}"
    when: "uebergabe_typ == 'Auszug'"
    valid_to_source: "inspection_date"
    match_requirements:
      tenant_identity_required: true
  - target_predicate: owner
    target_subject_pattern: "property"
    when: "uebergabe_typ == 'Eigentümerwechsel'"
    valid_to_source: "inspection_date"
    match_requirements: {}
  # IMPORTANT: NO closure for tenant_active or kaltmiete when
  # uebergabe_typ == 'Eigentümerwechsel'. This is the Hofmann fix.
---

# Wohnungsübergabeprotokoll — domain knowledge

## What this doc type is

A handover protocol documenting condition of a unit at a transition
moment. Three transition types:
- Einzug: tenant moves in (tenancy starts)
- Auszug: tenant moves out (tenancy ends)
- Eigentümerwechsel: ownership transfers (tenancy continues unchanged)

## Why claim_kind dispatches per uebergabe_typ

Architecture §4.5 establishes the claim_kind taxonomy. Übergabeprotokoll
is the canonical example of a doc type whose meaning depends on a
single extracted enum. The emitter must dispatch correctly or the
Hofmann bug recurs. The classification is done at extraction time
(critical-severity field), not at emitter time.

## Why meter readings are snapshots, not assertions

Meter readings document state at a moment. They don't "extend over a
time range" the way a Mietvertrag's Kaltmiete does. Type B (snapshot)
in the architecture taxonomy. Resolvers handle them with point-in-time
semantics (last reading before date X), not active-validity semantics.

## Eigentümerwechsel-specific patterns

When ownership transfers, the new owner inherits the existing tenancies
unchanged ("Kauf bricht nicht Miete," BGB §566). The Übergabeprotokoll
documents physical condition + key handover between owners but does
NOT terminate or modify tenant relationships. This is structurally
why the closing matrix excludes tenant predicates for Eigentümerwechsel.
```

## Schema YAML

**File:** `schemas/wohnungsuebergabeprotokoll/schema.yaml`

```yaml
doc_type: wohnungsuebergabeprotokoll
schema_version: "2026-05-08-v1"
claim_kind: event  # default; emitter dispatches further on uebergabe_typ
domain_knowledge_ref: domain_knowledge/wohnungsuebergabeprotokoll.md
prompt_fragment_template: |
  Du extrahierst Felder aus einem deutschen Wohnungsübergabeprotokoll.
  Das Dokument dokumentiert eine von drei Übergabearten:
  - Einzug: Mieter zieht ein
  - Auszug: Mieter zieht aus
  - Eigentümerwechsel: Eigentum geht auf neuen Eigentümer über
  
  Hinweise zur Erkennung:
  - Käufer/Verkäufer-Sprache, Bezug auf Kaufvertrag → Eigentümerwechsel
  - Mieter "übernimmt"/"zieht ein" → Einzug
  - Mieter "übergibt"/"zieht aus", Kaution-Rückzahlung erwähnt → Auszug
  - Bei Unklarheit oder gemischten Signalen → "unklar"
  
  WICHTIG: Ein Eigentümerwechsel beendet KEINE Mietverhältnisse.
  Der bestehende Mieter bleibt. Verwechsle das nicht mit einem Mieterauszug.
  
  Zählerstände als snapshot-Werte mit Datum und Einheit erfassen.
  
  [field instructions inserted by generator]

fields:

  # ─── DISPATCH FIELD (drives emitter behavior) ───

  - id: uebergabe_typ
    german_label: "Übergabeart"
    severity: critical
    requiredness: required
    type: enum
    enum_values: ["Einzug", "Auszug", "Eigentümerwechsel", "unklar"]
    classification_hints: |
      Käufer/Verkäufer named, Kaufvertrag referenced, notary or bank
      present → Eigentümerwechsel. Single tenant + landlord, deposit
      mentioned → likely Auszug. Single tenant + landlord, lease
      reference, no deposit return → likely Einzug. Mixed/unclear →
      "unklar" forces human review.
    verifier_refs:
      - enum_validity
    description: |
      The single most important field on this doc type. Drives all
      emitter dispatch logic. The Hofmann bug was a misclassification
      of this field. Critical-severity, required, enum-validated.

  # ─── INSPECTION DATE (lifecycle-critical) ───

  - id: inspection_date
    german_label: "Datum der Übergabe"
    severity: critical
    requiredness: required
    type: date
    verifier_refs:
      - date_format
    description: |
      Date of the handover inspection. Goes into lifecycle's
      effective_date. For Type B/C events: this is also the snapshot
      observation date and the closure valid_to source.

  # ─── PROPERTY/UNIT IDENTIFICATION ───

  - id: unit_address
    german_label: "Anschrift der Wohnung"
    severity: critical
    requiredness: required
    type: address
    verifier_refs:
      - plz_validity

  - id: unit_ref
    german_label: "Einheit"
    severity: critical
    requiredness: required
    type: enum_extensible
    enum_values: ["EG", "1.OG", "2.OG", "3.OG", "DG", "KG", "EG_links", "EG_rechts", "EG_mitte", "1.OG_links", "1.OG_rechts", "1.OG_mitte", "DG_links", "DG_rechts", "DG_mitte", "GANZES_HAUS"]
    description: |
      Unit reference. "GANZES_HAUS" used for Eigentümerwechsel covering
      whole building (no specific unit). For tenant transitions, must
      be a specific unit.

  # ─── PARTIES PRESENT (helps disambiguate uebergabe_typ) ───

  - id: parties_present
    german_label: "Anwesende"
    severity: important
    requiredness: required
    type: structured_array
    item_schema:
      - field: name
        type: string
        required: true
      - field: role
        type: enum
        enum_values: ["mieter_alt", "mieter_neu", "vermieter", "hausverwaltung", "eigentuemer_alt", "eigentuemer_neu", "notar", "bank", "zeuge", "andere"]
        required: true
      - field: contact_info
        type: string
        required: false
    description: |
      Each person present at the handover with their role. Used by
      the dispatch logic to disambiguate uebergabe_typ if the explicit
      classification is unclear. Old owner + new owner present →
      Eigentümerwechsel. Old tenant + new tenant present → tenant
      change. Single tenant + landlord → Einzug or Auszug per other
      signals.

  # ─── EVENT-SPECIFIC IDENTITY FIELDS ───

  - id: tenant_identity_outgoing
    german_label: "Mieter (ausziehend)"
    severity: critical
    requiredness: conditional
    condition: "uebergabe_typ == 'Auszug'"
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
    description: |
      The tenant moving out. Required for Auszug because closure intents
      need tenant_identity match (closing matrix in front-matter).
      Without this, claim closures cannot match correctly.

  - id: tenant_identity_incoming
    german_label: "Mieter (einziehend)"
    severity: critical
    requiredness: conditional
    condition: "uebergabe_typ == 'Einzug'"
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
    description: |
      The tenant moving in. The Einzug emitter creates a tenant_active
      claim with this identity. Pairs with the corresponding Mietvertrag
      for the same unit (which provides Kaltmiete etc.).

  - id: owner_outgoing
    german_label: "Eigentümer (alt)"
    severity: critical
    requiredness: conditional
    condition: "uebergabe_typ == 'Eigentümerwechsel'"
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: entity_type
        type: enum
        enum_values: ["natural_person", "legal_entity", "wohnungseigentuemergemeinschaft", "gbr"]
        required: false

  - id: owner_incoming
    german_label: "Eigentümer (neu)"
    severity: critical
    requiredness: conditional
    condition: "uebergabe_typ == 'Eigentümerwechsel'"
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: entity_type
        type: enum
        enum_values: ["natural_person", "legal_entity", "wohnungseigentuemergemeinschaft", "gbr"]
        required: false

  - id: kaufvertrag_referenced
    german_label: "Kaufvertrag (Bezug)"
    severity: important
    requiredness: conditional
    condition: "uebergabe_typ == 'Eigentümerwechsel'"
    type: structured
    item_schema:
      - field: present
        type: boolean
      - field: kaufvertrag_date
        type: date
        required: false
      - field: notary_reference
        type: string
        required: false

  # ─── METER READINGS (snapshot-kind data) ───

  - id: meter_readings
    german_label: "Zählerstände"
    severity: important
    requiredness: optional
    type: structured_array
    item_schema:
      - field: meter_type
        type: enum
        enum_values: ["strom", "gas", "wasser_kalt", "wasser_warm", "fernwaerme", "heizoel", "andere"]
        required: true
      - field: meter_id
        type: string
        required: false
        description: "Zählernummer if visible"
      - field: value
        type: number
        required: true
      - field: unit
        type: enum
        enum_values: ["kWh", "MWh", "m3", "Liter", "andere"]
        required: true
      - field: raw_value
        type: string
        required: false
      - field: location_in_unit
        type: string
        required: false
        description: "Where in the unit (Keller, Küche, etc.)"
    normalization_rule_ref: meter_reading_normalization
    description: |
      Each meter reading is emitted as a separate snapshot-kind claim
      (architecture §4.5 Type B): valid_from = valid_to = inspection_date,
      claim_kind = "snapshot". A meter_reading_for_unit resolver (post-launch)
      queries these with point-in-time semantics ("nearest reading before
      date X"). Useful for utility billing reconciliation.

  # ─── CONDITION (mostly for evidence, not for current claims) ───

  - id: condition_summary
    german_label: "Zustand der Wohnung"
    severity: nice_to_have
    requiredness: optional
    type: enum
    enum_values: ["sehr_gut", "gut", "befriedigend", "mangelhaft", "frei_text"]
    description: |
      High-level condition assessment. Detailed damages go in damages_noted.

  - id: damages_noted
    german_label: "Mängel / Schäden"
    severity: nice_to_have
    requiredness: optional
    type: structured_array
    item_schema:
      - field: location
        type: string
        required: true
        description: "e.g., 'Küche', 'Bad', 'Wohnzimmer Wand links'"
      - field: description
        type: string
        required: true
      - field: severity
        type: enum
        enum_values: ["kosmetisch", "nutzungsbeeintraechtigend", "schwerwiegend"]
        required: false
      - field: photo_referenced
        type: boolean
        required: false
    description: |
      Free-form damages noted at handover. Important for deposit return
      disputes (BGB §548 limitation period). Currently not load-bearing
      in v2; useful for triage and audit.

  # ─── KEYS ───

  - id: keys_handed_over
    german_label: "Schlüsselübergabe"
    severity: important
    requiredness: optional
    type: structured_array
    item_schema:
      - field: key_type
        type: enum
        enum_values: ["wohnungsschluessel", "haustuerschluessel", "briefkastenschluessel", "kellerschluessel", "dachbodenschluessel", "garagenschluessel", "andere"]
        required: true
      - field: count
        type: number
        required: true
      - field: notes
        type: string
        required: false
    normalization_rule_ref: keys_count_normalization
    description: |
      Keys exchanged at handover. Important for deposit return disputes
      (missing keys = legitimate deduction). Currently not load-bearing;
      useful for audit.

  # ─── DEPOSIT (Auszug-specific) ───

  - id: kaution_settlement
    german_label: "Kautionsabrechnung"
    severity: important
    requiredness: conditional
    condition: "uebergabe_typ == 'Auszug'"
    type: structured
    item_schema:
      - field: kaution_returned_amount
        type: money
        required: false
      - field: kaution_withheld_amount
        type: money
        required: false
      - field: settlement_status
        type: enum
        enum_values: ["fully_returned", "partially_returned_with_deductions", "withheld_pending_dispute", "settled_at_handover", "deferred_to_later"]
        required: false
    description: |
      Deposit settlement at move-out. Often deferred (BGB §548 allows
      landlord to wait for utility settlement before final deposit return).
      Captured for triage and downstream resolver (post-launch).

  # ─── SIGNATURES ───

  - id: signatures
    german_label: "Unterschriften"
    severity: important
    requiredness: required
    type: structured_array
    item_schema:
      - field: signatory_name
        type: string
        required: true
      - field: signatory_role
        type: enum
        enum_values: ["mieter_alt", "mieter_neu", "vermieter", "hausverwaltung", "eigentuemer_alt", "eigentuemer_neu", "notar", "zeuge", "andere"]
        required: true
      - field: signed
        type: boolean
        required: true
      - field: signature_date
        type: date
        required: false
    description: |
      Whether each party present signed. Unsigned protocols have weaker
      evidentiary value. If critical parties haven't signed, set
      document_status="draft" or "unclear" in lifecycle envelope.

  # ─── DOCUMENT INTEGRITY ───

  - id: has_handwritten_amendments
    german_label: "Handschriftliche Ergänzungen"
    severity: important
    requiredness: required
    type: boolean
    description: |
      Übergabeprotokolle frequently have handwritten additions to printed
      forms. Triggers confidence downgrade for affected fields.

  - id: photo_attachments_referenced
    german_label: "Fotoanlagen"
    severity: nice_to_have
    requiredness: optional
    type: number
    description: |
      Count of photos referenced (not extracted). Useful triage signal —
      protocol with photo references gets paired with separate photo
      documents.
```

## Field rationale (non-obvious choices)

**Why `uebergabe_typ` is the only critical-AND-required field that's an enum:** the entire emitter dispatch hinges on it. Misclassification produces wrong claim emissions (Hofmann bug). The schema marks it specifically critical, requiredness=required, with enum verifier and explicit `unklar` value forcing human review. This is the most important field decision in the entire schema.

**Why `tenant_identity_outgoing` is conditional:critical:** for Auszug, the closure intents (4 separate predicates: kaltmiete, tenant_active, nebenkostenvorauszahlung, kaution) all require tenant_identity match. Without this field, the emitter can't safely close claims (might close another tenant's claims by mistake). For non-Auszug `uebergabe_typ`, the field is not_applicable.

**Why `meter_readings` is `important` not `critical`:** they're useful for utility reconciliation but no v2 launch resolver depends on them. Captured comprehensively so post-launch `meter_reading_for_unit` resolver doesn't need schema migration.

**Why `kaufvertrag_referenced` exists as a structured field:** Eigentümerwechsel can be voluntary (Kaufvertrag) or involuntary (Zwangsversteigerung, foreclosure). Different downstream handling. The presence/absence of Kaufvertrag is the easiest disambiguator.

**Why `signatures` is required:** unsigned Übergabeprotokolle are common — they get drafted, the parties forget to sign, the document goes into the file anyway. The pipeline must distinguish signed from unsigned to set `document_status` correctly. Unsigned = "draft", emitter returns no claims (architecture §4.4).

**Why no field for "previous tenant" on Einzug:** intentional. The Einzug-Übergabeprotokoll documents the new tenant's move-in. The previous tenant's Auszug is documented on a separate Übergabeprotokoll (or implied by their absence). The schema doesn't try to handle multi-event protocols; if a single document covers both Auszug and Einzug for the same unit, it goes to `uebergabe_typ = "unklar"` and forces human review.

## Worked examples against KO132/HHS55

### Hofmann's HHS55 Eigentümerwechsel (November 2025)

```yaml
uebergabe_typ: { value: "Eigentümerwechsel", absence_state: present, severity: critical }
inspection_date: "2025-11-XX"
unit_address: "Heinrich-Heine-Straße 55/55a, 34117 Kassel"
unit_ref: "GANZES_HAUS"  # Eigentümerwechsel covers whole property
parties_present:
  - { name: "Cornelia Bernhardt", role: "eigentuemer_alt" }
  - { name: "Denn Immobilienverwaltung eGbR", role: "eigentuemer_neu" }
  - { name: "[Notary]", role: "notar" }
owner_outgoing: { full_name: "Cornelia Bernhardt", entity_type: "natural_person" }
owner_incoming: { full_name: "Denn Immobilienverwaltung eGbR", entity_type: "gbr" }
kaufvertrag_referenced: { present: true, kaufvertrag_date: "2025-10-XX" }
meter_readings: [...]  # captured but not load-bearing
condition_summary: "gut"
signatures: [signed by both parties, notary witness]
```

Emitter dispatches: `uebergabe_typ == "Eigentümerwechsel"` → emits one event claim (`ownership_transferred`) AND one closure intent (close previous `owner` claim for the property). NO closures for tenant predicates. Hofmann's `kaltmiete` claim, `tenant_active` claim remain open. `rent_for_unit(HHS55, "DG")` continues returning €900.

### Hypothetical Auszug for KO132 EG (Paul moves out)

```yaml
uebergabe_typ: "Auszug"
inspection_date: "2027-XX-XX"  # hypothetical
unit_address: "Korbacher Straße 132, 34270 Schauenburg"
unit_ref: "EG"
parties_present:
  - { name: "Julija Paul", role: "mieter_alt" }
  - { name: "[Landlord]", role: "vermieter" }
tenant_identity_outgoing: { full_name: "Julija Paul" }
meter_readings: [strom: 12345 kWh, ...]
condition_summary: "gut"
damages_noted: [...]
keys_handed_over: [wohnungsschluessel: 2, briefkastenschluessel: 1]
kaution_settlement: { settlement_status: "deferred_to_later" }
signatures: [signed by both]
```

Emitter dispatches: `uebergabe_typ == "Auszug"` → emits one `lease_terminated` event claim AND four closure intents (kaltmiete, tenant_active, nebenkostenvorauszahlung, kaution for unit:EG, matched on tenant_identity = "Julija Paul"). After applier: `rent_for_unit(KO132, "EG")` returns null (no_active_claim) until a new Mietvertrag for EG is processed.

Meter readings emit four snapshot claims with `claim_kind = "snapshot"`, `valid_from = valid_to = inspection_date`. They're queryable by post-launch meter resolvers but don't affect rent_for_unit.

### Hypothetical Einzug for KO132 1.OG (Lena before her current Mietvertrag)

For completeness — if an Einzug-Übergabeprotokoll exists for Lena's start of tenancy on 2025-04-01:

```yaml
uebergabe_typ: "Einzug"
inspection_date: "2025-04-01"
unit_ref: "1.OG"
tenant_identity_incoming: { full_name: "Lena Everding" }
parties_present:
  - { name: "Lena Everding", role: "mieter_neu" }
  - { name: "[Landlord]", role: "vermieter" }
meter_readings: [...]
signatures: [signed]
```

Emitter dispatches: `uebergabe_typ == "Einzug"` → emits one `tenant_active` event claim (subject = "unit:1.OG", tenant_identity = "Lena Everding"). No closures (assuming no previous tenant; if there were a previous tenant, their `tenant_active` claim should have been closed by an earlier Auszug-Übergabeprotokoll).

This is the corroborating doc to Lena's Mietvertrag — independent confirmation she moved in. If Mietvertrag and Einzug-Übergabeprotokoll disagree on identity, that's a conflict surfaced via the resolver's confidence downgrade.

---

# Doc type 3: Mieterhöhung

This is the doc type that closes the Weber/Paul/Kuru bug class for rent increases. Smaller than Mietvertrag (the underlying lease already established the relationship; this document only modifies the rent), but architecturally important because it's the canonical case of an emitter that produces both a new claim and a closure intent.

**Scope:** v2's `mieterhoehung` doc_type covers ONLY documents that change Kaltmiete (or Bruttomiete equivalent). Three sub-types:

- **Einseitige Mieterhöhung** — unilateral landlord notice raising rent under BGB §558 (Vergleichsmiete) or §559 (Modernisierung)
- **Bilateral signed rent change** — typically a "Nachtrag zum Mietvertrag" that adjusts rent (both parties sign)
- **Indexmiete- or Staffelmiete-Anpassung** — adjustment notice implementing a pre-agreed index or schedule

All three produce the same claim shape: one new `kaltmiete` assertion claim + one `close_overlapping_only` closure intent for the previous Kaltmiete.

**Out of scope for this doc_type:** bilateral amendments that change non-rent terms (tenant identity, deposit, Tierhaltung, parking rights, etc.). Those go to the separate `mietvertragsnachtrag` doc_type (Doc type 4 below). Earlier drafts of v2 merged Mieterhöhung and generic Nachtrag into one doc_type; that produced silent data loss because non-rent Nachträge would emit no claims and no warning. The split surfaces every Nachtrag explicitly.

## Domain knowledge front-matter

**File:** `domain_knowledge/mieterhoehung.md`

```yaml
---
doc_type: mieterhoehung
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §557
    description: General rent increase framework
  - statute: BGB §558
    description: |
      Mieterhöhung bis zur ortsüblichen Vergleichsmiete (rent increase
      to local comparison rent). 15% cap over 3 years (Kappungsgrenze),
      reduced to 20% in some Bundesländer.
  - statute: BGB §559
    description: |
      Mieterhöhung nach Modernisierung. Up to 8% of modernization cost
      can be passed to tenant annually (cap from 2019 reform).
  - statute: BGB §557a
    description: Staffelmiete (handled at Mietvertrag schema, not here)
  - statute: BGB §557b
    description: Indexmiete (handled at Mietvertrag schema; this doc type
                represents the *adjustment notice* implementing the index)
fields_governed:
  - nachtrag_typ
  - rechtsgrundlage
  - new_kaltmiete
  - previous_kaltmiete
  - effective_date
  - notice_date
  - unit_ref
  - landlord_signature_present
  - tenant_signature_required
  - tenant_signature_present
  - kappungsgrenze_check_required
  - modernization_cost_basis
normalization_rules:
  - id: mieterhoehung_replaces_kaltmiete
    field: new_kaltmiete
    description: |
      The new_kaltmiete is what becomes the new active rent. The
      previous_kaltmiete is informational (helps verifiers, helps audit).
      Emitter behavior: emit one assertion claim with predicate=kaltmiete,
      value=new_kaltmiete, valid_from=effective_date. Emit one closure
      intent for the previous kaltmiete claim with valid_to=effective_date - 1 day.
  - id: rechtsgrundlage_normalization
    field: rechtsgrundlage
    description: |
      Map free-text references to canonical enum:
      "Vergleichsmiete", "ortsübliche Miete", "§558" → "vergleichsmiete_558"
      "Modernisierung", "§559" → "modernisierung_559"
      "Indexmiete", "Index", "VPI" → "indexmiete_557b"
      "Staffelmiete", "Staffelplan" → "staffelmiete_557a"
      Bilateral amendment without legal basis → "bilateral_einvernehmlich"
gotchas:
  - id: scope_narrowed_to_rent_change
    description: |
      As of v2, this doc_type covers only documents that change Kaltmiete
      (or Bruttomiete equivalent). Bilateral amendments that modify
      non-rent terms (tenant identity, deposit, Tierhaltung, parking,
      etc.) belong to the `mietvertragsnachtrag` doc_type. Misclassification
      between mieterhoehung and mietvertragsnachtrag produces wrong
      emitter dispatch:
      - A pet-clause Nachtrag misclassified as Mieterhöhung emits a
        spurious kaltmiete claim with no real rent change.
      - A rent-change Nachtrag misclassified as Mietvertragsnachtrag
        emits a `requires_review` reference claim instead of an
        authoritative kaltmiete claim.
      Classification must look at WHAT the document changes, not just
      whether it's labeled "Nachtrag" or "Mieterhöhung."
  - id: kappungsgrenze_15_percent
    description: |
      For BGB §558 increases (Vergleichsmiete), rent cannot rise more
      than 15% over 3 years (20% in some Bundesländer with restricted
      housing markets). If new_kaltmiete > previous_kaltmiete * 1.15
      AND rechtsgrundlage = "vergleichsmiete_558", verifier sets
      legal_validity_status = "potentially_invalid_requires_review".
      Does NOT block claim emission (document says what it says); does
      block automatic closure of the previous Kaltmiete (operationally
      unsafe). Surfaces in triage. Other rechtsgrundlage values
      (Modernisierung, Index, Staffelmiete) have different caps or none.
  - id: tenant_consent_requirement
    description: |
      For BGB §558 Mieterhöhung notices: tenant must provide consent
      (Zustimmung) within 2 months. Without consent, landlord must sue
      for it. Schema captures `tenant_signature_present` to flag whether
      consent is documented. NOT load-bearing at launch (the landlord's
      eventual rent is what we extract); useful for legal audit.
  - id: effective_date_vs_notice_date
    description: |
      Notice date (when the Mieterhöhung was sent) and effective date
      (when the new rent applies) differ. Per BGB §558, increase takes
      effect at the start of the third month after notice. The schema
      captures both because the effective_date drives the claim's
      valid_from, but notice_date matters for timeline auditing.
  - id: future_dated_increase_no_immediate_closure
    description: |
      If effective_date > today, the new claim is emitted with
      valid_from=effective_date but the previous Kaltmiete should NOT
      be closed yet. The closure intent's valid_to is effective_date - 1
      day; the applier closes when that date passes (or, with
      close_overlapping_only, the previous claim's valid_to is set to
      effective_date - 1 immediately, naturally creating the temporal
      handoff). Either way, current rent does not visibly change before
      effective_date.
  - id: staffelmiete_mid_schedule_amendment
    description: |
      If a Mieterhöhung arrives during an active Staffelmiete schedule
      (i.e., the unit has multiple open future-dated kaltmiete claims),
      the closure must NOT close all future Staffelmiete steps. A
      bilateral amendment can theoretically supersede the Staffelplan,
      but the system cannot know intent. Emitter behavior:
      - Detect open future-dated kaltmiete claims for the same unit
        (claim-aware check during emission)
      - Set blocker_status: "requires_review" on the closure intent
      - Surface in triage with the message "Mieterhöhung arrived during
        active Staffelmiete schedule. Remaining steps may be invalidated
        or may continue. Please review."
      - The new Mieterhöhung claim still inserts; the previous Kaltmiete
        is NOT auto-closed pending human decision
      The applier respects blocker_status and suspends closure application.
  - id: closure_prerequisites
    description: |
      Mieterhöhung emits a closure intent for the previous Kaltmiete
      ONLY when ALL of the following hold:
      - nachtrag_typ is "mieterhoehung_einseitig", "nachtrag_bilateral",
        "indexmiete_anpassung", or "staffelmiete_anpassung"
        (NOT "unklar")
      - new_kaltmiete is present (validation_status = "valid")
      - effective_date is present (validation_status = "valid")
      - unit_ref is normalized to a known unit (validation_status = "valid")
      - landlord_signature_present is true
      - document_status is not "draft" or "request_only"
      - No conditionality marker (Vorbehalt, falls, voraussichtlich) detected
      - tenant_identity matches an active claim (or unit_ref alone
        uniquely identifies the active lease)
      - legal_validity_status is not "potentially_invalid_requires_review"
        or "formal_prerequisites_missing"
      - No open future-dated Staffelmiete claims for the same unit
        (claim-aware check)
      Otherwise: emit the new claim, mark closure intent
      blocker_status: "requires_review", surface in triage. The
      previous Kaltmiete remains open until human review.
adversarial_fixtures_required:
  - mieterhoehung_558_vergleichsmiete
  - mieterhoehung_559_modernisierung
  - mieterhoehung_indexmiete_adjustment
  - nachtrag_bilateral_rent_change
  - mieterhoehung_exceeds_kappungsgrenze  # potentially_invalid_requires_review
  - mieterhoehung_tenant_did_not_consent  # captured but doesn't block
  - mieterhoehung_future_dated_not_yet_effective
  - mieterhoehung_during_active_staffelmiete  # blocker_status fixture
  - mieterhoehung_request_only_no_consent_documented  # blocked closure
  - non_rent_nachtrag_misclassified_as_mieterhoehung  # routing accuracy
closes:
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_only
    when: |
      nachtrag_typ in [mieterhoehung_einseitig, nachtrag_bilateral, indexmiete_anpassung, staffelmiete_anpassung]
      AND new_kaltmiete.validation_status == "valid"
      AND effective_date.validation_status == "valid"
      AND unit_ref.validation_status == "valid"
      AND landlord_signature_present == true
      AND document_status not in [draft, request_only]
      AND legal_validity_status not in [potentially_invalid_requires_review, formal_prerequisites_missing]
    valid_to_source: "effective_date - 1 day"
    match_requirements:
      unit_ref_required: true
      tenant_identity_optional: true
    blocker_check:
      - condition: "open_future_dated_kaltmiete_claims_exist_for_unit"
        action: "set blocker_status to requires_review (Staffelmiete conflict)"
  # close_overlapping_only is correct: a rent increase supersedes the
  # CURRENT step. Future Staffelmiete steps (if any) are handled via the
  # blocker_check and require human review. This explicitly does NOT
  # close future-dated kaltmiete claims unconditionally.
---

# Mieterhöhung — domain knowledge

## What this doc type is

The document that supersedes a Mietvertrag's rent. Three out of five
tenants in the reference corpus (Paul, Kuru, Weber) have one. This is
not an edge case — it's the default pattern in German residential
leasing. Rents rise via Mieterhöhungen; the underlying Mietvertrag
keeps its original signed value forever.

## Why mieterhoehung is split from mietvertragsnachtrag

A Nachtrag is a generic amendment container. It can modify Kaltmiete,
Nebenkostenvorauszahlung, Mietbeginn/Mietende, Kaution payment schedule,
parties, unit scope, pets, garden/cellar/parking rights, commercial-use
clauses, termination terms, index/staffel clauses — almost anything in
the underlying Mietvertrag.

Earlier v2 drafts merged Mieterhöhung and generic Nachtrag into one
doc_type, with a `nachtrag_typ` field distinguishing rent vs. non-rent
changes. The merge looked clean but produced silent data loss: a
non-rent Nachtrag would route to the merged emitter, find no rent
change to emit, and silently produce no claims and no warning. The
operator wouldn't know the document had been processed-but-ignored.

The split is the right call. `mieterhoehung` covers documents that
change Kaltmiete (regardless of legal pathway — unilateral notice,
bilateral amendment, index adjustment, all produce the same claim
shape). `mietvertragsnachtrag` covers bilateral amendments that change
anything else, with a `nachtrag_scope` enum that explicitly tracks WHAT
changed. For v2 launch, only the `rent_change` scope of
`mietvertragsnachtrag` emits claims (delegating to mieterhoehung's
logic). Other scopes emit reference-kind claims with
`status: unsupported_requires_review` and surface in triage.

This is a deliberate cost: more schema work, a classification accuracy
risk between the two doc_types, more emitter logic. The cost is paid
once at design time. The alternative cost — silent data loss on every
non-rent Nachtrag forever — was unacceptable.

## What about Modernisierungs-Mieterhöhung (BGB §559)?

Modernisierung increases have different math (8% of modernization cost
spread annually) but produce the same claim shape. Schema captures
`modernization_cost_basis` for audit but doesn't compute the increase
itself — that's the document's stated new_kaltmiete.
```

## Schema YAML

**File:** `schemas/mieterhoehung/schema.yaml`

```yaml
doc_type: mieterhoehung
schema_version: "2026-05-08-v1"
claim_kind: assertion
domain_knowledge_ref: domain_knowledge/mieterhoehung.md
prompt_fragment_template: |
  Du extrahierst Felder aus einem deutschen Mieterhöhungsschreiben oder
  Mietvertragsnachtrag. Beide modifizieren einen bestehenden Mietvertrag.
  
  Erkenne den Typ:
  - Einseitiges Schreiben des Vermieters mit Begründung (Vergleichsmiete,
    Modernisierung, Indexmiete) → "mieterhoehung_einseitig"
  - Beidseitig unterzeichnete Vereinbarung → "nachtrag_bilateral"
  - Indexmiete-Anpassungsmitteilung → "indexmiete_anpassung"
  
  Beachte: previous_kaltmiete ist die alte Miete, new_kaltmiete ist die
  neue. effective_date ist der Tag, ab dem die neue Miete gilt.
  
  [field instructions inserted by generator]

fields:

  # ─── DOCUMENT CLASSIFICATION ───

  - id: nachtrag_typ
    german_label: "Art der Anpassung"
    severity: critical
    requiredness: required
    type: enum
    enum_values: ["mieterhoehung_einseitig", "nachtrag_bilateral", "indexmiete_anpassung", "staffelmiete_anpassung", "unklar"]
    classification_hints: |
      Single signature (landlord only) + Begründung referencing BGB §558
      → mieterhoehung_einseitig.
      Both parties signed + free-form modification → nachtrag_bilateral.
      Reference to VPI / Index basis → indexmiete_anpassung.
      Reference to pre-agreed Staffelplan → staffelmiete_anpassung.
      Unclear → "unklar" forces human review.
    verifier_refs:
      - enum_validity

  - id: rechtsgrundlage
    german_label: "Rechtsgrundlage"
    severity: important
    requiredness: required
    type: enum
    enum_values: ["vergleichsmiete_558", "modernisierung_559", "indexmiete_557b", "staffelmiete_557a", "bilateral_einvernehmlich", "andere", "unklar"]
    normalization_rule_ref: rechtsgrundlage_normalization

  # ─── RENT CHANGE (the load-bearing fields) ───

  - id: new_kaltmiete
    german_label: "Neue Kaltmiete"
    severity: critical
    requiredness: required
    type: money
    verifier_refs:
      - monetary_verbatim
    description: |
      The new Kaltmiete amount. Becomes the value on the emitted
      assertion claim. Replaces the previous Kaltmiete claim via
      closure intent.

  - id: previous_kaltmiete
    german_label: "Bisherige Kaltmiete"
    severity: important
    requiredness: optional
    type: money
    verifier_refs:
      - monetary_verbatim
      - kappungsgrenze_check  # if rechtsgrundlage = vergleichsmiete_558
    description: |
      The previous Kaltmiete amount, if stated in the document.
      Important for verifier checks (Kappungsgrenze) but not strictly
      required for claim emission — the closure intent matches by
      (predicate, subject) on the most recent open claim.

  - id: effective_date
    german_label: "Wirksamkeitsdatum"
    severity: critical
    requiredness: required
    type: date
    verifier_refs:
      - date_format
    description: |
      Date on which the new Kaltmiete takes effect. Drives valid_from
      on the new claim and valid_to on the closure intent.

  - id: notice_date
    german_label: "Datum der Mitteilung"
    severity: important
    requiredness: optional
    type: date
    verifier_refs:
      - date_format
    description: |
      Date the notice was sent (BGB §558: tenant has 2 months to
      consent; increase takes effect at start of third month thereafter).
      Useful for timeline audit, not load-bearing for claim emission.

  # ─── UNIT / TENANT IDENTIFICATION ───

  - id: unit_ref
    german_label: "Einheit"
    severity: critical
    requiredness: required
    type: enum_extensible
    enum_values: ["EG", "1.OG", "2.OG", "3.OG", "DG", "KG", "EG_links", "EG_rechts", "EG_mitte", "1.OG_links", "1.OG_rechts", "1.OG_mitte", "DG_links", "DG_rechts", "DG_mitte"]
    normalization_rule_ref: unit_ref_normalization

  - id: tenant_identity
    german_label: "Mieter"
    severity: important
    requiredness: optional
    type: structured_array
    item_schema:
      - field: full_name
        type: string
        required: true
    description: |
      Tenants addressed by the Mieterhöhung. Optional because unit_ref
      alone usually suffices to match the previous claim, but capturing
      tenant_identity strengthens the match.

  - id: original_mietvertrag_referenced
    german_label: "Bezug auf ursprünglichen Mietvertrag"
    severity: nice_to_have
    requiredness: optional
    type: structured
    item_schema:
      - field: mietvertrag_date
        type: date
        required: false

  # ─── §558 SPECIFICS (Vergleichsmiete) ───

  - id: vergleichsmiete_basis
    german_label: "Begründung der Vergleichsmiete"
    severity: nice_to_have
    requiredness: conditional
    condition: "rechtsgrundlage == 'vergleichsmiete_558'"
    type: structured
    item_schema:
      - field: basis_type
        type: enum
        enum_values: ["mietspiegel", "drei_vergleichswohnungen", "sachverstaendigengutachten", "andere"]
        required: false
      - field: mietspiegel_reference
        type: string
        required: false

  # ─── §559 SPECIFICS (Modernisierung) ───

  - id: modernization_cost_basis
    german_label: "Modernisierungskosten-Basis"
    severity: nice_to_have
    requiredness: conditional
    condition: "rechtsgrundlage == 'modernisierung_559'"
    type: structured
    item_schema:
      - field: total_modernization_cost
        type: money
        required: false
      - field: cost_per_qm_annual
        type: money
        required: false
      - field: modernization_description
        type: string
        required: false

  # ─── INDEX-SPECIFIC (Indexmiete adjustment) ───

  - id: index_adjustment_basis
    german_label: "Index-Anpassungsbasis"
    severity: important
    requiredness: conditional
    condition: "rechtsgrundlage == 'indexmiete_557b'"
    type: structured
    item_schema:
      - field: index_value_old
        type: number
        required: false
      - field: index_value_new
        type: number
        required: false
      - field: index_date_old
        type: date
        required: false
      - field: index_date_new
        type: date
        required: false

  # ─── SIGNATURES (drives nachtrag_typ classification) ───

  - id: landlord_signature_present
    german_label: "Vermieter-Unterschrift vorhanden"
    severity: important
    requiredness: required
    type: boolean
    description: |
      Required for the document to have any legal effect.

  - id: tenant_signature_present
    german_label: "Mieter-Unterschrift vorhanden"
    severity: important
    requiredness: required
    type: boolean
    description: |
      Distinguishes nachtrag_bilateral (true) from mieterhoehung_einseitig
      (false). Also relevant for §558 Zustimmungserfordernis (consent).

  - id: tenant_consent_documented
    german_label: "Zustimmung des Mieters dokumentiert"
    severity: nice_to_have
    requiredness: optional
    type: enum
    enum_values: ["zugestimmt", "abgelehnt", "keine_reaktion_dokumentiert", "nicht_anwendbar"]

  # ─── DOCUMENT INTEGRITY ───

  - id: has_handwritten_amendments
    german_label: "Handschriftliche Ergänzungen"
    severity: important
    requiredness: required
    type: boolean

  - id: signature_date
    german_label: "Unterzeichnungsdatum"
    severity: important
    requiredness: optional
    type: date
    verifier_refs:
      - date_format
```

## Field rationale

**Why one doc_type for Mieterhöhung + Nachtrag:** the architecture cares about claim shape, not legal pathway. Both produce one new claim + one closure. Splitting them adds complexity for no architectural benefit. The `nachtrag_typ` field preserves the distinction for future legal-validity verifiers.

**Why `previous_kaltmiete` is `important` not `critical`:** the closure intent matches the previous claim by `(predicate, subject)`, taking the most recent open one. The previous_kaltmiete value is informational — useful for verifying the Kappungsgrenze, but not strictly required for the closure to work.

**Why no fields for the actual modernization scope:** out of v2 scope. Capturing modernization details deeply would require its own schema (Modernisierungsankündigung is technically a separate document type that precedes the Mieterhöhung). v2 captures enough to recognize the basis; deep modernization tracking is post-launch.

**Why `tenant_consent_documented` is `nice_to_have`:** legal validity assessment is out of v2 scope. The system extracts what's documented; it doesn't enforce or validate the legal procedure.

## Worked example

### Saniye Kuru's Mieterhöhung (€440 → €470)

```yaml
nachtrag_typ: "mieterhoehung_einseitig"
rechtsgrundlage: "vergleichsmiete_558"
new_kaltmiete: { normalized_value: 47000, currency: "EUR", raw_value: "470,00 EUR" }
previous_kaltmiete: { normalized_value: 44000, currency: "EUR", raw_value: "440,00 EUR" }
effective_date: "[date of increase]"
notice_date: "[date - 3 months prior]"
unit_ref: "DG"
tenant_identity: [{ full_name: "Saniye Kuru" }]
landlord_signature_present: true
tenant_signature_present: false  # einseitig
vergleichsmiete_basis: { basis_type: "mietspiegel" }
```

Verifier check: Kappungsgrenze. €470 / €440 = 6.8% increase. Within 15% cap. No flag.

Emitter produces:
```yaml
EmissionResult:
  claims_to_insert:
    - Claim(
        claim_kind: "assertion",
        subject: "unit:DG",
        predicate: "kaltmiete",
        value: 47000,
        valid_from: <effective_date>,
        valid_to: null,
        source_type: "document_extraction"
      )
  closure_intents:
    - ClaimClosure(
        target_predicate: "kaltmiete",
        target_subject: "unit:DG",
        target_property_id: <KO132>,
        valid_to: <effective_date - 1 day>,
        reason_claim_id: <new claim ID>,
        match_requirements: { tenant_identity_optional: "Saniye Kuru" }
      )
```

After applier runs: `rent_for_unit(KO132, "DG")` returns €470 with `single_active_claim`. `rent_for_unit(KO132, "DG", as_of=2020-01-01)` returns €440 (historical query).

Same pattern handles the Paul case (€525 → €575) and the Weber case (€900 → €1,000 via 1. Nachtrag, where `nachtrag_typ = "nachtrag_bilateral"` instead of `mieterhoehung_einseitig`).

---

# Doc type 4: Mietvertragsnachtrag

This doc_type covers bilateral amendments that change anything OTHER than rent. It exists because lumping all Nachträge into the `mieterhoehung` doc_type produces silent data loss for non-rent amendments. By splitting it out, every Nachtrag is captured explicitly and surfaces in triage even when the system doesn't yet know how to extract its full content.

## Why this doc_type exists

A Nachtrag may modify:
- Tenant identity (one tenant moves out, another moves in, lease continues)
- Deposit (Kaution) amount or payment plan
- Nebenkosten allocation or amount
- Mietbeginn / Mietende (term extension or shortening)
- Usage rights (parking, cellar, garden, pets)
- Commercial-use clauses
- Termination terms (Kündigungsfrist modification)
- Index or Staffelmiete clauses (adding or modifying)
- Schönheitsreparaturen / repair obligations

For v2 launch, only `rent_change` scope produces claims (delegating to mieterhoehung's logic). All other scopes are captured but produce reference-kind claims with `status: unsupported_requires_review`. The document is acknowledged in triage; the operator decides what to do with it.

This avoids the failure mode where a tenant-identity-change Nachtrag silently disappears into the system, leaving the resolver still showing the previous tenant as active.

## Domain knowledge front-matter

**File:** `domain_knowledge/mietvertragsnachtrag.md`

```yaml
---
doc_type: mietvertragsnachtrag
default_claim_kind: reference  # most scopes; rent_change uses assertion via delegation
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §305 ff
    description: |
      AGB-Recht. Standard form contracts (and amendments) face stricter
      validity requirements than individually negotiated contracts.
  - statute: BGB §550
    description: |
      Schriftformerfordernis bei Mietverträgen über ein Jahr. Amendments
      modifying material terms of long-term leases must also be in
      writing or risk converting the lease to indefinite term.
  - statute: BGB §540
    description: |
      Untervermietung. Amendments granting subletting rights touch this.
fields_governed:
  - nachtrag_scope
  - signing_parties
  - effective_date
  - signature_date
  - landlord_signature_present
  - tenant_signature_present
  - amendment_subject_text
  - rent_change_payload
  - tenant_identity_change_payload
  - deposit_change_payload
  - other_change_descriptor
normalization_rules:
  - id: scope_dispatch_to_payload
    field: nachtrag_scope
    description: |
      Each scope value selects which payload field is required:
      rent_change → rent_change_payload
      tenant_identity_change → tenant_identity_change_payload
      deposit_change → deposit_change_payload
      ancillary_cost_change → ancillary_cost_change_payload
      term_change → term_change_payload (extends or shortens lease)
      usage_right_change → usage_right_change_payload
      other → other_change_descriptor (free text)
      unclear → no payload required; force review
gotchas:
  - id: scope_classification_accuracy_critical
    description: |
      The `nachtrag_scope` field drives emitter dispatch. Misclassification
      causes wrong behavior:
      - rent_change misclassified as other → no kaltmiete claim emitted,
        silent loss of rent update
      - other misclassified as rent_change → spurious kaltmiete claim
        with no real rent change
      The classifier (Step 4) and the Mietvertragsnachtrag emitter both
      need fixtures that test scope determination explicitly. The
      adversarial fixture set must include at least one example per
      scope value, plus boundary cases (e.g., a Nachtrag that changes
      both rent AND deposit — which scope wins?).
  - id: multi_scope_documents
    description: |
      A single Nachtrag may modify multiple things (rent + deposit +
      tenant identity in one document). v2 schema treats nachtrag_scope
      as primary scope, with other_changes_present: true flag. Operator
      review handles the multi-scope cases. Future extension: array of
      scopes with per-scope payloads.
  - id: rent_change_delegates_to_mieterhoehung
    description: |
      When nachtrag_scope == "rent_change", the emitter delegates to
      mieterhoehung's logic: emits one kaltmiete assertion claim, one
      close_overlapping_only closure intent for the previous Kaltmiete.
      The same prerequisite-gating applies (signature, effective_date,
      unit_ref, no Staffelmiete conflict, etc.). The mieterhoehung
      schema's `closes` matrix is reused — this is intentional, not
      duplication.
  - id: non_rent_scopes_emit_reference_claims_only
    description: |
      For non-rent scopes, the emitter produces:
      - One reference-kind claim with predicate=document_present,
        subject=lease_id (or unit_ref if lease_id unavailable),
        status=unsupported_requires_review
      - No closure intents
      - The document still appears in triage with full extracted fields
        for human review
      The operator can then create human-adjudication claims if the
      Nachtrag's effects need to be reflected in resolved facts.
  - id: misclassified_as_mieterhoehung
    description: |
      A pet-clause Nachtrag (or any non-rent Nachtrag) misclassified at
      Step 4 as "mieterhoehung" would route to the wrong emitter and
      potentially produce a spurious kaltmiete claim. Defense:
      - Step 4 prompt includes explicit guidance to classify based on
        WHAT changes, not document title
      - Mieterhöhung emitter rejects extractions where new_kaltmiete is
        absent or equal to previous_kaltmiete (no real rent change)
      - Adversarial fixture: Nachtrag titled "Nachtrag zum Mietvertrag
        - Tierhaltung" must classify as mietvertragsnachtrag with
        nachtrag_scope=usage_right_change, NOT as mieterhoehung
adversarial_fixtures_required:
  - nachtrag_rent_change_delegates_correctly
  - nachtrag_tenant_identity_change_one_tenant_replaced
  - nachtrag_deposit_payment_plan
  - nachtrag_pet_clause_added
  - nachtrag_parking_right_added
  - nachtrag_term_extension
  - nachtrag_multi_scope_rent_and_deposit
  - nachtrag_misclassified_as_mieterhoehung_at_step4  # routing accuracy
  - nachtrag_unclear_scope_forces_review
closes:
  # Only the rent_change scope produces a closure, delegated to
  # mieterhoehung's closing rule. All other scopes produce no closure.
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_only
    when: |
      nachtrag_scope == "rent_change"
      AND rent_change_payload.new_kaltmiete.validation_status == "valid"
      AND effective_date.validation_status == "valid"
      AND unit_ref.validation_status == "valid"
      AND landlord_signature_present == true
      AND tenant_signature_present == true
      AND legal_validity_status not in [potentially_invalid_requires_review, formal_prerequisites_missing]
    valid_to_source: "effective_date - 1 day"
    match_requirements:
      unit_ref_required: true
      tenant_identity_optional: true
    blocker_check:
      - condition: "open_future_dated_kaltmiete_claims_exist_for_unit"
        action: "set blocker_status to requires_review (Staffelmiete conflict)"
---
```

## Schema YAML

**File:** `schemas/mietvertragsnachtrag/schema.yaml`

```yaml
doc_type: mietvertragsnachtrag
schema_version: "2026-05-08-v1"
claim_kind: reference  # default; rent_change scope produces assertion via delegation
domain_knowledge_ref: domain_knowledge/mietvertragsnachtrag.md
prompt_fragment_template: |
  Du extrahierst Felder aus einem Mietvertragsnachtrag (bilaterale
  Vertragsänderung).

  WICHTIG: Bestimme zuerst, WAS geändert wird. Das ist der
  nachtrag_scope:
  - rent_change: Kaltmiete oder Bruttomiete wird geändert
  - tenant_identity_change: Mieter wird ausgetauscht/ergänzt
  - deposit_change: Kaution geändert (Höhe oder Zahlungsplan)
  - ancillary_cost_change: Nebenkostenvorauszahlung geändert
  - term_change: Mietdauer geändert (Verlängerung oder Verkürzung)
  - usage_right_change: Nutzungsrechte (Tierhaltung, Stellplatz, Garten)
  - other: andere Änderung
  - unclear: nicht eindeutig bestimmbar

  Wenn mehrere Bereiche geändert werden, wähle den primären und setze
  other_changes_present=true.

  Achte besonders auf den Unterschied zu einer Mieterhöhung: eine
  Mieterhöhung ändert ausschließlich die Miete. Ein Nachtrag kann
  alles ändern. Ein Nachtrag, der ausschließlich die Miete ändert,
  bekommt nachtrag_scope=rent_change.

  [field instructions inserted by generator]

fields:

  # ─── PRIMARY DISPATCH FIELD ───

  - id: nachtrag_scope
    german_label: "Art der Änderung"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: enum
    enum_values:
      - "rent_change"
      - "tenant_identity_change"
      - "deposit_change"
      - "ancillary_cost_change"
      - "term_change"
      - "usage_right_change"
      - "other"
      - "unclear"
    classification_hints: |
      Read the document for what is being modified, not the title.
      Many Nachträge are titled generically ("Nachtrag zum Mietvertrag")
      but modify a specific thing. The body text reveals the scope.
      If multiple scopes apply, pick the primary one and set
      other_changes_present=true.
    verifier_refs:
      - enum_validity

  - id: other_changes_present
    german_label: "Weitere Änderungen vorhanden"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: required
    type: boolean
    description: |
      True if the Nachtrag modifies multiple things (e.g., rent AND
      deposit). Triggers human review even when primary scope is handled.

  # ─── COMMON METADATA ───

  - id: signing_parties
    german_label: "Unterzeichner"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: structured_array
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: role
        type: enum
        enum_values: ["mieter", "vermieter", "hausverwaltung", "andere"]
        required: true

  - id: landlord_signature_present
    german_label: "Vermieter-Unterschrift vorhanden"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: boolean

  - id: tenant_signature_present
    german_label: "Mieter-Unterschrift vorhanden"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: boolean
    description: |
      A bilateral Nachtrag without tenant signature is structurally
      defective. Forces human review.

  - id: signature_date
    german_label: "Unterzeichnungsdatum"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: required
    type: date
    verifier_refs:
      - date_format

  - id: effective_date
    german_label: "Wirksamkeitsdatum"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: date
    verifier_refs:
      - date_format

  - id: unit_ref
    german_label: "Einheit"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: required
    type: enum_extensible
    enum_values: ["EG", "1.OG", "2.OG", "3.OG", "DG", "KG", "EG_links", "EG_rechts", "EG_mitte", "1.OG_links", "1.OG_rechts", "1.OG_mitte", "DG_links", "DG_rechts", "DG_mitte"]
    normalization_rule_ref: unit_ref_normalization

  - id: original_mietvertrag_referenced
    german_label: "Bezug auf ursprünglichen Mietvertrag"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: required
    type: structured
    item_schema:
      - field: mietvertrag_date
        type: date
        required: true
      - field: mietvertrag_reference_id
        type: string
        required: false

  # ─── SCOPE-SPECIFIC PAYLOADS (one per scope, conditional) ───

  - id: rent_change_payload
    german_label: "Mietänderungs-Details"
    severity: critical
    used_in_resolvers: true
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'rent_change'"
    type: structured
    item_schema:
      - field: new_kaltmiete
        type: money
        required: true
      - field: previous_kaltmiete
        type: money
        required: false
      - field: rent_structure_basis
        type: enum
        enum_values: ["kaltmiete", "bruttomiete", "inklusivmiete", "pauschalmiete"]
        required: true
    description: |
      When this payload is present, the emitter delegates to the
      mieterhoehung emitter logic to produce a kaltmiete assertion claim.

  - id: tenant_identity_change_payload
    german_label: "Mieter-Änderungs-Details"
    severity: critical
    used_in_resolvers: false  # v2 launch: not yet load-bearing
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'tenant_identity_change'"
    type: structured
    item_schema:
      - field: tenants_added
        type: structured_array
        required: false
      - field: tenants_removed
        type: structured_array
        required: false
      - field: tenants_continuing
        type: structured_array
        required: false
    description: |
      Captured for triage review. v2 does not auto-emit tenant_active
      claim updates — operator reviews and creates human-adjudication
      claims if appropriate.

  - id: deposit_change_payload
    german_label: "Kautionsänderungs-Details"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'deposit_change'"
    type: structured
    item_schema:
      - field: new_deposit_amount
        type: money
        required: false
      - field: payment_plan_text
        type: string
        required: false

  - id: ancillary_cost_change_payload
    german_label: "Nebenkostenänderungs-Details"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'ancillary_cost_change'"
    type: structured
    item_schema:
      - field: new_nebenkosten_vorauszahlung
        type: money
        required: false
      - field: change_reason
        type: string
        required: false

  - id: term_change_payload
    german_label: "Vertragslaufzeit-Änderungs-Details"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'term_change'"
    type: structured
    item_schema:
      - field: new_mietende
        type: date
        required: false
      - field: term_extension_period
        type: string
        required: false

  - id: usage_right_change_payload
    german_label: "Nutzungsrecht-Änderungs-Details"
    severity: nice_to_have
    used_in_resolvers: false
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'usage_right_change'"
    type: structured
    item_schema:
      - field: change_type
        type: enum
        enum_values: ["pet_added", "pet_removed", "parking_added", "parking_removed", "garden_added", "garden_removed", "cellar_added", "cellar_removed", "other"]
        required: false
      - field: change_text
        type: string
        required: false

  - id: other_change_descriptor
    german_label: "Sonstige Änderung"
    severity: nice_to_have
    used_in_resolvers: false
    customer_visible: true
    requiredness: conditional
    condition: "nachtrag_scope == 'other'"
    type: string
    description: |
      Free-text description of the change. Captured for human review.

  # ─── DOCUMENT INTEGRITY ───

  - id: has_handwritten_amendments
    german_label: "Handschriftliche Ergänzungen"
    severity: important
    used_in_resolvers: false
    customer_visible: true
    requiredness: required
    type: boolean
```

## Field rationale

**Why `nachtrag_scope` is critical with `used_in_resolvers: true`:** the scope determines which emitter logic fires. Wrong scope → wrong claim emission. This is the highest-leverage field in the schema.

**Why most payload fields have `used_in_resolvers: false`:** v2 launch only resolves rent. Tenant identity changes, deposit changes, term changes, usage rights — these are captured but not yet used by any resolver. They appear in triage; operators review them. Post-launch, additional resolvers can flip these payloads to `used_in_resolvers: true` without schema changes.

**Why no closure for tenant_identity_change_payload at v2:** auto-closing tenant_active claims based on a Nachtrag is high-risk. The Nachtrag may say "Anna Müller joins as co-tenant" without describing whether Max remains. Schema captures the change; operator decides whether to update tenant_active claims via human-adjudication.

**Why `rent_change_payload` delegates to mieterhoehung:** same claim shape, same prerequisites, same closure logic. Duplicating the emitter code for `mietvertragsnachtrag` would create drift over time. The mieterhoehung emitter is the single source of truth for rent-change emission; the Mietvertragsnachtrag emitter calls it when scope == `rent_change`.

## Worked examples

### Tenant adds a pet (Nachtrag changing usage right)

```yaml
nachtrag_scope: "usage_right_change"
other_changes_present: false
signing_parties: [
  { full_name: "[Landlord]", role: "vermieter" },
  { full_name: "Lena Everding", role: "mieter" }
]
landlord_signature_present: true
tenant_signature_present: true
signature_date: "2025-08-15"
effective_date: "2025-09-01"
unit_ref: "1.OG"
original_mietvertrag_referenced: { mietvertrag_date: "2024-12-01" }
usage_right_change_payload:
  change_type: "pet_added"
  change_text: "Mieterin darf eine Katze halten"
has_handwritten_amendments: false
```

Emitter behavior: nachtrag_scope is `usage_right_change`. Closing matrix `when` conditions all require `nachtrag_scope == "rent_change"` → false. Emits ONE reference-kind claim:

```yaml
Claim(
  claim_kind: "reference",
  subject: "lease:KO132_1.OG_2024",  # or "unit:1.OG" if lease_id unavailable
  predicate: "amendment_present",
  value: { scope: "usage_right_change", change_type: "pet_added", effective_date: "2025-09-01" },
  status: "unsupported_requires_review",
  source_type: "document_extraction"
)
```

No closure intents. The Nachtrag appears in triage with all extracted fields visible. Operator reviews and either accepts (no resolver impact) or creates a human-adjudication claim if needed.

### Tenant identity change (one tenant replaces another in a couple)

```yaml
nachtrag_scope: "tenant_identity_change"
other_changes_present: false
signing_parties: [
  { full_name: "[Landlord]", role: "vermieter" },
  { full_name: "Anna Schmidt", role: "mieter" },
  { full_name: "Bernd Schmidt", role: "mieter" }
]
landlord_signature_present: true
tenant_signature_present: true
effective_date: "2025-10-01"
unit_ref: "EG"
tenant_identity_change_payload:
  tenants_added: [{ full_name: "Bernd Schmidt" }]
  tenants_removed: []
  tenants_continuing: [{ full_name: "Anna Schmidt" }]
```

Emitter behavior: scope is `tenant_identity_change`. Same as above — emits one reference-kind claim with `unsupported_requires_review` status. The previous tenant_active claim for Anna remains open. The system surfaces the Nachtrag in triage; operator decides whether to manually create a tenant_active claim for Bernd via human-adjudication. v2 launch is conservative here — auto-emitting tenant_active claims based on an extracted Nachtrag is too risky without explicit operator confirmation.

Post-launch this can be elevated to auto-emission once operator-correction patterns are established.

### Bilateral rent change (delegates to mieterhoehung logic)

```yaml
nachtrag_scope: "rent_change"
other_changes_present: false
signing_parties: [...]
landlord_signature_present: true
tenant_signature_present: true
effective_date: "2025-07-01"
unit_ref: "1.OG"
rent_change_payload:
  new_kaltmiete: { normalized_value: 100000, currency: "EUR" }
  previous_kaltmiete: { normalized_value: 90000, currency: "EUR" }
  rent_structure_basis: "kaltmiete"
```

Emitter behavior: scope is `rent_change`. Delegates to mieterhoehung emitter, producing one assertion claim (kaltmiete €1,000) and one closure intent (close_overlapping_only on previous Kaltmiete). This is exactly the Weber 1. Nachtrag pattern.

The split between mieterhoehung and mietvertragsnachtrag is invisible at the resolver layer — both produce the same claim shape when rent changes. The split exists purely to make non-rent amendments visible.

---

# Doc type 5: Kündigung

The doc type that closes tenancies. Smaller than Mietvertrag but architecturally important because it's the canonical Type C event (architecture §4.5) — emits an event claim and triggers closure of all the tenant's open claims via the closing matrix.

Three sub-types matter:
- **Kündigung durch Mieter** — tenant terminates (BGB §573c, mostly unrestricted with notice period)
- **Ordentliche Kündigung durch Vermieter** — landlord terminates with grounds (BGB §573, requires Eigenbedarf, Vertragsverletzung, or Verwertungskündigung)
- **Außerordentliche Kündigung** — extraordinary termination by either party (BGB §543, e.g., severe breach, rent arrears)

For claim emission they're identical: same event, same closures, just different `kuendigungs_typ` and `kuendigender` fields.

## Domain knowledge front-matter

**File:** `domain_knowledge/kuendigung.md`

```yaml
---
doc_type: kuendigung
default_claim_kind: event
last_updated: 2026-05-08
legal_grounding:
  - statute: BGB §573
    description: |
      Ordentliche Kündigung durch Vermieter. Requires berechtigtes
      Interesse: Eigenbedarf (§573 Abs. 2 Nr. 2), Vertragsverletzung
      (Nr. 1), Verwertungskündigung (Nr. 3).
  - statute: BGB §573c
    description: |
      Kündigungsfristen: 3 months tenant; 3/6/9 months landlord
      depending on tenancy duration (<5 / 5-8 / >8 years).
  - statute: BGB §543
    description: Außerordentliche fristlose Kündigung
  - statute: BGB §568
    description: |
      Schriftformerfordernis. Kündigungen require written form
      with original signature. Email/fax insufficient.
  - statute: BGB §574
    description: |
      Widerspruchsrecht (Sozialklausel). Tenant can object to
      ordentliche Kündigung if termination would cause hardship.
fields_governed:
  - kuendigungs_typ
  - kuendigender
  - kuendigungs_grund
  - kuendigungs_grund_text
  - notice_date
  - effective_termination_date
  - kuendigungsfrist_einhaltung
  - unit_ref
  - tenant_identity
  - signature_present
  - widerspruch_indication_in_document
  - kuendigungs_zustellung_method
  - aufhebungsvertrag_detected
normalization_rules:
  - id: termination_date_normalization
    field: effective_termination_date
    description: |
      The date the lease actually ends. For ordentliche Kündigung,
      computed from notice_date + Kündigungsfrist (often stated
      explicitly in the notice). For außerordentlich, often immediate
      or at a stated date. The schema captures effective_termination_date
      as the authoritative end date for the lease — this is what drives
      the closure intents' valid_to on tenant claims.
  - id: kuendigungsfrist_check
    field: kuendigungs_typ
    description: |
      For ordentliche Kündigung by landlord, verifier checks that
      effective_termination_date is at least the legally required
      notice period after notice_date (3/6/9 months per BGB §573c
      depending on tenancy duration, computed from Mietvertrag's
      mietbeginn). Violations don't block extraction; flag with
      legal_validity_status = "potentially_invalid_requires_review".
gotchas:
  - id: aufhebungsvertrag_no_auto_closure
    description: |
      An Aufhebungsvertrag (mutual termination agreement, both parties
      sign) is structurally different from a Kündigung (unilateral
      notice). Telltale: Aufhebungsvertrag is signed by both parties
      and titled "Mietaufhebungsvertrag", "Aufhebungsvereinbarung",
      "Mietaufhebung", or contains language like "einvernehmlich
      beendigen" / "im gegenseitigen Einvernehmen aufgehoben."
      
      v2 behavior: if Aufhebungsvertrag is detected during extraction
      (kuendigungs_typ = "aufhebungsvertrag" OR aufhebungsvertrag_detected = true):
      - Emit NO claims at all
      - Emit NO closure intents
      - Document is captured (envelope written, document_status = "review_required")
      - Surface in triage with message "Aufhebungsvertrag erkannt; v2
        verarbeitet diesen Dokumenttyp nicht automatisch. Bitte prüfen
        und ggf. manuell zuordnen."
      - Operator can manually create a human-adjudication closure if
        the Aufhebungsvertrag's effects should be applied to resolved facts
      
      Aufhebungsvertrag-as-separate-doc-type stays in deferred backlog
      (post-launch). For v2: detected, marked, never auto-closes.
  - id: schriftform_unsigned_kuendigung
    description: |
      A Kündigung without an original signature is operationally unsafe
      (BGB §568 requires written form with signature). Schema captures
      signature_present; emitter behavior:
      - If signature_present is false AND kuendigungs_typ is not "draft",
        set legal_validity_status = "formal_prerequisites_missing"
      - Emit NO claims and NO closure intents
      - Force human review
      The tenant or landlord might still believe they have a Kündigung,
      but the system shouldn't close claims based on an unsigned notice.
      Note: "operationally unsafe" is the language. The system never
      declares a document "invalid" — that's a legal determination.
  - id: widerspruch_indication_limitation
    description: |
      A Widerspruch (tenant objection under BGB §574) is a separate
      document that arrives AFTER the Kündigung. The Kündigung itself
      cannot reference a future Widerspruch. The schema field
      `widerspruch_indication_in_document` captures only what the
      Kündigung document itself reveals — for example, if the Kündigung
      includes the standard BGB §574 information notice mentioning the
      tenant's right to object, OR if the Kündigung is a re-issued
      notice that references a prior Widerspruch from the tenant.
      
      v2 LIMITATION: v2 does not handle post-Kündigung Widersprüche
      automatically. If a tenant files a Widerspruch after the Kündigung
      has been processed and closures applied:
      - The closures remain in place
      - The tenant_active claim shows as closed
      - The operator must manually create a correction claim
        (human-adjudication source_type) to re-open the tenancy
      - The append-only claim store preserves the full chain:
        original Mietvertrag claim → Kündigung closure → manual re-opening
      - This is acceptable for v2 because Widerspruch is a slow-moving
        legal event the operator will know about (unlike Hofmann, which
        was silent)
      
      Post-launch: full Widerspruch doc_type (`widerspruch_gegen_kuendigung`)
      with retroactive closure-status update logic.
    behavior:
      v2_handling: capture_only_no_special_emission
      operator_workaround: manual_correction_claim
      post_launch_doc_type: widerspruch_gegen_kuendigung
  - id: multi_tenant_partial_is_applier_check_not_extraction
    description: |
      For multi-tenant Mietverträge (couples, WGs), a Kündigung may
      come from one tenant only. Per German law, joint Mietverträge
      typically require all tenants to terminate jointly (varies by
      contract). 
      
      The Kündigung document alone cannot reliably determine whether a
      partial-termination scenario applies — the document might list
      only the terminating tenants without mentioning that other tenants
      remain on the lease. So the schema captures terminating_parties
      and recipient_parties as extracted, but the multi-tenant-partial
      blocker check happens in the APPLIER, not at extraction time.
      
      Applier behavior (architecture §5.5.5):
      1. Query active tenant_active claims for the unit
      2. Compare count and identity (via fuzzy match) against
         terminating_parties_extracted
      3. If active_tenants count > terminating count, OR if not all
         active tenants appear in the terminating list:
         - Insert the lease_terminated event claim
         - Mark closure intents with blocker_status: "requires_review"
         - Surface in triage with message "Teilkündigung bei
           Mehrparteienverhältnis erkannt"
      4. If active and terminating sets match (full termination):
         - Apply closures normally
      
      The schema field `terminating_parties_count_in_document` is
      captured but should NOT be used as the final blocker — it's input
      to the applier check, not the check itself.
adversarial_fixtures_required:
  - kuendigung_durch_mieter_ordentlich
  - kuendigung_durch_vermieter_eigenbedarf
  - kuendigung_durch_vermieter_vertragsverletzung
  - kuendigung_ausserordentlich_zahlungsverzug
  - kuendigung_unsigned_formal_prerequisites_missing
  - kuendigung_with_widerspruch_indication
  - aufhebungsvertrag_detected_no_emission  # Aufhebungsvertrag handling
  - kuendigung_one_of_couple_only_applier_blocks_closure  # multi-tenant
  - kuendigung_kuendigungsfrist_violated_potentially_invalid
closes:
  - target_predicate: kaltmiete
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_and_future
    when: |
      kuendigungs_typ in [ordentlich, ausserordentlich_fristlos, ausserordentlich_befristet]
      AND signature_present == true
      AND aufhebungsvertrag_detected == false
      AND legal_validity_status not in [formal_prerequisites_missing, disputed]
    valid_to_source: "effective_termination_date"
    match_requirements:
      tenant_identity_required: true
    blocker_check:
      - condition: "applier_detects_multi_tenant_partial_termination"
        action: "set blocker_status to requires_review"
  - target_predicate: tenant_active
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_and_future
    when: "same conditions as above"
    valid_to_source: "effective_termination_date"
    match_requirements:
      tenant_identity_required: true
    blocker_check:
      - condition: "applier_detects_multi_tenant_partial_termination"
        action: "set blocker_status to requires_review"
  - target_predicate: nebenkostenvorauszahlung
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_and_future
    when: "same conditions as above"
    valid_to_source: "effective_termination_date"
    match_requirements:
      tenant_identity_required: true
    blocker_check:
      - condition: "applier_detects_multi_tenant_partial_termination"
        action: "set blocker_status to requires_review"
  - target_predicate: kaution
    target_subject_pattern: "unit:{unit_ref}"
    close_mode: close_overlapping_and_future
    when: "same conditions as above"
    valid_to_source: "effective_termination_date + 6 months"  # GoBD-friendly grace period (BGB §548)
    match_requirements:
      tenant_identity_required: true
  # IMPORTANT: NO closures for owner predicate — Kündigung is a tenant
  # transition, not an ownership transition.
---

# Kündigung — domain knowledge

## What this doc type is

A unilateral termination notice. Either tenant or landlord can issue.
Closes tenant claims via the closing matrix above.

## Why kaution closure has a +6 month grace period

The Kaltmiete and tenant_active claims close at the effective termination
date (the day the lease ends). The kaution claim, however, often remains
open for a few months after lease end while the landlord settles
Nebenkostenabrechnung and decides on deposit returns (BGB §548 limitation
period for landlord's claims is 6 months after move-out). Closing the
kaution claim 6 months post-termination matches practical reality.
Post-launch, an Auszug-Übergabeprotokoll's kaution_settlement field can
override this with the actual settlement event.

## Why partial multi-tenant Kündigung doesn't auto-close

Joint Mietverträge typically require joint Kündigung. If one tenant of
a couple terminates, the lease may legally continue with the remaining
tenant or require special handling. Schema and emitter conservatively
force human review rather than guessing. Better to surface the case for
human judgment than to wrongly terminate a still-valid tenancy.
```

## Schema YAML

**File:** `schemas/kuendigung/schema.yaml`

```yaml
doc_type: kuendigung
schema_version: "2026-05-08-v1"
claim_kind: event
domain_knowledge_ref: domain_knowledge/kuendigung.md
prompt_fragment_template: |
  Du extrahierst Felder aus einem deutschen Kündigungsschreiben.
  
  Bestimme:
  - Wer kündigt (Mieter oder Vermieter)?
  - Welcher Kündigungstyp (ordentlich oder außerordentlich)?
  - Bei Vermieter-Kündigung: welcher Grund (Eigenbedarf, Vertragsverletzung,
    Verwertungskündigung, andere)?
  - Datum der Kündigung (notice_date) und Datum des Mietendes (effective_termination_date).
  
  WICHTIG: Eine Kündigung ohne Unterschrift ist operationell unsicher
  (BGB §568 Schriftformerfordernis). Erfasse signature_present sorgfältig.
  
  WICHTIG: Erfasse aufhebungsvertrag_detected. Wenn das Dokument ein
  bilateral unterzeichneter Aufhebungsvertrag ist (kein einseitiger
  Kündigung), setze diesen Wert auf true. Das System verarbeitet
  Aufhebungsverträge in v2 nicht automatisch.
  
  WICHTIG: Erfasse alle terminating_parties_extracted (Personen, die
  laut Dokument das Mietverhältnis beenden). Die Prüfung auf
  Teilkündigung bei Mehrparteienverhältnissen erfolgt automatisch
  beim Anwenden der Kündigung — du musst sie nicht selbst beurteilen.
  Erfasse einfach, wer im Dokument als kündigend genannt wird.
  
  [field instructions inserted by generator]

fields:

  # ─── DOCUMENT CLASSIFICATION ───

  - id: kuendigungs_typ
    german_label: "Art der Kündigung"
    severity: critical
    requiredness: required
    type: enum
    enum_values: ["ordentlich", "ausserordentlich_fristlos", "ausserordentlich_befristet", "aufhebungsvertrag", "unklar"]
    classification_hints: |
      Notice with Kündigungsfrist (months until termination) → ordentlich.
      "fristlos", "mit sofortiger Wirkung", references to BGB §543
      → ausserordentlich_fristlos.
      Bilateral signed agreement to end lease → aufhebungsvertrag (should
      be a separate doc_type; flag for review).
      Unclear → "unklar".
    verifier_refs:
      - enum_validity

  - id: kuendigender
    german_label: "Kündigender"
    severity: critical
    requiredness: required
    type: enum
    enum_values: ["mieter", "vermieter", "beide", "unklar"]

  - id: kuendigungs_grund
    german_label: "Kündigungsgrund"
    severity: important
    requiredness: conditional
    condition: "kuendigender == 'vermieter' AND kuendigungs_typ == 'ordentlich'"
    type: enum
    enum_values: ["eigenbedarf_573_2_2", "vertragsverletzung_573_2_1", "verwertungskuendigung_573_2_3", "andere", "unklar"]

  - id: kuendigungs_grund_text
    german_label: "Begründung (Volltext)"
    severity: important
    requiredness: conditional
    condition: "kuendigender == 'vermieter'"
    type: string
    description: |
      Free-text justification, captured for audit. For Eigenbedarf,
      this should describe who needs the unit and why. Required text
      under BGB §573 Abs. 3.

  # ─── DATES (lifecycle-critical) ───

  - id: notice_date
    german_label: "Datum der Kündigung"
    severity: critical
    requiredness: required
    type: date
    verifier_refs:
      - date_format

  - id: effective_termination_date
    german_label: "Beendigung zum"
    severity: critical
    requiredness: required
    type: date
    verifier_refs:
      - date_format
      - kuendigungsfrist_check
    normalization_rule_ref: termination_date_normalization
    description: |
      The date the lease actually ends. Drives valid_to on closure
      intents for tenant claims. For ordentliche Kündigung, computed
      from notice_date + Kündigungsfrist. For ausserordentlich, often
      explicit in the document.

  - id: stated_kuendigungsfrist
    german_label: "Angegebene Kündigungsfrist"
    severity: important
    requiredness: optional
    type: structured
    item_schema:
      - field: months
        type: number
        required: false
      - field: end_of_month
        type: boolean
        required: false
      - field: raw_text
        type: string
        required: false

  # ─── UNIT / TENANT IDENTIFICATION ───

  - id: unit_ref
    german_label: "Einheit"
    severity: critical
    requiredness: required
    type: enum_extensible
    enum_values: ["EG", "1.OG", "2.OG", "3.OG", "DG", "KG", "EG_links", "EG_rechts", "EG_mitte", "1.OG_links", "1.OG_rechts", "1.OG_mitte", "DG_links", "DG_rechts", "DG_mitte"]
    normalization_rule_ref: unit_ref_normalization

  - id: tenant_identity
    german_label: "Mieter"
    severity: critical
    requiredness: required
    type: structured_array
    item_schema:
      - field: full_name
        type: string
        required: true
    description: |
      Tenants on the lease being terminated. Required for closure-intent
      matching. Critical-severity because misidentifying tenants would
      close the wrong claims.

  - id: terminating_parties_count_in_document
    german_label: "Anzahl der kündigenden Parteien im Dokument"
    severity: critical
    used_in_resolvers: false  # extraction input; applier uses it
    customer_visible: false
    requiredness: required
    type: number
    description: |
      Count of distinct parties shown as terminating the lease in this
      document. Used by the applier (architecture §5.5.5) to detect
      multi-tenant partial terminations by comparing against active
      tenant_active claims for the unit. NOT a closure blocker by itself
      — the applier performs the comparison against the claim store.
      The auto-closure logic is claim-aware, not extraction-aware.

  - id: terminating_parties_extracted
    german_label: "Kündigende Parteien"
    severity: critical
    used_in_resolvers: false  # input to applier
    customer_visible: true
    requiredness: required
    type: structured_array
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: role_in_termination
        type: enum
        enum_values: ["primary_signatory", "co_signatory", "represented_by_other"]
        required: false
    description: |
      The parties terminating the lease per the document. Compared by
      the applier (via fuzzy token-subset match per architecture §5.5.6)
      against active tenant_active claims for the unit. Mismatch →
      blocker_status: "requires_review" on closure intents.

  - id: aufhebungsvertrag_detected
    german_label: "Aufhebungsvertrag erkannt"
    severity: critical
    used_in_resolvers: true  # gates emission entirely
    customer_visible: true
    requiredness: required
    type: boolean
    description: |
      True if the document is detected as a mutual termination
      agreement (Aufhebungsvertrag) rather than a unilateral Kündigung.
      Telltale: bilateral signatures + title or text indicating
      "Aufhebung", "einvernehmliche Beendigung", "Mietaufhebung."
      
      If true: emitter produces NO claims and NO closure intents.
      Document is captured for human review (document_status =
      "review_required"). Aufhebungsvertrag-as-distinct-doc-type is
      deferred post-launch.

  # ─── LEGAL VALIDITY (drives emitter behavior) ───

  - id: signature_present
    german_label: "Unterschrift vorhanden"
    severity: critical
    used_in_resolvers: true  # gates emission entirely
    customer_visible: true
    requiredness: required
    type: boolean
    description: |
      Per BGB §568, Kündigung requires written form with original
      signature. Without signature, the notice is operationally unsafe
      to apply automatically and the emitter must NOT close claims.
      Sets legal_validity_status = "formal_prerequisites_missing"
      when false. Critical-severity because false means the emitter
      behavior changes fundamentally.

  - id: kuendigungs_zustellung_method
    german_label: "Zustellungsart"
    severity: nice_to_have
    used_in_resolvers: false
    customer_visible: true
    requiredness: optional
    type: enum
    enum_values: ["einschreiben", "boten_uebergabe", "einwurf", "persoenlich", "andere", "nicht_dokumentiert"]

  - id: widerspruch_indication_in_document
    german_label: "Widerspruchs-Hinweis im Dokument"
    severity: important
    used_in_resolvers: false  # captured but not load-bearing in v2
    customer_visible: true
    requiredness: required
    type: boolean
    description: |
      True if the Kündigung document itself contains an indication of
      Widerspruch — typically the mandatory BGB §574 information notice
      (landlord must inform tenant of right to object), OR if the
      Kündigung is a re-issued notice referencing a prior tenant
      objection. This field captures only what the Kündigung document
      reveals.
      
      v2 LIMITATION: a Widerspruch typically arrives as a separate
      document AFTER the Kündigung. v2 does not handle post-Kündigung
      Widersprüche. If a tenant files a Widerspruch after closures
      are applied, the operator must manually create a correction
      claim to re-open the tenancy. The append-only claim store
      preserves the chain. Post-launch: full Widerspruch doc_type
      with retroactive closure-status update logic.
      
      Field renamed from `widerspruch_referenced` (v2 draft) to
      `widerspruch_indication_in_document` to be honest about scope.

  # ─── PARTIES ───

  - id: signing_party
    german_label: "Unterzeichner"
    severity: important
    requiredness: required
    type: structured
    item_schema:
      - field: full_name
        type: string
        required: true
      - field: role
        type: enum
        enum_values: ["mieter", "mieter_vertretung", "vermieter", "vermieter_vertretung", "hausverwaltung", "anwalt", "andere"]
        required: false
      - field: legal_authority
        type: string
        required: false

  # ─── DOCUMENT INTEGRITY ───

  - id: has_handwritten_amendments
    german_label: "Handschriftliche Ergänzungen"
    severity: important
    requiredness: required
    type: boolean

  - id: original_mietvertrag_referenced
    german_label: "Bezug auf Mietvertrag"
    severity: nice_to_have
    requiredness: optional
    type: structured
    item_schema:
      - field: mietvertrag_date
        type: date
        required: false
```

## Field rationale

**Why multi-tenant-partial validation lives in the applier, not extraction:** the Kündigung document alone often doesn't reveal whether the lease has additional tenants beyond those listed as terminating. A single Kündigung saying "Ich, Max Müller, kündige" looks complete in extraction, but Max may be one of two tenants on the underlying lease. Determining "partial termination" requires comparing the document's `terminating_parties_extracted` against currently-active `tenant_active` claims for the unit — which is claim-store work, not extraction work. Architecture §5.5.5 specifies the applier's claim-aware blocker check; the schema fields (`terminating_parties_extracted`, `terminating_parties_count_in_document`) are extraction inputs to that check, not the check itself.

**Why `signature_present` is critical with `used_in_resolvers: true`:** unsigned Kündigungen don't close claims. The emitter conditions all closures on `signature_present == true`. False sets `legal_validity_status = "formal_prerequisites_missing"` and causes the emitter to produce no claims at all. "Operationally unsafe to apply automatically" rather than "invalid" — see architecture §10.5.

**Why `aufhebungsvertrag_detected` is critical with `used_in_resolvers: true`:** Aufhebungsverträge structurally require human review in v2. True causes the emitter to produce no claims and surface the document in triage with a clear message. Aufhebungsvertrag-as-distinct-doc-type is deferred post-launch.

**Why `widerspruch_indication_in_document` is `important` not `critical`:** the field captures only what the Kündigung document itself reveals about Widerspruch — typically the standard BGB §574 information notice the landlord must include, OR a re-issued notice referencing a prior tenant objection. Most Widersprüche arrive as separate documents AFTER the Kündigung and require manual operator handling (see gotcha `widerspruch_indication_limitation`). The field is captured for completeness but not load-bearing for v2 closure logic.

**Why kaution closure has +6 months:** practical reality. Landlords legally have up to 6 months to settle and return deposits (BGB §548). The +6 month grace gives time for an Auszug-Übergabeprotokoll's kaution_settlement to override with the actual event.

**Why no fields for Räumungsklage / eviction proceedings:** out of v2 scope. Court documents are separate doc types.

## Worked example

### Hypothetical Kündigung for KO132 EG (Paul terminates her tenancy in 2027)

```yaml
kuendigungs_typ: "ordentlich"
kuendigender: "mieter"
kuendigungs_grund: null  # not applicable for tenant terminations
notice_date: "2027-04-15"
effective_termination_date: "2027-07-31"  # 3 months notice, end of month
stated_kuendigungsfrist: { months: 3, end_of_month: true }
unit_ref: "EG"
tenant_identity: [{ full_name: "Julija Paul" }]
terminating_parties_extracted: [{ full_name: "Julija Paul", role_in_termination: "primary_signatory" }]
terminating_parties_count_in_document: 1
aufhebungsvertrag_detected: false
signature_present: true
kuendigungs_zustellung_method: "einschreiben"
widerspruch_indication_in_document: false
signing_party: { full_name: "Julija Paul", role: "mieter" }
legal_validity_status: "formal_prerequisites_present"
```

Emitter behavior:
- All `when` conditions in closing matrix are true (signed, not Aufhebungsvertrag, no missing prerequisites)
- Emits one `lease_terminated` event claim, `valid_from = valid_to = 2027-07-31`
- Emits four closure intents with `close_mode: close_overlapping_and_future`:
  - kaltmiete: `valid_to = 2027-07-31`, match Julija Paul
  - tenant_active: `valid_to = 2027-07-31`, match Julija Paul
  - nebenkostenvorauszahlung: `valid_to = 2027-07-31`, match Julija Paul
  - kaution: `valid_to = 2028-01-31` (termination date + 6 months), match Julija Paul

Applier behavior (architecture §5.5.5):
- Queries active tenant_active claims for unit "EG"
- Finds 1 active tenant: Julija Paul
- Compares against `terminating_parties_extracted`: 1 party (Julija Paul) → match via fuzzy token-subset
- Multi-tenant-partial check: PASSES (count and identities match)
- Applies all four closures with the declared `close_mode`. The `close_overlapping_and_future` mode means: any pre-emitted future Mieterhöhung claims for this unit (none in this case) would also be closed, preventing the Kündigung-after-Mieterhöhung processing-order bug

After applier runs:
- `rent_for_unit(KO132, "EG")` returns null on 2027-08-01 (no_active_claim)
- `rent_for_unit(KO132, "EG", as_of=2027-06-01)` still returns €575 (historical query works)
- A new Mietvertrag for EG creates a new active claim chain starting at the new tenancy's mietbeginn

### Hypothetical Kündigung from one of two tenants (multi-tenant partial case)

```yaml
kuendigungs_typ: "ordentlich"
kuendigender: "mieter"
notice_date: "..."
effective_termination_date: "..."
unit_ref: "1.OG"
tenant_identity: [{ full_name: "Max Müller" }]  # only Max, but lease has Max AND Anna
terminating_parties_extracted: [{ full_name: "Max Müller", role_in_termination: "primary_signatory" }]
terminating_parties_count_in_document: 1
aufhebungsvertrag_detected: false
signature_present: true
widerspruch_indication_in_document: false
legal_validity_status: "formal_prerequisites_present"
```

Emitter behavior:
- All `when` conditions in closing matrix are true (signed, not Aufhebungsvertrag, prerequisites present)
- Emits the `lease_terminated` event claim
- Emits four closure intents with normal `close_mode`

Applier behavior (claim-aware blocker check):
- Queries active tenant_active claims for unit "1.OG"
- Finds 2 active tenants: Max Müller AND Anna Müller
- Compares against `terminating_parties_extracted`: 1 party (Max Müller)
- Multi-tenant-partial detected: 2 active > 1 terminating
- Sets `blocker_status: "requires_review"` on all four closure intents
- Inserts the lease_terminated event claim (audit captures that termination was filed)
- Does NOT apply the closures
- Surfaces in triage with message "Teilkündigung bei Mehrparteienverhältnis erkannt: 2 aktive Mieter, 1 kündigend"

After applier runs:
- Tenant claims for both Max and Anna remain open
- `rent_for_unit(KO132, "1.OG")` still returns the active rent
- Operator reviews the case in triage, decides whether the lease continues with Anna alone (manual closure of Max's tenant_active claim only via human-adjudication) or whether the joint Mietvertrag makes the partial termination invalid

### Hypothetical Aufhebungsvertrag (mutual termination)

```yaml
kuendigungs_typ: "aufhebungsvertrag"
aufhebungsvertrag_detected: true
notice_date: null
effective_termination_date: "2025-09-30"
unit_ref: "DG"
tenant_identity: [{ full_name: "..." }]
terminating_parties_extracted: [{ full_name: "..." }, { full_name: "[Vermieter]" }]
signature_present: true
landlord_signature_present: true
widerspruch_indication_in_document: false
```

Emitter behavior:
- `aufhebungsvertrag_detected` is true → matrix `when` conditions all check `aufhebungsvertrag_detected == false` → false
- Emits NO claims, NO closure intents
- Sets `document_status: "review_required"`
- Surfaces in triage: "Aufhebungsvertrag erkannt; v2 verarbeitet diesen Dokumenttyp nicht automatisch. Bitte prüfen und ggf. manuell zuordnen."

After applier runs (nothing applied):
- All tenant claims remain open
- Operator manually creates closure claims via human-adjudication if appropriate (e.g., to close Kaltmiete and tenant_active at the agreed termination date, with `source_type: "human_adjudication"`)

This is the conservative behavior for ambiguous-or-out-of-scope termination types. The system doesn't assume the termination took effect; it surfaces the case for human judgment.

---

# What this document is not

- A complete list of every field that ever appears on a German Mietvertrag, Übergabeprotokoll, Mieterhöhung, Mietvertragsnachtrag, or Kündigung. The schemas are comprehensive for the **typical** German doc type, not exhaustive for every edge case (e.g., hereditary leasehold contracts, military housing leases, social housing with KdU rules, court-ordered terminations, Räumungsklagen — all out of scope).
- A specification of how the schema YAML is parsed by the generator. That's `scripts/gen-schemas.ts` (Implementation Plan Task 0.3).
- A specification of the emitters. Emitter signatures and behavior are in the architecture document (§4.4 and §5.5) and implementation plan (Tasks 1.7, 2.1, 2.4).
- The full set of doc types for the launch slice. Kaufvertrag is referenced from these schemas (as a related document for Eigentümerwechsel) but its own schema is out of Pass 2 scope. Court documents (Widerspruch resolutions, Räumungsklagen, Modernisierungsankündigungen) are similarly out of scope. Aufhebungsvertrag-as-distinct-doc-type is deferred post-launch.

# What's in scope for Pass 3

Pass 3 will produce:
- Full `rent_for_unit` resolver implementation walkthrough
- Verifier specifications for every critical-severity field across all five schemas (Mietvertrag, Wohnungsübergabeprotokoll, Mieterhöhung, Mietvertragsnachtrag, Kündigung) — currently referenced as `verifier_refs` but not implementation-detailed
- Conflict resolution rules with worked examples beyond the simple cases here

That output completes the design pillars before implementation starts.

---

For your review. Push back on field choices, severity assignments, gotcha completeness, or anything that feels under-specified. Particularly worth scrutinizing:

1. The closing matrix in the **Übergabeprotokoll** front-matter (the structural fix for the Hofmann bug; if wrong, the bug recurs).
2. The closing matrix in the **Kündigung** front-matter (closes 4 predicates conditionally with `close_mode: close_overlapping_and_future`; multi-tenant-partial check happens in the applier per architecture §5.5.5).
3. The split of Mieterhöhung and Mietvertragsnachtrag into two doc_types (separates rent-changing documents from generic amendments to prevent silent data loss on non-rent Nachträge).
4. The conservative behavior for `aufhebungsvertrag_detected`, `signature_present`, and the applier-time multi-tenant-partial check — are these the right cases to block auto-closure, or are there others?
5. The interval-aware closure modes (`close_overlapping_only`, `close_overlapping_and_future`, `close_overlapping_and_supersede_future`) declared per closing rule — does the per-rule declaration capture all the needed semantics?
