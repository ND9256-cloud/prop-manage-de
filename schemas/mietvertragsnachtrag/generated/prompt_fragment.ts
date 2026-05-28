// DO NOT EDIT — generated from schemas/mietvertragsnachtrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-28-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `## Mietvertragsnachtrag — extract the following fields

A Mietvertragsnachtrag is a bilateral amendment to an existing Mietvertrag
signed by BOTH parties. It can change any term: rent, deposit, ancillary
costs, lease duration, permitted use, or party details. Classify by WHAT
the document changes — never by the document title alone.

For each field, return:
- raw_value: verbatim text from the document
- normalized_value: typed canonical form (see per-field instructions)
- evidence: array of { quote: <verbatim quote>, page: <number>, bbox: null }. At least one entry required when absence_state == "present".
- confidence: high | medium | low
- absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
- validation_status: valid (set this; verifiers run separately)

Evidence is MANDATORY when absence_state == present.

### nachtrag_scope (CRITICAL discriminator — drives all downstream behavior)

Normalize to EXACTLY one of:
- "rent_change" — the amendment changes the Kaltmiete. Triggers delegation to the Mieterhöhung emitter for kaltmiete supersession.
- "tenant_identity_change" — a party detail changes (marriage name change, co-tenant added/removed). The tenancy CONTINUES; only a detail changes.
- "deposit_change" — the Kaution amount or terms change.
- "ancillary_cost_change" — Nebenkosten allocation or prepayment changes.
- "term_change" — lease duration, notice period, or end date changes.
- "usage_right_change" — permitted use changes (pets, subletting, parking, commercial use).
- "other" — anything not covered above, OR multi-scope documents that change several terms at once and need human adjudication.

Classify by content, not the title. When multiple scopes are present, set "rent_change" if rent is among them (rent supersession is the highest-stakes action); otherwise set "other".

### unit_ref (Einheit — normalized floor/position identifier)

Normalize to one of: EG, 1.OG, 2.OG, 3.OG, 4.OG, DG, Keller, Souterrain. Must match the unit_ref of the Mietvertrag being amended. Common variants: "Erdgeschoss" → "EG"; "1. Obergeschoss" → "1.OG"; "Dachgeschoss" → "DG".

### effective_date (date the amendment takes effect)

ISO 8601 (YYYY-MM-DD). Source is typically DD.MM.YYYY — normalize. For rent_change scope this drives the new kaltmiete claim's valid_from and the closure edge (effective_date - 1 day) via the Mieterhöhung delegation.

### tenant_identity (Mieter — the tenant party to the lease being amended)

normalized_value: { name: <full name as written>, is_legal_entity: <bool>, legal_form: <optional string for entities> }.

### landlord_signature_present (boolean)

true if the document carries a landlord signature. Required for any bilateral amendment to be legally effective.

### tenant_signature_present (boolean)

true if the document carries a tenant signature. Required for any bilateral amendment to be legally effective.

### document_status (lifecycle state)

One of: draft, unsigned, signed, executed.

### rent_change_payload (CONDITIONAL — only when nachtrag_scope == "rent_change")

Structured payload carrying enough to reshape into a Mieterhöhung extraction:
- new_kaltmiete: { amount: <cents>, currency: "EUR" } (REQUIRED for this scope)
- previous_kaltmiete: { amount: <cents>, currency: "EUR" } (optional)
- rechtsgrundlage: typically "bilateral" for Nachträge; may also be "indexmiete" or "staffelmiete" if the amendment activates such a clause. Defaults to "bilateral" if not stated.
- staffelmiete_context: boolean — true if the document references a Staffelplan.

### tenant_identity_change_payload (CONDITIONAL — only when nachtrag_scope == "tenant_identity_change")

Structured payload describing the change:
- old_tenant_identity: { name, is_legal_entity, legal_form }
- new_tenant_identity: { name, is_legal_entity, legal_form }
- change_reason: short string (e.g. "Heirat", "Wohngemeinschaftswechsel", "Sterbefall")

### deposit_change_payload (CONDITIONAL — only when nachtrag_scope == "deposit_change")

- new_kaution: { amount: <cents>, currency: "EUR" }
- previous_kaution: { amount: <cents>, currency: "EUR" } (optional)
- change_notes: short string (optional)

### ancillary_cost_change_payload (CONDITIONAL — only when nachtrag_scope == "ancillary_cost_change")

- new_nebenkostenvorauszahlung: { amount: <cents>, currency: "EUR" } (optional)
- previous_nebenkostenvorauszahlung: { amount: <cents>, currency: "EUR" } (optional)
- umlagefaehige_kosten_changed: boolean
- change_notes: short string (optional)

### term_change_payload (CONDITIONAL — only when nachtrag_scope == "term_change")

- new_term_end: ISO 8601 date (optional — null for indefinite)
- previous_term_end: ISO 8601 date (optional)
- new_notice_period_months: number (optional)
- change_notes: short string (optional)

### usage_right_change_payload (CONDITIONAL — only when nachtrag_scope == "usage_right_change")

- usage_right_type: one of "Tierhaltung" | "Untervermietung" | "Stellplatz" | "Gewerbenutzung" | "Sonstiges"
- permitted: boolean (true = now permitted; false = now prohibited)
- change_notes: short string describing the precise text of the new clause

### other_change_descriptor (CONDITIONAL — only when nachtrag_scope == "other")

Free-text description of the amendment. Required when scope is "other" because that scope is the multi-scope / unsupported bucket and a human reviewer needs the document's gist.`;

export const SCHEMA_VERSION = "2026-05-28-v1";
export const DOC_TYPE = "mietvertragsnachtrag";
