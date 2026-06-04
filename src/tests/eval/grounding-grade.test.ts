// Evidence-grounding GRADE tests (Task 4.3a).
// Pure, deterministic, no LLM, no DB. Synthetic OCR + hand-built specs assert
// each grade (3/2/1/0), the same-page constraint, the kaltmiete label-trap
// (Monatsmiete must NOT ground), the table-header lookback, the critical-field
// evidence.page cap, and derived/non-scalar exclusion. Also asserts the
// generated GROUNDING_SPECS carry the expected (non-hardcoded) label sets.

import assert from "node:assert/strict";

import {
  groundingGrade,
  parseOcrPages,
  summarizeGrounding,
  valueSurfaceForms,
} from "../../../scripts/eval/metrics.ts";
import { GROUNDING_SPECS } from "../../../schemas/mietvertrag/generated/field_specs.ts";
import type { FieldEnvelope, GroundingSpec } from "../../../scripts/eval/types.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

// kaltmiete spec mirrors the generated GROUNDING_SPECS (critical, money,
// scalar). Overridable for the cap / exclusion cases.
function kaltmieteSpec(over: Partial<GroundingSpec> = {}): GroundingSpec {
  return {
    id: "kaltmiete",
    severity: "critical",
    type: "money",
    scalar: true,
    derived: false,
    labels: ["Kaltmiete", "Grundmiete", "Nettokaltmiete", "Nettomiete"],
    ...over,
  };
}

// A present money candidate of `amount` minor units. `page` controls the
// evidence page (null => evidence carries no page).
function money(amount: number, page: number | null): FieldEnvelope {
  return {
    raw_value: null,
    normalized_value: { amount, currency: "EUR" },
    absence_state: "present",
    evidence: [page != null ? { quote: "irrelevant", page, bbox: null } : { quote: "irrelevant" }],
  };
}

// ── Grade 3: value in same-page window with a field-specific label ─────────
{
  const ocr = "--- Seite 1 ---\nKaltmiete: 650,00 €\nMieter: Lena Everding";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 3, "grade 3: value + Kaltmiete label in same-page window");
  eq(r.matched_label, "Kaltmiete", "grade 3: matched label is Kaltmiete");
  eq(r.value_page, 1, "grade 3: value located on page 1");
  ok(r.graded && r.excluded === null, "grade 3: field is graded");
}

// Grade 3 via a synonym (Grundmiete) — the brief's accepted label set.
{
  const ocr = "--- Seite 1 ---\nGrundmiete                650,00 Euro";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 3, "grade 3: Grundmiete synonym grounds kaltmiete");
  eq(r.matched_label, "Grundmiete", "grade 3: matched synonym Grundmiete");
}

// ── Grade 2: value present in window, no field-specific label nearby ───────
{
  const ocr = "--- Seite 1 ---\nGesamtbetrag: 650,00 €\nSonstiges";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 2, "grade 2: value in window, no kaltmiete label nearby");
  eq(r.matched_label, null, "grade 2: no matched label");
}

// ── Label-trap: Monatsmiete must NOT ground kaltmiete (stays grade 2) ──────
{
  const ocr = "--- Seite 1 ---\nMonatsmiete: 650,00 €";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 2, "label-trap: Monatsmiete does not lift kaltmiete to grade 3");
  eq(r.matched_label, null, "label-trap: no field-specific label matched");
}
// The broad token "Miete" inside "Grundmiete"/"Monatsmiete" must not match the
// label "Miete" — and "Miete" is not even in the set. Confirm a bare "Miete"
// header also does not ground.
{
  const ocr = "--- Seite 1 ---\nMiete: 650,00 €";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 2, "label-trap: bare 'Miete' does not ground kaltmiete");
}

// ── Grade 1: value somewhere in OCR but not on the evidence page ───────────
{
  // Value + label live on page 1; candidate evidence claims page 2.
  const ocr = "--- Seite 1 ---\nKaltmiete: 650,00 €\n--- Seite 2 ---\nKeine Beträge hier";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 2), ocr);
  eq(r.grade, 1, "grade 1: value in OCR but not on the scoped page");
}

// ── Same-page constraint: value on wrong page is NOT grade 3 ───────────────
{
  const ocr = "--- Seite 1 ---\nKaltmiete: 650,00 €\n--- Seite 2 ---\nFülltext";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 2), ocr);
  ok(r.grade !== 3, "same-page: value on page 1 with evidence.page=2 is not grade 3");
}

