// DO NOT EDIT — generated from schemas/mietvertrag/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-21-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `## Mietvertrag — extract the following fields

For each field, return:
- raw_value: verbatim text from the document
- normalized_value: typed canonical form (see per-field instructions)
- evidence: array of { quote: <verbatim quote>, page: <number>, bbox: null }. At least one entry required when absence_state == "present".
- confidence: high | medium | low
- absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
- validation_status: valid (set this; verifiers run separately)

Evidence is MANDATORY when absence_state == present. The evidence array must contain at least one entry. Do not set a value without supporting evidence quotes.

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

### landlord_identity (Vermieter — the landlord party)

Extract the landlord as written on the contract. Structurally identical to tenant_identity.
normalized_value: { name: <full name or entity name>, is_legal_entity: <bool>, legal_form: <optional string for entities> }.
Legal-entity indicators: GmbH, UG, AG, eG, GbR, KG, OHG, e.V., GmbH & Co. KG. Set is_legal_entity: true and populate legal_form.
For multiple landlords / joint ownership, extract the named entity (e.g., "Denn & Denn Verwaltungs GbR") OR the first listed natural person if no entity is named.

### nebenkostenvorauszahlung (Nebenkostenvorauszahlung — monthly advance for Nebenkosten, EUR, optional)

Extract the monthly advance payment for Nebenkosten/Betriebskosten, separately stated from Kaltmiete. Synonyms: NK-Vorauszahlung, Betriebskostenvorauszahlung, Vorauszahlung Nebenkosten.
If the contract uses Inklusivmiete or only states Warmmiete without breaking out NK, set absence_state: ambiguous.
If the contract genuinely doesn't include NK, set absence_state: not_applicable.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 18000, currency: "EUR" } for €180.00.

### kaution (Kaution — security deposit, EUR, optional)

Kaution oder Mietsicherheit, vom Mieter beim Vermieter zu hinterlegen.

WICHTIG: In deutschen Mietverträgen erscheint dieses Konzept unter verschiedenen Bezeichnungen — alle bezeichnen denselben Sachverhalt:
- "Kaution"
- "Mietsicherheit"
- "Barkaution"
- "Sicherheitsleistung"
- Auch Kombinationen wie "Mietsicherheit in Form einer Barkaution"

Der Geldbetrag erscheint oft in Vorlagen mit umgebenden Unterstrichen, Punkten oder Strichen, etwa:
- "__________1.100,00 €"
- ". . . . . . . 1.950,00 Euro"
- "in Höhe von _____ Euro"

Suche im gesamten Dokument nach diesen Bezeichnungen und extrahiere den genannten Betrag, unabhängig von der umgebenden Formatierung. Der Betrag ist real auch dann, wenn das Vertragsformular Leerstellen oder Platzhalter um die Zahl herum aufweist.

Extract the TOTAL kaution amount, not an installment. If the contract says "Kaution: 3 Monatsmieten" without a euro figure, set absence_state: ambiguous.
If the contract is kautionsfrei, set absence_state: not_applicable.
Falls KEINE dieser Bezeichnungen im Dokument vorkommt, setze absence_state: "absent".
Falls die Bezeichnung vorkommt aber kein Betrag genannt wird, setze absence_state: "ambiguous" mit einer Erklärung.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 195000, currency: "EUR" } for €1,950.00.

### mietbeginn (Mietbeginn — lease start date)

Extract the date the lease takes effect.
normalized_value: ISO 8601 (YYYY-MM-DD). Source is typically DD.MM.YYYY — normalize.
If the contract specifies "ab Übergabe" or similar without a concrete date, set absence_state: ambiguous.

### mietende (Mietende — lease end date, optional)

Most German residential leases are open-ended (unbefristet). For those, set absence_state: not_applicable. NOT absence_state: absent — the difference is meaningful.
If the contract specifies a fixed end date (Befristung), extract it. Format: ISO 8601 (YYYY-MM-DD).`;

export const SCHEMA_VERSION = "2026-05-21-v1";
export const DOC_TYPE = "mietvertrag";
