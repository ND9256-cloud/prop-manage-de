// src/lib/extraction-display.ts — pure display-row builder for triage overlay
// Maps v2 envelopes and legacy extracted_fields to uniform DisplayRow[].
//
// PURITY CONSTRAINT: No imports from react, prisma, supabase, or next.
// This module is tested in src/tests/triage-document-shape.test.ts.

export type DisplayRow = {
  fieldId: string;
  label: string;
  display: string;
  rawValue: unknown;
  absenceState?: string;
  severity?: string;
  editable: boolean;
};

// ─── V2 field definitions per doc_type ─────────────────────────

type V2FieldDef = {
  fieldId: string;
  label: string;
  format: (normalizedValue: unknown) => string;
};

function formatMoney(nv: unknown): string {
  if (nv == null) return "";
  if (typeof nv === "object" && nv !== null && "amount" in nv) {
    const obj = nv as { amount: number; currency?: string };
    const euros = obj.amount / 100;
    const formatted = euros.toLocaleString("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${obj.currency ?? "EUR"}`;
  }
  return String(nv);
}

function formatDate(nv: unknown): string {
  if (nv == null || typeof nv !== "string") return "";
  const m = nv.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return nv;
}

function formatString(nv: unknown): string {
  if (nv == null) return "";
  return String(nv);
}

function formatTenantIdentity(nv: unknown): string {
  if (nv == null) return "";
  if (typeof nv === "object" && nv !== null && "name" in nv) {
    return (nv as { name: string }).name;
  }
  return String(nv);
}

const V2_FIELDS: Record<string, V2FieldDef[]> = {
  mietvertrag: [
    { fieldId: "kaltmiete", label: "Kaltmiete", format: formatMoney },
    { fieldId: "unit_ref", label: "Einheit", format: formatString },
    { fieldId: "tenant_identity", label: "Mieter", format: formatTenantIdentity },
    { fieldId: "mietbeginn", label: "Mietbeginn", format: formatDate },
    { fieldId: "mietende", label: "Mietende", format: formatDate },
  ],
};

// Absence state → display text mapping
const ABSENCE_DISPLAY: Record<string, string> = {
  absent: "\u2014 (nicht im Dokument)",
  illegible: "\u2014 (unleserlich)",
  ambiguous: "\u2014 (mehrdeutig)",
  contradicted: "\u2014 (widerspr\u00fcchlich)",
  inferred: "\u2014 (abgeleitet)",
  requires_human_review: "\u2014 (Pr\u00fcfung erforderlich)",
};

// ─── Legacy field label map ────────────────────────────────────

const LEGACY_LABELS: Record<string, string> = {
  vendor_name: "Anbieter",
  amount: "Betrag",
  invoice_date: "Datum",
  invoice_number: "Rechnungsnr.",
  description: "Beschreibung",
  currency: "W\u00e4hrung",
  tenant_first_name: "Vorname Mieter",
  tenant_last_name: "Nachname Mieter",
  tenant_email: "E-Mail Mieter",
  rent_cold: "Kaltmiete",
  rent_warm: "Warmmiete",
  deposit: "Kaution",
  lease_start: "Mietbeginn",
  lease_end: "Mietende",
  unit_ref: "Einheit",
  unit_hint: "Einheit (Hinweis)",
  address_hint: "Adresshinweis",
  key_dates: "Wichtige Daten",
  key_amounts: "Wichtige Betr\u00e4ge",
  summary: "Zusammenfassung",
  category_hint: "Kategorie-Hinweis",
  parties_mentioned: "Beteiligte",
  inspection_date: "Besichtigungsdatum",
  condition_summary: "Zustandsbeschreibung",
  damages: "Sch\u00e4den",
  meter_readings: "Z\u00e4hlerst\u00e4nde",
};

const LEGACY_MONEY_FIELDS = new Set(["amount", "rent_cold", "rent_warm", "deposit"]);
const LEGACY_DATE_FIELDS = new Set(["invoice_date", "lease_start", "lease_end", "inspection_date"]);

function formatLegacyValue(fieldId: string, value: unknown): string {
  const str = String(value);
  if (LEGACY_MONEY_FIELDS.has(fieldId)) {
    const num = parseFloat(str.replace(/[^\d.,-]/g, "").replace(",", "."));
    if (!isNaN(num)) {
      return (
        num.toLocaleString("de-DE", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }) + " EUR"
      );
    }
  }
  if (LEGACY_DATE_FIELDS.has(fieldId)) {
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  return str;
}

// ─── Public API ────────────────────────────────────────────────

export function buildDisplayRows(
  input:
    | { kind: "v2"; envelope: Record<string, unknown>; docType: string }
    | { kind: "legacy"; extractedFields: Record<string, unknown>; docType?: string }
): DisplayRow[] {
  if (input.kind === "v2") {
    return buildV2Rows(input.envelope, input.docType);
  }
  return buildLegacyRows(input.extractedFields);
}

function buildV2Rows(envelope: Record<string, unknown>, docType: string): DisplayRow[] {
  const defs = V2_FIELDS[docType];
  if (!defs) return [];

  const rows: DisplayRow[] = [];
  for (const def of defs) {
    const field = envelope[def.fieldId] as Record<string, unknown> | undefined;
    if (!field) continue;

    const absenceState = field.absence_state as string | undefined;

    // not_applicable → omit entirely
    if (absenceState === "not_applicable") continue;

    // Non-present states (except not_applicable) → show placeholder
    if (absenceState && absenceState !== "present") {
      rows.push({
        fieldId: def.fieldId,
        label: def.label,
        display: ABSENCE_DISPLAY[absenceState] ?? `\u2014 (${absenceState})`,
        rawValue: null,
        absenceState,
        severity: field.severity as string | undefined,
        editable: false,
      });
      continue;
    }

    // Present → format the normalized_value
    rows.push({
      fieldId: def.fieldId,
      label: def.label,
      display: def.format(field.normalized_value),
      rawValue: field.normalized_value,
      absenceState,
      severity: field.severity as string | undefined,
      editable: false,
    });
  }

  return rows;
}

function buildLegacyRows(extractedFields: Record<string, unknown>): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const [key, value] of Object.entries(extractedFields)) {
    if (!(key in LEGACY_LABELS)) continue;
    if (value == null || String(value).trim() === "") continue;

    rows.push({
      fieldId: key,
      label: LEGACY_LABELS[key],
      display: formatLegacyValue(key, value),
      rawValue: value,
      editable: true,
    });
  }
  return rows;
}