// ── Grade 0: value not in OCR at all ──────────────────────────────────────
{
  const ocr = "--- Seite 1 ---\nKaltmiete: 999,00 €";
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 0, "grade 0: candidate value absent from OCR");
}

// ── Table-header lookback: label up to 10 lines above the value cell ───────
{
  // "Grundmiete" header on line 0; value on line 9 (9 lines below, within the
  // previous-10 lookback but outside the direct ±5 downward window).
  const body = ["Grundmiete", "a", "b", "c", "d", "e", "f", "g", "h", "650,00 €"].join("\n");
  const ocr = `--- Seite 1 ---\n${body}`;
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), ocr);
  eq(r.grade, 3, "table lookback: header 9 lines above grounds the value cell");
  eq(r.matched_label, "Grundmiete", "table lookback: matched header label");
}

// ── Critical-field cap: evidence.page missing caps at 2 even with a label ──
{
  const ocr = "--- Seite 1 ---\nKaltmiete: 650,00 €";
  const r = groundingGrade(kaltmieteSpec(), money(65000, null), ocr);
  eq(r.grade, 2, "critical cap: missing evidence.page caps kaltmiete at grade 2");
  eq(r.evidence_page_present, false, "critical cap: evidence_page_present is false");
}
// Non-critical field with missing evidence.page is NOT capped.
{
  const kautionSpec: GroundingSpec = {
    id: "kaution",
    severity: "important",
    type: "money",
    scalar: true,
    derived: false,
    labels: ["Kaution", "Mietsicherheit", "Barkaution", "Sicherheitsleistung"],
  };
  const ocr = "--- Seite 1 ---\nKaution                1.950,00 €";
  const r = groundingGrade(kautionSpec, money(195000, null), ocr);
  eq(r.grade, 3, "no cap: important field with missing evidence.page still reaches 3");
}

// ── Exclusions: derived and non-scalar fields get no numeric grade ─────────
{
  const r = groundingGrade(kaltmieteSpec({ id: "unit_ref", derived: true }), money(65000, 1), "--- Seite 1 ---\nx");
  eq(r.graded, false, "derived: not graded");
  eq(r.grade, null, "derived: grade is null");
  eq(r.excluded, "derived_pending", "derived: excluded as derived_pending");
}
{
  const r = groundingGrade(
    kaltmieteSpec({ id: "tenant_identity", type: "structured", scalar: false }),
    money(65000, 1),
    "--- Seite 1 ---\nx",
  );
  eq(r.excluded, "non_scalar", "non-scalar: excluded as non_scalar");
}
{
  const absent: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const r = groundingGrade(kaltmieteSpec(), absent, "--- Seite 1 ---\nx");
  eq(r.excluded, "absent", "absent candidate: excluded as absent");
}
{
  const r = groundingGrade(kaltmieteSpec(), money(65000, 1), undefined);
  eq(r.excluded, "no_ocr", "no OCR: excluded as no_ocr");
}

// ── parseOcrPages: page markers split correctly, never cross ──────────────
{
  const pages = parseOcrPages("--- Seite 1 ---\nA\nB\n--- Seite 2 ---\nC");
  eq(pages.length, 2, "parseOcrPages: two pages");
  eq(pages[0].page, 1, "parseOcrPages: first is page 1");
  eq(pages[1].page, 2, "parseOcrPages: second is page 2");
  eq(pages[1].lines.includes("C"), true, "parseOcrPages: page 2 holds its content");
  eq(pages[0].lines.includes("C"), false, "parseOcrPages: content does not leak across pages");
}

// ── valueSurfaceForms: money + date normalization equivalences ────────────
{
  const m = valueSurfaceForms(money(65000, 1), "money");
  ok(m.includes("650,00"), "surface forms: money 650,00");
  ok(m.includes("650.00"), "surface forms: money 650.00");
  const grouped = valueSurfaceForms(money(195000, 1), "money");
  ok(grouped.includes("1.950,00"), "surface forms: money grouped 1.950,00");
  const date: FieldEnvelope = {
    raw_value: "01.04.2025",
    normalized_value: "2025-04-01",
    absence_state: "present",
    evidence: [{ quote: "x", page: 1 }],
  };
  const d = valueSurfaceForms(date, "date");
  ok(d.includes("01.04.2025"), "surface forms: date 01.04.2025");
  ok(d.includes("1. april 2025") || d.includes("1. April 2025"), "surface forms: date long form");
}

