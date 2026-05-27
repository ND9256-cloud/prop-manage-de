// DO NOT EDIT — generated from schemas/wohnungsuebergabeprotokoll/schema.yaml
// Generator: scripts/gen-schemas.ts
// Schema version: 2026-05-27-v1
// Run `npm run gen:schemas` to regenerate.

export const PROMPT_FRAGMENT = `## Wohnungsübergabeprotokoll — extract the following fields

For each field, return:
- raw_value: verbatim text from the document
- normalized_value: typed canonical form (see per-field instructions)
- evidence: array of { quote: <verbatim quote>, page: <number>, bbox: null }. At least one entry required when absence_state == "present".
- confidence: high | medium | low
- absence_state: present | absent | illegible | ambiguous | contradicted | not_applicable | inferred | requires_human_review
- validation_status: valid (set this; verifiers run separately)

Evidence is MANDATORY when absence_state == present.

### uebergabe_typ (CRITICAL discriminator — determines all downstream behavior)

Classify into exactly one of:
- "Einzug" — a tenant moves IN. Signals: tenant signature with "übernehme die Wohnung", Übergabe-/Einzugsdatum, meter readings as starting baselines.
- "Auszug" — a tenant moves OUT. Signals: "Rückgabe"/"Wohnungsrückgabe" language, tenant signature with "übergebe die Wohnung", often documents damages, meter readings as closing values.
- "Eigentümerwechsel" — property OWNERSHIP transfers. Signals: Käufer and Verkäufer named, reference to a Kaufvertrag, typically NO Mieter signature (or Mieter only as bystander), identifies the property rather than a specific unit.
- "unklar" — document does not clearly signal one of the above. SAFE DEFAULT when in doubt. Forces human review. Emitter skips claim emission entirely.

When signals conflict or are missing, choose "unklar". Better no claim than a wrong claim. The Hofmann case (misclassified Eigentümerwechsel) is the canonical failure to avoid.

### unit_ref (Einheit — normalized floor/position identifier)

Required for Einzug and Auszug. Optional for Eigentümerwechsel (which is property-level). Normalize to: EG, 1.OG, 2.OG, 3.OG, 4.OG, DG, Keller, Souterrain. Common variants: "Erdgeschoss" → "EG", "1. Obergeschoss" → "1.OG", "Dachgeschoss" → "DG".

### uebergabe_datum (date the handover physically occurred)

ISO 8601 (YYYY-MM-DD). Drives valid_from on new claims and close_at on closure intents. Source is typically DD.MM.YYYY — normalize. Distinct from notarial signing date (for Eigentümerwechsel, the Kaufvertrag's date is typically earlier than the handover).

### kaeufer (incoming owner — required when uebergabe_typ == "Eigentümerwechsel")

normalized_value: { name: <full name as written>, is_legal_entity: <bool>, legal_form: <e.g. "GmbH", "eGbR", "KG"> }. May be a natural person or legal entity.

### verkaeufer (outgoing owner — required when uebergabe_typ == "Eigentümerwechsel")

normalized_value: { name, is_legal_entity, legal_form }. Used for owner-closure match — verkaeufer must match the current owner claim being superseded.

### mieter_in (incoming tenant — required when uebergabe_typ == "Einzug")

normalized_value: { name, is_legal_entity, legal_form }. Becomes the new tenant_active claim.

### mieter_out (outgoing tenant — required when uebergabe_typ == "Auszug")

normalized_value: { name, is_legal_entity, legal_form }. Used for tenant-claim closure match (required strictness).

### vacant_possession_language_present (boolean — Hofmann safeguard signal)

true if the document contains language asserting vacant possession (mietfrei, geräumt, bezugsfrei, "ohne Mietverhältnis", "frei von Mietern", "leerstehend"). ADVISORY ONLY — the applier emits an occupancy_conflict warning event but never closes tenant claims on this signal alone. The Hofmann safeguard codified.

### vacant_possession_language_excerpts (array of verbatim excerpts, when applicable)

Populated only when vacant_possession_language_present == true. Used by triage UI to show humans the exact source language. Verbatim from the document.

### meter_readings (Zählerstände — evidence, not claims)

Structured per-meter readings: { meter_type: "Strom"|"Gas"|"Wasser"|"Heizung"|"Wärmemenge", meter_serial, reading_value, reading_unit, reading_date }. Stored as evidence baseline; not directly emitted as claims at launch (Phase 2+ scope).

### damages_noted (Mängel / Schäden — informational)

Structured deficiencies: { location, description, severity (gering|mittel|erheblich), photo_reference (optional) }. Surfaces in triage and downstream reports; not used by emitter.

### signatures (signature presence per role)

Booleans for mieter, vermieter, kaeufer, verkaeufer signature presence. Drives form-validity downstream; the emitter uses uebergabe_datum + uebergabe_typ + relevant party identity rather than signature presence directly.`;

export const SCHEMA_VERSION = "2026-05-27-v1";
export const DOC_TYPE = "wohnungsuebergabeprotokoll";
