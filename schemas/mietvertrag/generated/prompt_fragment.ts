// DO NOT EDIT — generated from schemas/mietvertrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-11-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `## Mietvertrag — extract the following fields

For each field, return:
- raw_value: verbatim text from the document
- normalized_value: typed canonical form (see per-field instructions)
- evidence: { quote: <verbatim quote>, page: <number>, bbox: null }
- confidence: high | medium | low
- absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
- validation_status: valid (set this; verifiers run separately)

Evidence is MANDATORY when absence_state == present. Do not set a value without an evidence quote.

### kaltmiete (Kaltmiete — base rent, monthly, EUR)

Extract ONLY the base rent excluding Nebenkosten. Accept synonyms: Grundmiete, Nettomiete, Nettokaltmiete.
REJECT (set absence_state: ambiguous) if the contract uses Bruttomiete, Inklusivmiete, or Warmmiete — these bundle operating costs and the Kaltmiete component is not separately stated.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 65000, currency: "EUR" } for €650.00.

### unit_ref (Einheit — normalized floor/position identifier)

Extract from the filled-in unit specification, NOT from template boilerplate or headers.
Normalize to one of: EG, 1.OG, 2.OG, 3.OG, 4.OG, DG, Keller, Souterrain.
Common mappings: "Erdgeschoss" → EG; "1. Obergeschoss" → 1.OG; "Dachgeschoss" → DG.
If multiple units are listed (a single lease covering multiple units), extract the unit the lease primarily concerns; if genuinely ambiguous, set absence_state: ambiguous.

### tenant_identity (Mieter — the tenant party)

Extract the tenant as written on the contract.
normalized_value: { name: <full name as written>, is_legal_entity: <bool>, legal_form: <optional string for entities> }.
Legal-entity indicators: GmbH, UG, AG, eG, GbR, KG, OHG appearing in the name. Set is_legal_entity: true and populate legal_form with the matching abbreviation.
For multiple co-tenants (Mietgemeinschaft), extract the first named tenant only.

### mietbeginn (Mietbeginn — lease start date)

Extract the date the lease takes effect.
normalized_value: ISO 8601 (YYYY-MM-DD). Source is typically DD.MM.YYYY — normalize.
If the contract specifies "ab Übergabe" or similar without a concrete date, set absence_state: ambiguous.

### mietende (Mietende — lease end date, optional)

Most German residential leases are open-ended (unbefristet). For those, set absence_state: not_applicable. NOT absence_state: absent — the difference is meaningful.
If the contract specifies a fixed end date (Befristung), extract it. Format: ISO 8601 (YYYY-MM-DD).`;

export const SCHEMA_VERSION = "2026-05-11-v1";
export const DOC_TYPE = "mietvertrag";