// ── summarizeGrounding: aggregate over graded fields only ─────────────────
{
  const s = summarizeGrounding([
    { field_id: "a", severity: "critical", graded: true, grade: 3, excluded: null, matched_label: "X", value_page: 1, evidence_page_present: true },
    { field_id: "b", severity: "important", graded: true, grade: 1, excluded: null, matched_label: null, value_page: 1, evidence_page_present: true },
    { field_id: "unit_ref", severity: "critical", graded: false, grade: null, excluded: "derived_pending", matched_label: null, value_page: null, evidence_page_present: false },
  ]);
  eq(s.graded_count, 2, "summarize: 2 graded fields (derived excluded)");
  eq(s.grade_mean, 2, "summarize: grade_mean (3+1)/2 = 2");
  eq(s.grade3_rate, 0.5, "summarize: grade3_rate 1/2");
  eq(s.derived_pending, ["unit_ref"], "summarize: derived_pending lists unit_ref");
}

// ── Generated GROUNDING_SPECS carry the expected (non-hardcoded) label sets ─
{
  eq(GROUNDING_SPECS.kaltmiete.labels.includes("Grundmiete"), true, "specs: kaltmiete grounds on Grundmiete");
  eq(GROUNDING_SPECS.kaltmiete.labels.includes("Nettokaltmiete"), true, "specs: kaltmiete grounds on Nettokaltmiete");
  eq(GROUNDING_SPECS.kaltmiete.labels.includes("Monatsmiete"), false, "specs: kaltmiete does NOT list Monatsmiete");
  eq(GROUNDING_SPECS.kaltmiete.labels.includes("Warmmiete"), false, "specs: kaltmiete does NOT list Warmmiete");
  eq(GROUNDING_SPECS.unit_ref.derived, true, "specs: unit_ref is derived (derived_pending)");
  eq(GROUNDING_SPECS.tenant_identity.scalar, false, "specs: tenant_identity is non-scalar");
}

// ══ Identity grounding (Task 4.3a-names) ══════════════════════════════════
// tenant_identity / landlord_identity now carry a 0–3 grade via person/company
// grounding on a ROLE anchor (Mieter / Vermieter), same window rules as 4.3a.

function tenantSpec(over: Partial<GroundingSpec> = {}): GroundingSpec {
  return {
    id: "tenant_identity",
    severity: "critical",
    type: "structured",
    scalar: false,
    derived: false,
    labels: ["Mieter"],
    ...over,
  };
}
function landlordSpec(over: Partial<GroundingSpec> = {}): GroundingSpec {
  return {
    id: "landlord_identity",
    severity: "critical",
    type: "structured",
    scalar: false,
    derived: false,
    labels: ["Vermieter"],
    ...over,
  };
}
// A present person identity. `page` controls the evidence page (null => none).
function person(name: string, page: number | null): FieldEnvelope {
  return {
    raw_value: name,
    normalized_value: { name, is_legal_entity: false, legal_form: null },
    absence_state: "present",
    evidence: [page != null ? { quote: "x", page, bbox: null } : { quote: "x" }],
  };
}
// A present company identity with a legal-form suffix.
function company(name: string, legalForm: string, page: number | null): FieldEnvelope {
  return {
    raw_value: name,
    normalized_value: { name, is_legal_entity: true, legal_form: legalForm },
    absence_state: "present",
    evidence: [page != null ? { quote: "x", page, bbox: null } : { quote: "x" }],
  };
}

// ── tenant grounds via the "Mieter" role anchor → grade 3 ──────────────────
{
  const ocr = "--- Seite 1 ---\nMieter\nName, Vorname\nEverding, Lena";
  const r = groundingGrade(tenantSpec(), person("Everding, Lena", 1), ocr);
  eq(r.grade, 3, "identity: tenant grounds via Mieter role anchor");
  eq(r.matched_label, "Mieter", "identity: tenant matched role is Mieter");
  eq(r.value_page, 1, "identity: tenant value located on page 1");
}

