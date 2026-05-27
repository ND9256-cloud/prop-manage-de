// DO NOT EDIT — generated from schemas/mieterhoehung/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-27-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `## Mieterhöhung — extract the following fields

For each field, return:
- raw_value: verbatim text from the document
- normalized_value: typed canonical form (see per-field instructions)
- evidence: array of { quote: <verbatim quote>, page: <number>, bbox: null }. At least one entry required when absence_state == "present".
- confidence: high | medium | low
- absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
- validation_status: valid (set this; verifiers run separately)

Evidence is MANDATORY when absence_state == present. The evidence array must contain at least one entry. Do not set a value without supporting evidence quotes.

### nachtrag_typ (document classification marker)

Classify the document into exactly one of:
- "mieterhoehung" — a unilateral §558/§559 rent-increase notice from the landlord.
- "mietvertragsnachtrag_rent_change" — a bilateral amendment (both parties sign) that changes the rent.
- "mietvertragsnachtrag_other" — a non-rent amendment (pet clause, parking, ancillary-cost reallocation). This should NOT reach the Mieterhöhung emitter; flag it for reclassification.

### rechtsgrundlage (legal grounds for the increase)

One of: "§558" (Vergleichsmieten), "§559" (Modernisierung), "indexmiete" (§560), "staffelmiete" (§557a), "bilateral" (both-party signed amendment), "unspecified". Drives downstream cap-rule and form-requirement interpretation; not used by the emitter for emission decisions.

### new_kaltmiete (the new base rent after the increase, EUR)

The new Kaltmiete that takes effect on effective_date. Base rent only, excluding Nebenkosten.
normalized_value: integer in minor units (cents) + currency code, e.g. { amount: 57500, currency: "EUR" } for €575.00.

### previous_kaltmiete (the base rent being superseded, EUR, optional)

The prior Kaltmiete the increase supersedes. Used downstream for Kappungsgrenze evaluation.
normalized_value: { amount: <cents>, currency: "EUR" }.

### effective_date (date the new rent takes effect)

The date from which the new Kaltmiete applies. normalized_value: ISO 8601 (YYYY-MM-DD). Source is typically DD.MM.YYYY — normalize. Drives the new claim's valid_from and the closure edge (effective_date - 1 day). Do NOT substitute notice_date when this is missing.

### notice_date (date the increase notice was issued, optional)

Informational only; never used for emission. normalized_value: ISO 8601 (YYYY-MM-DD).

### unit_ref (Einheit — normalized floor/position identifier)

Normalize to one of: EG, 1.OG, 2.OG, 3.OG, 4.OG, DG, Keller, Souterrain. Must match the unit_ref of the Mietvertrag being amended. Extract from the filled-in unit specification, not from template boilerplate.

### tenant_identity (Mieter — the tenant party to the lease being amended)

normalized_value: { name: <full name as written>, is_legal_entity: <bool>, legal_form: <optional string for entities> }. Used for closure match (optional strictness).

### landlord_signature_present (boolean)

true if the document carries a landlord signature. For §558/§559 this is the legally-required signature and the emitter's closure prerequisite.

### tenant_signature_present (boolean)

true if the document carries a tenant signature. Required only for bilateral rent-change amendments; informational for §558/§559.

### document_status (lifecycle state)

One of: draft, unsigned, signed, executed. The emitter requires "signed" or "executed" to emit a closure intent.

### staffelmiete_context (boolean heuristic)

true if the document text indicates the unit is on a Staffelmiete schedule (references a Staffelplan, or explicitly supersedes a Staffel step). The emitter uses this to pre-flag the closure for review; the applier also re-checks the claim store independently.`;

export const SCHEMA_VERSION = "2026-05-27-v1";
export const DOC_TYPE = "mieterhoehung";
