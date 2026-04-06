/**
 * Structured extraction schemas for document types.
 *
 * Each doc_type that needs structured field extraction gets its own entry
 * in STRUCTURED_PROMPTS. The fragment returns a German-language prompt
 * snippet that instructs the model to include a `structured_fields` object
 * in its JSON response.
 *
 * To add a new doc_type:
 *   1. Add a new entry to STRUCTURED_PROMPTS keyed by the doc_type slug.
 *   2. Bump EXTRACTION_SCHEMA_VERSION so downstream consumers know the
 *      schema has changed.
 */

export const EXTRACTION_SCHEMA_VERSION = "2026-04-06-v1";

export type StructuredPromptFragment = () => string;

export const STRUCTURED_PROMPTS: Record<string, StructuredPromptFragment> = {
  grundbuchauszug: () => `
Füge dem JSON-Ergebnis ein Objekt "structured_fields" mit folgenden Feldern hinzu.
Alle Felder sind nullable – verwende null, wenn ein Wert im Dokument nicht vorhanden ist.
Verwende Arrays für mehrere Einträge (keine kommaseparierten Strings).

structured_fields:
- schema_version: string – muss exakt "${EXTRACTION_SCHEMA_VERSION}" sein
- grundbuchamt: string | null – Name des zuständigen Grundbuchamts
- blatt_nummer: string | null – Blattnummer im Grundbuch
- gemarkung: string | null – Gemarkung
- flurstueck: string | null – Flurstück-Bezeichnung
- laufende_nummer_bv: string | null – Laufende Nummer im Bestandsverzeichnis
- eigentuemer: string | null – Name des/der Eigentümer
- eigentumsart: string | null – Art des Eigentums (z.B. Alleineigentum, Miteigentum)
- anteil_miteigentum: string | null – Miteigentumsanteil (z.B. "1/2")
- sondereigentum_beschreibung: string | null – Beschreibung des Sondereigentums
- abteilung_zwei_text: string | null – Volltext Abteilung II (Lasten und Beschränkungen)
- abteilung_drei_text: string | null – Volltext Abteilung III (Hypotheken, Grundschulden, Rentenschulden)
- belastet_mit_grundschuld: boolean | null – true wenn eine Grundschuld eingetragen ist
- stand_datum: string | null – Datum des Auszugs im Format YYYY-MM-DD
- grundpfandrechte: Array von Objekten mit:
    - art: string – Art des Grundpfandrechts (z.B. "Grundschuld", "Hypothek")
    - betrag: number – Betrag als Zahl
    - waehrung: string – "DEM" oder "EUR"
    - glaeubiger: string – Name des Gläubigers
    - rang: number – Rang der Eintragung
  Falls keine Grundpfandrechte vorhanden sind, verwende ein leeres Array [].
`.trim(),
};