// ── Role-mismatch trap: tenant value under "Vermieter" is NOT grade 3 ──────
{
  const ocr = "--- Seite 1 ---\nVermieter\nEverding, Lena";
  const r = groundingGrade(tenantSpec(), person("Everding, Lena", 1), ocr);
  ok(r.grade !== 3, "role-mismatch: tenant under Vermieter is not grade 3");
  eq(r.grade, 2, "role-mismatch: tenant under wrong-side role is weak grade 2");
  eq(r.matched_label, null, "role-mismatch: no role anchor matched");
}

// ── Company: distinctive name + GbR suffix grounds under "Vermieter" → 3 ───
{
  const ocr = "--- Seite 1 ---\nVermieter\nDenn & Denn Verwaltungs GbR";
  const r = groundingGrade(landlordSpec(), company("Denn & Denn Verwaltungs GbR", "GbR", 1), ocr);
  eq(r.grade, 3, "identity: company name + GbR suffix grounds under Vermieter");
  eq(r.matched_label, "Vermieter", "identity: company matched role is Vermieter");
}
// A bare "Denn" surname line (no Verwaltungs/GbR) must NOT match the company.
{
  const ocr = "--- Seite 1 ---\nVermieter\nDenn, Thomas";
  const r = groundingGrade(landlordSpec(), company("Denn & Denn Verwaltungs GbR", "GbR", 1), ocr);
  ok(r.grade !== 3, "identity: a lone 'Denn' surname does not ground the GbR company");
}

// ── Bare signature-block name (value present, no role label) → grade 2 ─────
{
  const ocr = "--- Seite 1 ---\nUnterschriften\nEverding, Lena";
  const r = groundingGrade(tenantSpec(), person("Everding, Lena", 1), ocr);
  eq(r.grade, 2, "identity: bare signature-block name (no role) is grade 2");
  eq(r.matched_label, null, "identity: signature-only has no role anchor");
}

// ── Grade 0: identity value not in OCR ─────────────────────────────────────
{
  const ocr = "--- Seite 1 ---\nMieter\nSchmidt, Otto";
  const r = groundingGrade(tenantSpec(), person("Everding, Lena", 1), ocr);
  eq(r.grade, 0, "identity: tenant value absent from OCR is grade 0");
}

// ── Umlaut normalization: "Müller" grounds on "Mueller" ────────────────────
{
  const ocr = "--- Seite 1 ---\nMieter\nMueller, Anna";
  const r = groundingGrade(tenantSpec(), person("Müller, Anna", 1), ocr);
  eq(r.grade, 3, "identity: umlaut-normalized surname (Müller=Mueller) grounds");
}

// ── "Given Surname" order also grounds (no comma in the value) ─────────────
{
  const ocr = "--- Seite 1 ---\nMieter\nLena Everding";
  const r = groundingGrade(tenantSpec(), person("Lena Everding", 1), ocr);
  eq(r.grade, 3, "identity: 'Given Surname' order grounds via surname+given tokens");
}

// ── Critical-field cap: missing evidence.page caps an identity at 2 ────────
{
  const ocr = "--- Seite 1 ---\nMieter\nEverding, Lena";
  const r = groundingGrade(tenantSpec(), person("Everding, Lena", null), ocr);
  eq(r.grade, 2, "identity cap: missing evidence.page caps critical identity at 2");
  eq(r.evidence_page_present, false, "identity cap: evidence_page_present is false");
}

// ── A present but NON-identity value on an identity field stays excluded ───
// (keeps the 4.3a non_scalar contract for malformed payloads).
{
  const money: FieldEnvelope = {
    raw_value: null,
    normalized_value: { amount: 65000, currency: "EUR" },
    absence_state: "present",
    evidence: [{ quote: "x", page: 1 }],
  };
  const r = groundingGrade(tenantSpec(), money, "--- Seite 1 ---\nMieter\n650,00");
  eq(r.excluded, "non_scalar", "identity: non-identity value falls through to non_scalar");
}

// ── An absent identity is excluded as absent (not non_scalar) ──────────────
{
  const absent: FieldEnvelope = { raw_value: null, normalized_value: null, absence_state: "absent" };
  const r = groundingGrade(landlordSpec(), absent, "--- Seite 1 ---\nVermieter");
  eq(r.excluded, "absent", "identity: absent identity excluded as absent");
}

console.log(`✓ grounding-grade.test.ts: ${assertions} assertions passed`);
