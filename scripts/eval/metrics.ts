// Deterministic, no-LLM metrics module for the eval harness (architecture §13.2).
//
// Every function in this file is pure: identical inputs produce identical outputs.
// No I/O, no model calls. Tested in src/tests/eval/metrics.test.ts.

import type {
  AbsenceState,
  DocTypeMetricSummary,
  Evidence,
  EvidenceQuote,
  ExtractionEnvelope,
  FieldEnvelope,
  FieldGroundingResult,
  FieldMetricResult,
  GroundingGrade,
  GroundingSpec,
  GroundingSummary,
  SchemaFieldDef,
  Severity,
  TableCellEvidence,
} from "./types.ts";
import {
  applyDerivationRule,
  isDerivationRule,
  tableCellAllowed,
  tableCellRuleAllowed,
  type DerivationRule,
} from "./derivation-rules.ts";

// Discriminates the optional-tagged evidence union (default → direct_quote).
function isTableCellEvidence(e: Evidence): e is TableCellEvidence {
  return (e as { evidence_type?: string }).evidence_type === "table_cell";
}

// Severity weights for the severity-weighted error rate.
// Critical errors count 5x a nice-to-have error. The choice of weights
// is documented; the exact ratio is not load-bearing.
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 5,
  important: 2,
  nice_to_have: 1,
};

function severityWeight(s: Severity): number {
  return SEVERITY_WEIGHT[s];
}

// ── exact_match ──────────────────────────────────────────────────────────
// raw_value string equality. Both null/undefined counts as a match
// (used when gold is absent and candidate correctly omits the value).
export function exactMatch(gold: FieldEnvelope, candidate: FieldEnvelope | undefined): boolean {
  if (!candidate) return gold.raw_value == null;
  if (gold.raw_value == null && candidate.raw_value == null) return true;
  if (gold.raw_value == null || candidate.raw_value == null) return false;
  return String(gold.raw_value) === String(candidate.raw_value);
}

// ── normalized_match ─────────────────────────────────────────────────────
// Canonical deep-equal of normalized_value. Object keys are sorted before
// comparison so { a: 1, b: 2 } == { b: 2, a: 1 }. Numbers compared by
// value, NOT by string representation (so 65000 != "65000" — that's a
// schema-type bug, not a normalization equivalence).
export function normalizedMatch(gold: FieldEnvelope, candidate: FieldEnvelope | undefined): boolean {
  if (!candidate) return gold.normalized_value == null;
  return deepEqual(gold.normalized_value, candidate.normalized_value);
}

// Internal: deterministic deep-equal. Arrays compared positionally.
// Objects compared by sorted keys. Primitives compared with ===.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(aObj[aKeys[i]], bObj[bKeys[i]])) return false;
  }
  return true;
}

// ── evidence_grounded ────────────────────────────────────────────────────
// True iff candidate evidence array contains at least one entry whose
// quote appears verbatim in the source OCR text. Whitespace is normalized
// before substring search (runs of whitespace -> single space) so that
// PDF-extracted quotes with newlines still match the OCR text.
//
// Architecture: the 4.5 critic handles semantic "does this quote justify
// the value?" — this metric only checks that the candidate didn't
// hallucinate the quote.
//
// Special cases:
// - If gold absence_state != "present", evidence is not required. Return
//   true iff candidate evidence is also absent.
// - If candidate has no evidence array or it is empty when present is
//   claimed, return false.
export function evidenceGrounded(
  gold: FieldEnvelope,
  candidate: FieldEnvelope | undefined,
  ocrText: string | undefined
): boolean {
  if (!candidate) {
    // No candidate; valid only if gold was also absent.
    return gold.absence_state !== "present";
  }
  if (candidate.absence_state !== "present") {
    // Candidate is not asserting a value — vacuously grounded.
    return true;
  }
  const evidence = candidate.evidence ?? [];
  if (evidence.length === 0) return false;
  // Without source text we cannot verify groundedness. Be conservative
  // and treat missing source as "not grounded" so the harness can flag
  // the gap. Score mode passes ocrText=undefined when fixtures lack
  // source documents — see scripts/eval/loader.ts.
  if (!ocrText) return false;
  const normalizedSource = normalizeWhitespace(ocrText);
  return evidence.some((e) => {
    // The legacy verbatim-quote metric only applies to direct_quote evidence;
    // table_cell entries carry no top-level quote and are validated by the
    // table_cell scorer (groundingGrade), not here.
    if (!e || isTableCellEvidence(e)) return false;
    if (typeof e.quote !== "string" || e.quote.trim() === "") return false;
    const normalizedQuote = normalizeWhitespace(e.quote);
    return normalizedSource.includes(normalizedQuote);
  });
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── absence_state_correct ────────────────────────────────────────────────
// Gold-present requires candidate-present; gold-absent (any absence
// state) requires candidate to also report absence with NO value.
// We do not require gold and candidate absence_state to match exactly
// across absence flavors (e.g., gold "absent" vs candidate "not_applicable"
// is OK for this metric) — the four absence flavors are model-judgment
// calls. The hard rule is: did the candidate hallucinate a value where
// gold says absent? That's what this metric catches.
export function absenceStateCorrect(
  gold: FieldEnvelope,
  candidate: FieldEnvelope | undefined
): boolean {
  const goldPresent = gold.absence_state === "present";
  if (!candidate) return !goldPresent;
  const candPresent = candidate.absence_state === "present";
  if (goldPresent !== candPresent) return false;
  // Both present OR both absent.
  if (!goldPresent) {
    // Candidate must not have populated a value.
    return candidate.raw_value == null && candidate.normalized_value == null;
  }
  return true;
}

// ── severity_weighted_error_rate ─────────────────────────────────────────
// sum over fields of (weight * has_error) / sum over fields of weight.
// has_error == ANY of (exact, normalized, evidence_grounded,
// absence_state_correct) is wrong.
export function severityWeightedErrorRate(fields: FieldMetricResult[]): number {
  if (fields.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const f of fields) {
    const w = severityWeight(f.severity);
    totalWeight += w;
    if (f.has_error) weighted += w;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

// ── evidence-grounding GRADE (Task 4.3a) ─────────────────────────────────
// A field-aware, same-page, local-window grounding grade (0–3) for direct
// scalar fields. This REPLACES the verbatim-quote intuition of the legacy
// `evid` metric with one that asks "is the claimed value sitting in the OCR,
// on the right page, next to a field-specific label?" — without re-extraction
// and without an LLM. It is value-correctness-independent: a value can be
// wrong (normalized_match=false) yet well-grounded, or correct yet ungrounded.
//
// Grades (per scalar field):
//   3 — value in a same-page local window AND a field-specific label/anchor in
//       that window.
//   2 — value in same-page window, no field-specific label nearby (or
//       evidence.page missing on a CRITICAL field → capped at 2).
//   1 — value appears somewhere in OCR but not in the scoped page/window.
//   0 — value not in OCR at all.
//
// Windows are SAME PAGE ONLY (never cross pages):
//   - direct: ±5 OCR lines around the value occurrence,
//   - table-tolerant lookback: a field label/header in the previous 10 lines.
// If candidate evidence carries a page, the value search is restricted to it.
//
// Pure / deterministic / DB-free / API-free. Label sets come from the caller
// (schemas/<doc_type>/generated/field_specs.ts GROUNDING_SPECS), never hardcoded.

interface OcrPage {
  page: number; // 1-based page number from the "--- Seite N ---" marker.
  lines: string[];
}

// Splits OCR text into pages on "--- Seite N ---" markers (the fixture OCR
// convention). Text before the first marker is page 1. The marker line itself
// is not content. Whitespace-only trailing pages are kept (deterministic).
export function parseOcrPages(ocrText: string): OcrPage[] {
  const lines = ocrText.split("\n");
  const pages: OcrPage[] = [];
  let current: OcrPage = { page: 1, lines: [] };
  let sawMarker = false;
  for (const line of lines) {
    const m = line.match(/^---\s*Seite\s+(\d+)\s*---\s*$/i);
    if (m) {
      // Flush the current page if it already accumulated content, or if we've
      // seen a marker before (so empty pages between markers are preserved).
      if (current.lines.length > 0 || sawMarker) pages.push(current);
      current = { page: parseInt(m[1], 10), lines: [] };
      sawMarker = true;
      continue;
    }
    current.lines.push(line);
  }
  pages.push(current);
  return pages;
}

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Token boundary that treats letters/digits/decimal punctuation as "inside" a
// token, so "650,00" does not match inside "1.650,00" and the label "Miete"
// does not match inside "Grundmiete".
function valueOccurs(normLine: string, form: string): boolean {
  const f = normalizeForMatch(form);
  if (f === "") return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}.,])${escapeRegExp(f)}(?![\\p{L}\\p{N}.,])`, "u");
  return re.test(normLine);
}

// Field labels match on letter boundaries only (so "Mietzeit" matches but
// "Miete" does not match inside "Grundmiete").
function labelOccurs(normLine: string, label: string): boolean {
  const l = normalizeForMatch(label);
  if (l === "") return false;
  const re = new RegExp(`(?<!\\p{L})${escapeRegExp(l)}(?!\\p{L})`, "u");
  return re.test(normLine);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function groupThousands(intPart: string): string {
  // 1950 -> "1.950" (German grouping). Sign-free input expected.
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const GERMAN_MONTHS = [
  "januar", "februar", "märz", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
];

// Generates the accepted surface forms of a candidate value to search for in
// OCR. Money: "650,00" = "650.00" = "650" = "1.950,00". Dates: ISO ->
// "01.04.2025" / "1.4.2025" / "1. April 2025". Other scalars: raw + normalized.
export function valueSurfaceForms(candidate: FieldEnvelope, type: string): string[] {
  const forms = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s === "string" && s.trim() !== "") forms.add(s.trim());
    else if (typeof s === "number") forms.add(String(s));
  };

  if (typeof candidate.raw_value === "string") add(candidate.raw_value);

  const nv = candidate.normalized_value;

  if (type === "money" && nv && typeof nv === "object") {
    const amount = (nv as { amount?: unknown }).amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      const sign = amount < 0 ? "-" : "";
      const abs = Math.abs(amount);
      const intPart = Math.trunc(abs / 100);
      const cents = abs % 100;
      const intStr = String(intPart);
      const grouped = groupThousands(intStr);
      add(`${sign}${intStr},${pad2(cents)}`);
      add(`${sign}${intStr}.${pad2(cents)}`);
      add(`${sign}${grouped},${pad2(cents)}`);
      if (cents === 0) {
        add(`${sign}${intStr}`);
        add(`${sign}${grouped}`);
      }
    }
  } else if (type === "date" && typeof nv === "string") {
    const m = nv.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const [, y, mo, d] = m;
      const dNum = parseInt(d, 10);
      const moNum = parseInt(mo, 10);
      add(`${d}.${mo}.${y}`);
      add(`${dNum}.${moNum}.${y}`);
      const month = GERMAN_MONTHS[moNum - 1];
      if (month) {
        add(`${dNum}. ${month} ${y}`);
        add(`${d}. ${month} ${y}`);
      }
    }
  } else if (nv != null && (typeof nv === "string" || typeof nv === "number")) {
    add(nv);
  }

  return [...forms];
}

// Searches a same-page label window around `idx`: ±5 lines (direct) plus the
// previous 10 lines (table-tolerant header lookback). Returns the matched
// label, or null. Never crosses the page boundary (operates on one page's lines).
function findLabelInWindow(lines: string[], idx: number, labels: string[]): string | null {
  const start = Math.max(0, idx - 10); // table-tolerant lookback (prev 10)
  const end = Math.min(lines.length - 1, idx + 5); // direct ±5 (downward)
  for (let i = start; i <= end; i++) {
    const norm = normalizeForMatch(lines[i]);
    for (const label of labels) {
      if (labelOccurs(norm, label)) return label;
    }
  }
  return null;
}

function firstEvidencePage(candidate: FieldEnvelope): number | null {
  const ev = candidate.evidence ?? [];
  for (const e of ev) {
    if (e && typeof e.page === "number" && Number.isFinite(e.page)) return e.page;
  }
  return null;
}

const NON_SCALAR_TYPES = new Set(["structured", "structured_array"]);

// ── identity grounding (Task 4.3a-names) ─────────────────────────────────
// tenant_identity & landlord_identity are the two most audit-critical fields
// in a tenancy document. 4.3a left them `non_scalar` → ungraded; here they are
// routed through a person/company grounding path that reuses the SAME 0–3 grade
// and the SAME same-page window rules as the scalar path. Scorer-only: no
// schema/extractor change, no re-extraction, no LLM.
//
// The anchor is the ROLE label, never a generic synonym. Per the brief the role
// sets are sourced from the generated GROUNDING_SPECS where available (a single
// positive label each today) and FILLED IN here with the fuller per-field role
// map — kept explicit and documented because the generated specs carry neither
// the full positive set nor the wrong-role (negative) set. A field grounds on
// ITS side's roles only; the other side's roles are deliberately excluded so a
// tenant name sitting under "Vermieter" cannot reach grade 3 (role-mismatch).
const IDENTITY_ROLE_ANCHORS: Record<string, { positive: string[]; negative: string[] }> = {
  // tenant side. Must NOT ground on Vermieter/Empfänger/Eigentümer/witness.
  tenant_identity: {
    positive: ["Mieter", "Mieterin", "Mietpartei", "Vertragspartner"],
    negative: ["Vermieter", "Vermieterin", "Empfänger", "Eigentümer", "Zeuge"],
  },
  // landlord side. Must NOT ground on any tenant-side role.
  landlord_identity: {
    positive: ["Vermieter", "Vermieterin", "Eigentümer", "vertreten durch"],
    negative: ["Mieter", "Mieterin", "Mietpartei"],
  },
};

// Legal-form suffixes accepted/normalized for a company identity (the brief's
// GbR/GmbH/UG/KG plus a few common forms). A suffix is folded the same way as
// the rest of the value, so it never blocks a core-token match.
const LEGAL_FORMS = new Set([
  "gbr", "gmbh", "ug", "kg", "ag", "ohg", "mbh", "kgaa", "ev", "eg", "se",
]);

// Connector tokens dropped from a company's distinctive core ("Denn & Denn" →
// {denn}). "&" is already stripped by the alphanumeric tokenizer.
const CONNECTORS = new Set(["und", "u", "co"]);

// Folds German umlauts/ß to their ASCII digraphs so "Müller" == "Mueller". The
// SAME fold is applied to both the OCR line and the identity tokens.
function foldGerman(s: string): string {
  return s
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "ae").replace(/Ö/g, "oe").replace(/Ü/g, "ue")
    .replace(/ß/g, "ss");
}

function normalizeIdentity(s: string): string {
  return foldGerman(s.toLowerCase()).replace(/\s+/g, " ").trim();
}

// Alphanumeric tokens of a (already folded+lowercased) string.
function tokenizeName(folded: string): string[] {
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Word-boundary presence of an already-normalized token on an already-normalized
// (folded) line. Mirrors labelOccurs but operates on folded text.
function identityTokenPresent(normFoldedLine: string, token: string): boolean {
  if (token === "") return false;
  const re = new RegExp(`(?<!\\p{L})${escapeRegExp(token)}(?!\\p{L})`, "u");
  return re.test(normFoldedLine);
}

interface IdentityValue {
  isCompany: boolean;
  surname: string;       // person: the surname core token
  given: string[];       // person: given name(s)/initial(s)
  coreTokens: string[];  // company: distinctive tokens (legal form/connectors removed)
  legalForm: string;     // company: normalized legal-form suffix ("" if none)
}

// Extracts the name string a candidate asserts for an identity field, from the
// structured normalized_value.name (the runtime shape) or, failing that, the
// raw_value. Returns "" when the candidate carries no identity-shaped value
// (e.g. a money envelope) — the caller treats that as "not an identity value".
function identityName(candidate: FieldEnvelope): { name: string; isCompany: boolean; legalForm: string } {
  const nv = candidate.normalized_value;
  let name = "";
  let isCompany = false;
  let legalForm = "";
  if (nv && typeof nv === "object" && !Array.isArray(nv)) {
    const o = nv as Record<string, unknown>;
    if (typeof o.name === "string") name = o.name;
    isCompany = o.is_legal_entity === true;
    if (typeof o.legal_form === "string" && o.legal_form.trim() !== "") {
      legalForm = normalizeIdentity(o.legal_form);
    }
  }
  if (name.trim() === "" && typeof candidate.raw_value === "string") name = candidate.raw_value;
  return { name: name.trim(), isCompany, legalForm };
}

function hasIdentityValue(candidate: FieldEnvelope): boolean {
  return identityName(candidate).name !== "";
}

// Parses a candidate's identity value into surname/given (person) or distinctive
// core tokens + legal form (company). Returns null only for an empty name.
function parseIdentity(candidate: FieldEnvelope): IdentityValue | null {
  const { name, isCompany, legalForm } = identityName(candidate);
  if (name === "") return null;
  const folded = normalizeIdentity(name);

  if (isCompany) {
    const toks = tokenizeName(folded);
    const inferredLegal = toks.find((t) => LEGAL_FORMS.has(t)) ?? "";
    const core = [...new Set(
      toks.filter((t) => t.length >= 2 && !LEGAL_FORMS.has(t) && !CONNECTORS.has(t)),
    )];
    return { isCompany: true, surname: "", given: [], coreTokens: core, legalForm: legalForm || inferredLegal };
  }

  // Person: "Surname, Given" (comma) vs "Given Surname" (whitespace order).
  let surname = "";
  let given: string[] = [];
  if (folded.includes(",")) {
    const [before, after] = folded.split(",");
    const beforeToks = tokenizeName(before);
    surname = beforeToks[beforeToks.length - 1] ?? "";
    given = tokenizeName(after ?? "");
  } else {
    const toks = tokenizeName(folded);
    surname = toks[toks.length - 1] ?? "";
    given = toks.slice(0, -1);
  }
  return { isCompany: false, surname, given, coreTokens: [], legalForm: "" };
}

// A person grounds on a line iff its surname core token AND ≥1 disambiguating
// token (given name) both occur there.
function personMatchesLine(normFoldedLine: string, id: IdentityValue): boolean {
  if (id.surname === "") return false;
  if (!identityTokenPresent(normFoldedLine, id.surname)) return false;
  return id.given.some((g) => identityTokenPresent(normFoldedLine, g));
}

// A company grounds on a line iff its distinctive core tokens are present — all
// of them, OR at least one together with the accepted legal-form suffix.
function companyMatchesLine(normFoldedLine: string, id: IdentityValue): boolean {
  if (id.coreTokens.length === 0) return false;
  const present = id.coreTokens.filter((t) => identityTokenPresent(normFoldedLine, t));
  const legalPresent = id.legalForm !== "" && identityTokenPresent(normFoldedLine, id.legalForm);
  return present.length === id.coreTokens.length || (present.length >= 1 && legalPresent);
}

function identityMatchesLine(line: string, id: IdentityValue): boolean {
  const norm = normalizeIdentity(line);
  return id.isCompany ? companyMatchesLine(norm, id) : personMatchesLine(norm, id);
}

// Positive role anchors for an identity field: the generated spec's label(s)
// (4.3a sourcing) unioned with this module's explicit per-field role map.
function identityRoleAnchors(spec: GroundingSpec): string[] {
  const map = IDENTITY_ROLE_ANCHORS[spec.id];
  const positive = map ? map.positive : [];
  return [...new Set([...(spec.labels ?? []), ...positive])];
}

// Grades an identity field on the SAME 0–3 scale and window rules as the scalar
// path, but with identity value-matching and a ROLE anchor (not a value label):
//   3 — identity value in a same-page window AND a correct-side role anchor in it,
//   2 — identity value in window, no role anchor (bare signature-block name) or
//       only a wrong-side role nearby (role-mismatch),
//   1 — identity value somewhere in OCR but not in the scoped page/window,
//   0 — identity value not in OCR.
function gradeIdentity(
  spec: GroundingSpec,
  candidate: FieldEnvelope,
  ocrText: string,
  base: Omit<FieldGroundingResult, "graded" | "grade" | "excluded">,
): FieldGroundingResult {
  const id = parseIdentity(candidate);
  if (!id) return { ...base, graded: true, grade: 0, excluded: null };

  const anchors = identityRoleAnchors(spec);
  const pages = parseOcrPages(ocrText);
  const evPage = firstEvidencePage(candidate);
  const evidencePagePresent = evPage != null;

  const valueAnywhere = pages.some((p) => p.lines.some((line) => identityMatchesLine(line, id)));
  const scopePages = evidencePagePresent ? pages.filter((p) => p.page === evPage) : pages;

  let foundValue = false;
  let matchedRole: string | null = null;
  let valuePage: number | null = null;
  for (const p of scopePages) {
    for (let i = 0; i < p.lines.length; i++) {
      if (!identityMatchesLine(p.lines[i], id)) continue;
      foundValue = true;
      if (valuePage == null) valuePage = p.page;
      const role = findLabelInWindow(p.lines, i, anchors);
      if (role) {
        matchedRole = role;
        valuePage = p.page;
        break;
      }
    }
    if (matchedRole) break;
  }

  let grade: GroundingGrade;
  if (!foundValue) grade = valueAnywhere ? 1 : 0;
  else if (matchedRole) grade = 3;
  else grade = 2;

  // evidence.page missing on a CRITICAL field caps the grade at 2 (as in 4.3a).
  if (spec.severity === "critical" && !evidencePagePresent && grade > 2) {
    grade = 2;
    matchedRole = null;
  }

  return { ...base, graded: true, grade, excluded: null, matched_label: matchedRole, value_page: valuePage };
}

// ── floor_synonym_normalization (Task 4.3c-a) ────────────────────────────
// The single declared, deterministic, CLOSED normalization rule for the
// derived field unit_ref. Maps a German floor phrase found in an evidence
// quote to the canonical floor token used by unit_ref.normalized_value.
// Pure: (quote) -> token | null. Unknown/unmappable input -> null — an honest
// non-match, NEVER a guess. The closed map (documented per the 4.3c-a brief):
//   Erdgeschoss / EG                          -> "EG"
//   N. Obergeschoss / "N. OG" / "N.OG"        -> "N.OG"  (N copied as written)
//   erste/zweite/dritte/vierte Etage          -> "1.OG" / "2.OG" / "3.OG" / "4.OG"
//   Dachgeschoss / DG                         -> "DG"
//   Unter-/Kellergeschoss / UG                -> "UG"
// A position suffix (links | rechts | mitte) anywhere in the quote is preserved
// as a lowercased token, e.g. "1. Obergeschoss links" -> "1.OG links". A position
// with NO floor token is not a match (returns null).
const ORDINAL_FLOOR_WORDS: Record<string, string> = {
  erste: "1",
  zweite: "2",
  dritte: "3",
  vierte: "4",
};

export function floor_synonym_normalization(quote: string): string | null {
  if (typeof quote !== "string" || quote.trim() === "") return null;
  const q = quote.toLowerCase().replace(/\s+/g, " ").trim();

  let floor: string | null = null;

  // N. Obergeschoss / "N. OG" / "N.OG" — a leading number bound to ober­geschoss.
  const og = q.match(/(?<![\p{L}\p{N}])(\d+)\s*\.?\s*(?:obergeschoss|og)(?![\p{L}])/u);
  if (og) {
    floor = `${og[1]}.OG`;
  }
  // erste/zweite/dritte/vierte Etage|Obergeschoss.
  if (floor === null) {
    const word = q.match(/(?<!\p{L})(erste|zweite|dritte|vierte)\s+(?:etage|obergeschoss)(?!\p{L})/u);
    if (word) floor = `${ORDINAL_FLOOR_WORDS[word[1]]}.OG`;
  }
  // Erdgeschoss / EG.
  if (floor === null && /(?<!\p{L})(?:erdgeschoss|eg)(?!\p{L})/u.test(q)) floor = "EG";
  // Dachgeschoss / DG.
  if (floor === null && /(?<!\p{L})(?:dachgeschoss|dg)(?!\p{L})/u.test(q)) floor = "DG";
  // Unter-/Kellergeschoss / UG (the bare word "Keller" alone is NOT a match).
  if (floor === null && /(?<!\p{L})(?:untergeschoss|kellergeschoss|ug)(?!\p{L})/u.test(q)) floor = "UG";

  if (floor === null) return null;

  const pos = q.match(/(?<!\p{L})(links|rechts|mitte)(?!\p{L})/u);
  return pos ? `${floor} ${pos[1]}` : floor;
}

// ── derived grounding (Task 4.3c-a) ──────────────────────────────────────
// A single-source DERIVED field (e.g. unit_ref) carries a value derived from
// ONE cited source phrase by a declared deterministic normalization rule. It is
// graded scorer-side (no re-extraction, no Sonnet) on a 0/1/3 scale:
//   3 — quote-grounds AND rule-reproduces: the evidence.quote appears in OCR on
//       its page AND applying the field's normalization rule to that quote
//       reproduces the field's normalized_value (source present + derivation
//       reproducible).
//   1 — quote-grounds but the rule does NOT reproduce the value (source present,
//       derivation unverified).
//   0 — quote does not ground (cited source absent from OCR on its page).
// Composite/multi-component derived fields (no single_source rule) stay
// derived_pending (deferred to Task 4.3c-b).

// Closed registry of declared single-source normalization rules. A derived spec
// names its rule via normalization_rule; an unknown name reproduces nothing.
const NORMALIZATION_RULES: Record<string, (quote: string) => string | null> = {
  floor_synonym_normalization,
};

// First evidence entry carrying a non-empty quote (kept with its page, if any).
function firstQuoteEvidence(candidate: FieldEnvelope): EvidenceQuote | null {
  for (const e of candidate.evidence ?? []) {
    if (!e || isTableCellEvidence(e)) continue;
    if (typeof e.quote === "string" && e.quote.trim() !== "") return e;
  }
  return null;
}

function firstTableCellEvidence(candidate: FieldEnvelope): TableCellEvidence | null {
  for (const e of candidate.evidence ?? []) {
    if (e && isTableCellEvidence(e)) return e;
  }
  return null;
}

// quote-grounds: the whitespace-normalized quote appears in OCR on its cited
// page (same-page constraint, mirroring 4.3a's whitespace normalization). When
// the quote carries no page, the whole document is searched.
function quoteGroundsInOcr(quote: string, page: number | null, ocrText: string): boolean {
  const needle = normalizeWhitespace(quote);
  if (needle === "") return false;
  const pages = parseOcrPages(ocrText);
  const scope = page != null ? pages.filter((p) => p.page === page) : pages;
  const haystack = normalizeWhitespace(scope.map((p) => p.lines.join("\n")).join("\n"));
  return haystack.includes(needle);
}

function gradeDerivedSingleSource(
  spec: GroundingSpec,
  candidate: FieldEnvelope,
  ocrText: string,
  base: Omit<FieldGroundingResult, "graded" | "grade" | "excluded">,
): FieldGroundingResult {
  const ev = firstQuoteEvidence(candidate);
  const page = ev && typeof ev.page === "number" && Number.isFinite(ev.page) ? ev.page : null;

  // quote-grounds.
  if (!ev || !quoteGroundsInOcr(ev.quote, page, ocrText)) {
    return { ...base, graded: true, grade: 0, excluded: null, value_page: null };
  }

  // rule-reproduces: applying the declared rule to the quote yields the value.
  const rule = spec.normalization_rule ? NORMALIZATION_RULES[spec.normalization_rule] : undefined;
  const produced = rule ? rule(ev.quote) : null;
  const expected = candidate.normalized_value;
  const reproduces = produced !== null && typeof expected === "string" && produced === expected;

  return { ...base, graded: true, grade: reproduces ? 3 : 1, excluded: null, value_page: page };
}

// ── table_cell grounding (Task 4.3c-b-1a) ────────────────────────────────────
// The LLM PROPOSES a table cell (row anchor + column anchor + RAW cell token +
// derivation rule); the scorer VALIDATES every part against OCR and only then
// counts it. Scorer-only / EVAL-only: no production extractor or envelope change.
//
// Standard (per the task brief), routed on evidence_type === "table_cell":
//  1. Shape — type allowed for the field; row/column/cell_value_raw/rule present;
//     rule allowed (free-form rejected); page present (missing on critical → cap 2).
//  2. Ground each on the cited page — row_anchor.quote, column_anchor.quote
//     (configured header-synonym map only — uncovered header = hallucinated =
//     fail), cell_value_raw (the RAW token, NOT the normalized value).
//  3. Locality (same page) — row_anchor & cell_value_raw within ±3 lines; column
//     within the previous 10 lines of the value; total span ≤ 15 lines.
//  4. Column licenses rule — geschoss_numeric_to_og only under a floor column.
//  5. Row ambiguity (Task 4.3c-b-1b-i) — count CANDIDATE DATA ROWS for the column
//     (value lines at/after the header carrying the raw token). row_anchor is
//     REQUIRED for grade 3 ONLY in a MULTI-row block (>1 candidate row), where it
//     must disambiguate which row supplied the cell (a non-disambiguating anchor
//     → cap ≤ 2). A SINGLE-candidate-row block has nothing to disambiguate, so
//     row_anchor is NOT required for 3 (a provided anchor must still ground).
//  6. Derivation — rule(cell_value_raw) === field.normalized_value.
// Grades: 3 grounded+local+licensed+reproduced+unambiguous; 2 value+one anchor,
// cohesion incomplete; 1 raw on page, no row/column relationship; 0 raw absent /
// different pages / rule fails / wrong column / hallucinated anchor.

// Configured column-header registry — the ONLY headers the scorer recognizes for
// synonym grounding + floor licensing. A model column anchor grounds through THIS
// map (e.g. anchor "Geschoss" grounds on OCR "Gesch."); a header that is neither
// literally in OCR nor a configured surface is hallucinated and fails.
interface HeaderClass {
  // canonical id; isFloor licenses geschoss_numeric_to_og.
  canonical: string;
  isFloor: boolean;
  // accepted OCR surface forms (already lowercased; matched as substrings).
  surfaces: string[];
}
const COLUMN_HEADER_REGISTRY: HeaderClass[] = [
  { canonical: "floor", isFloor: true, surfaces: ["geschoss", "gesch.", "gesch", "etage"] },
];

// The OCR surface forms acceptable for a model column anchor, plus whether the
// anchor belongs to a configured FLOOR header class. An anchor maps to a class
// if its (normalized) quote equals the canonical id or one of the surfaces;
// otherwise only its own literal text is accepted (so a non-configured header
// like "Zimmer"/"Nr." can ground literally but is never floor-licensed).
function columnAnchorSurfaces(anchorQuote: string): { surfaces: string[]; isFloorClass: boolean } {
  const qa = normalizeForMatch(anchorQuote);
  if (qa === "") return { surfaces: [], isFloorClass: false };
  const cls = COLUMN_HEADER_REGISTRY.find(
    (c) => c.canonical === qa || c.surfaces.some((s) => normalizeForMatch(s) === qa),
  );
  const surfaces = new Set<string>([qa]);
  if (cls) for (const s of cls.surfaces) surfaces.add(normalizeForMatch(s));
  return { surfaces: [...surfaces], isFloorClass: cls?.isFloor ?? false };
}

// Line indices on a page where the column header grounds (any accepted surface),
// and whether that header is a configured floor column.
function columnLineIndices(anchorQuote: string, lines: string[]): { indices: number[]; isFloor: boolean } {
  const { surfaces, isFloorClass } = columnAnchorSurfaces(anchorQuote);
  const indices: number[] = [];
  if (surfaces.length === 0) return { indices, isFloor: false };
  for (let i = 0; i < lines.length; i++) {
    const nl = normalizeForMatch(lines[i]);
    if (surfaces.some((s) => s !== "" && nl.includes(s))) indices.push(i);
  }
  return { indices, isFloor: isFloorClass && indices.length > 0 };
}

// Line indices where a (possibly multi-word) anchor quote occurs as a normalized
// substring — for row anchors like "Everding Lena".
function substringLineIndices(quote: string, lines: string[]): number[] {
  const n = normalizeForMatch(quote);
  if (n === "") return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalizeForMatch(lines[i]).includes(n)) out.push(i);
  }
  return out;
}

// Line indices where the RAW cell token occurs as a standalone token (so "1"
// does not match inside "100" or "650,00").
function rawTokenLineIndices(raw: string, lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (valueOccurs(normalizeForMatch(lines[i]), raw)) out.push(i);
  }
  return out;
}

// Evaluates a table cell on ONE page's lines. Returns the grade achievable on
// this page (same-page constraint), or null when the raw token is not even
// present on it (lets the caller try other pages when no page is cited).
function gradeTableCellOnPage(
  normalizedValue: unknown,
  lines: string[],
  rowProvided: boolean,
  rowQuote: string,
  colQuote: string,
  rawTok: string,
  ruleId: DerivationRule,
  pageCap: GroundingGrade,
): GroundingGrade | null {
  const valueLines = rawTokenLineIndices(rawTok, lines);
  if (valueLines.length === 0) return null; // raw absent on this page

  const col = columnLineIndices(colQuote, lines);
  if (col.indices.length === 0) return 0; // hallucinated column header

  const rowLines = rowProvided ? substringLineIndices(rowQuote, lines) : [];
  if (rowProvided && rowLines.length === 0) return 0; // hallucinated row anchor

  // 4. Column licenses the rule: geschoss_numeric_to_og only under a floor column.
  if (ruleId === "geschoss_numeric_to_og" && !col.isFloor) return 0; // wrong column

  // 6. Derivation reproduces the normalized value from the RAW token.
  const produced = applyDerivationRule(ruleId, rawTok);
  if (produced === null || typeof normalizedValue !== "string" || produced !== normalizedValue) {
    return 0; // rule fails
  }

  // 5. Row ambiguity (Task 4.3c-b-1b-i-2): count CANDIDATE DATA ROWS for this
  // column — value lines carrying the raw token that ALSO sit under the licensed
  // (floor) column header within the SAME locality window used for grade-3 column
  // grounding (a header in the previous ≤10 lines — the per-value-line `columnOk`
  // rule applied below). >1 such row is a MULTI-row block (ambiguity to resolve,
  // row_anchor required), exactly 1 is a SINGLE-row block (nothing to
  // disambiguate). This counts ONLY column-aligned rows, NOT bare token
  // occurrences anywhere on the page: an unrelated row (e.g. a garage row >10
  // lines from any floor header) carrying a standalone token no longer inflates
  // the block to multi-row (the 1b-i `vi >= headerMin` over-count). The
  // linearized floor case still keeps a whole row on one line, so a single-unit
  // description table is ONE data row even when that line repeats the token
  // across columns.
  const candidateRows = valueLines.filter((vi) =>
    col.indices.some((ci) => ci <= vi && vi - ci <= 10),
  );
  const multiRow = candidateRows.length >= 2;

  // 3. Locality: pick the best value line with a column header in the previous 10
  // lines and (if provided) a row anchor within ±3 lines; total span ≤ 15.
  let best: GroundingGrade = 1; // raw on page but no anchor relationship yet
  for (const vi of valueLines) {
    const ciCands = col.indices.filter((ci) => ci <= vi && vi - ci <= 10);
    const columnOk = ciCands.length > 0;
    const riCands = rowProvided ? rowLines.filter((ri) => Math.abs(ri - vi) <= 3) : [];
    const rowOk = rowProvided && riCands.length > 0;
    const disambiguated = rowOk && riCands.includes(vi); // anchor on the value's row
    if (!columnOk && !rowOk) continue;

    const idxs = [vi, ...(columnOk ? [Math.max(...ciCands)] : []), ...(rowOk ? [riCands[0]] : [])];
    const span = Math.max(...idxs) - Math.min(...idxs);

    let g: GroundingGrade;
    if (multiRow) {
      // Multi-row block: row_anchor REQUIRED for 3 and must pin the value's own row
      // (unchanged from 1a). A missing/weak/non-disambiguating anchor caps at 2.
      const cohesionComplete = columnOk && rowProvided && rowOk && span <= 15;
      g = cohesionComplete && disambiguated ? 3 : 2;
    } else {
      // Single-row block: nothing to disambiguate, so row_anchor is NOT required.
      // Grade 3 on licensed column + value + locality; a provided row anchor has
      // already been ground-checked (return 0 above) and here only tightens span.
      const cohesionComplete = columnOk && span <= 15;
      g = cohesionComplete ? 3 : 2;
    }
    if (g > best) best = g;
  }

  return Math.min(best, pageCap) as GroundingGrade;
}

function gradeTableCell(
  spec: GroundingSpec,
  candidate: FieldEnvelope,
  tc: TableCellEvidence,
  ocrText: string,
  base: Omit<FieldGroundingResult, "graded" | "grade" | "excluded">,
): FieldGroundingResult {
  const grade0 = (): FieldGroundingResult => ({ ...base, graded: true, grade: 0, excluded: null, value_page: null });
  const cell = tc.table_cell;

  // 1. Shape.
  if (!tableCellAllowed(spec.id)) return grade0();
  if (!cell || typeof cell !== "object") return grade0();
  const rawTok = typeof cell.cell_value_raw === "string" ? cell.cell_value_raw.trim() : "";
  const colQuote = typeof cell.column_anchor?.quote === "string" ? cell.column_anchor.quote.trim() : "";
  const rowQuote = typeof cell.row_anchor?.quote === "string" ? cell.row_anchor.quote.trim() : "";
  const ruleId = cell.derivation_rule;
  // RAW token, column anchor and a usable rule are structurally required.
  if (rawTok === "" || colQuote === "") return grade0();
  if (!isDerivationRule(ruleId) || !tableCellRuleAllowed(spec.id, ruleId)) return grade0();

  const page = typeof tc.page === "number" && Number.isFinite(tc.page) ? tc.page : null;
  // Whether the model supplied a row anchor at all. It is REQUIRED for grade 3
  // only in a multi-row block; that decision is made per page in
  // gradeTableCellOnPage from the candidate-data-row count (Task 4.3c-b-1b-i).
  const rowProvided = rowQuote !== "";
  // page missing on a CRITICAL field caps the grade at 2 (unchanged from 1a).
  let pageCap: GroundingGrade = 3;
  if (page == null && spec.severity === "critical") pageCap = 2;

  const pages = parseOcrPages(ocrText);
  // Same-page constraint: a cited page scopes to exactly that page; without one,
  // try each page and keep the best (anchors must still co-locate on one page).
  const scope = page != null ? pages.filter((p) => p.page === page) : pages;
  if (scope.length === 0) return grade0(); // cited page not in OCR

  let bestGrade: GroundingGrade = 0;
  let valuePage: number | null = null;
  for (const p of scope) {
    const g = gradeTableCellOnPage(
      candidate.normalized_value, p.lines,
      rowProvided, rowQuote, colQuote, rawTok, ruleId, pageCap,
    );
    if (g == null) continue; // raw not on this page
    if (g > bestGrade) { bestGrade = g; valuePage = p.page; }
  }

  return { ...base, graded: true, grade: bestGrade, excluded: null, value_page: bestGrade > 0 ? valuePage : null };
}

// Computes the grounding grade for a single field. Pure: (spec, candidate,
// ocrText) -> result. Returns an excluded (ungraded) result for derived,
// non-scalar, absent, or no-OCR cases.
export function groundingGrade(
  spec: GroundingSpec,
  candidate: FieldEnvelope | undefined,
  ocrText: string | undefined,
): FieldGroundingResult {
  const base = {
    field_id: spec.id,
    severity: spec.severity,
    matched_label: null as string | null,
    value_page: null as number | null,
    evidence_page_present: candidate ? firstEvidencePage(candidate) != null : false,
  };
  const excluded = (reason: FieldGroundingResult["excluded"]): FieldGroundingResult => ({
    ...base,
    graded: false,
    grade: null,
    excluded: reason,
  });

  // Route on evidence_type FIRST (Task 4.3c-b-1a): a candidate proposing
  // table_cell evidence is validated by the table_cell scorer, independent of the
  // field's derived/scalar classification. Direct-quote (default) evidence falls
  // through to the existing scalar/identity/derived paths unchanged — so Lena's
  // unit_ref (a direct_quote) keeps its 4.3c-a derived grade.
  if (candidate && candidate.absence_state === "present") {
    const tc = firstTableCellEvidence(candidate);
    if (tc) {
      if (!ocrText) return excluded("no_ocr");
      return gradeTableCell(spec, candidate, tc, ocrText, base);
    }
  }

  // Derived fields (e.g. unit_ref). A single-source derived field with a declared
  // normalization rule is graded by validating its derivation (Task 4.3c-a);
  // composite/multi-component derived fields stay derived_pending (Task 4.3c-b).
  if (spec.derived) {
    if (spec.derived_kind === "single_source" && spec.normalization_rule) {
      if (!candidate || candidate.absence_state !== "present") return excluded("absent");
      if (!ocrText) return excluded("no_ocr");
      return gradeDerivedSingleSource(spec, candidate, ocrText, base);
    }
    return excluded("derived_pending");
  }

  // Identity fields (tenant_identity/landlord_identity) are routed through
  // person/company grounding (Task 4.3a-names) — they are non-scalar but carry a
  // grade. A present, identity-shaped value goes to gradeIdentity; a present but
  // non-identity value (e.g. a malformed money payload) falls through to the
  // non_scalar exclusion below; an absent value is excluded as absent.
  if (spec.id in IDENTITY_ROLE_ANCHORS) {
    if (!candidate || candidate.absence_state !== "present") return excluded("absent");
    if (hasIdentityValue(candidate)) {
      if (!ocrText) return excluded("no_ocr");
      return gradeIdentity(spec, candidate, ocrText, base);
    }
  }

  // Only direct scalar fields are graded in v1.
  if (!spec.scalar || NON_SCALAR_TYPES.has(spec.type)) return excluded("non_scalar");
  // No asserted value -> nothing to ground.
  if (!candidate || candidate.absence_state !== "present") return excluded("absent");
  // No source text -> cannot verify (mirrors the conservative score path).
  if (!ocrText) return excluded("no_ocr");

  const forms = valueSurfaceForms(candidate, spec.type);
  if (forms.length === 0) {
    // Present but no usable value surface -> not grounded.
    return { ...base, graded: true, grade: 0, excluded: null };
  }

  const pages = parseOcrPages(ocrText);
  const evPage = firstEvidencePage(candidate);
  const evidencePagePresent = evPage != null;

  // "Value in OCR anywhere" (any page) — separates grade 1 from grade 0.
  const valueAnywhere = pages.some((p) =>
    p.lines.some((line) => {
      const norm = normalizeForMatch(line);
      return forms.some((f) => valueOccurs(norm, f));
    }),
  );

  // Scope: if evidence carries a page, restrict to it; else all pages. Windows
  // never cross pages either way.
  const scopePages = evidencePagePresent ? pages.filter((p) => p.page === evPage) : pages;

  let grade: GroundingGrade;
  let matchedLabel: string | null = null;
  let valuePage: number | null = null;

  // Find value occurrences within scope, then look for a field label nearby.
  let foundValue = false;
  for (const p of scopePages) {
    for (let i = 0; i < p.lines.length; i++) {
      const norm = normalizeForMatch(p.lines[i]);
      if (!forms.some((f) => valueOccurs(norm, f))) continue;
      foundValue = true;
      if (valuePage == null) valuePage = p.page;
      const label = findLabelInWindow(p.lines, i, spec.labels);
      if (label) {
        matchedLabel = label;
        valuePage = p.page;
        break;
      }
    }
    if (matchedLabel) break;
  }

  if (!foundValue) {
    grade = valueAnywhere ? 1 : 0;
  } else if (matchedLabel) {
    grade = 3;
  } else {
    grade = 2;
  }

  // evidence.page missing on a CRITICAL field caps the grade at 2.
  if (spec.severity === "critical" && !evidencePagePresent && grade > 2) {
    grade = 2;
    matchedLabel = null;
  }

  return { ...base, graded: true, grade, excluded: null, matched_label: matchedLabel, value_page: valuePage };
}

// Aggregates per-field grounding results into a fixture-level summary.
export function summarizeGrounding(fields: FieldGroundingResult[]): GroundingSummary {
  const graded = fields.filter((f) => f.graded && f.grade != null);
  const gradeSum = graded.reduce((acc, f) => acc + (f.grade ?? 0), 0);
  const grade_mean = graded.length === 0 ? 0 : gradeSum / graded.length;
  const grade3 = graded.filter((f) => f.grade === 3).length;
  return {
    fields,
    graded_count: graded.length,
    grade_mean,
    grade_rate: grade_mean / 3,
    grade3_rate: graded.length === 0 ? 0 : grade3 / graded.length,
    derived_pending: fields.filter((f) => f.excluded === "derived_pending").map((f) => f.field_id),
  };
}

// ── score: scores a single (candidate, gold) envelope pair ───────────────
// Iterates every field declared by the schema's field defs. A field
// absent from the candidate is treated as candidate undefined; the
// metric functions handle that case.
export function scoreFixture(
  fixtureId: string,
  docType: string,
  gold: ExtractionEnvelope,
  candidate: ExtractionEnvelope | undefined,
  schemaFields: SchemaFieldDef[],
  ocrText: string | undefined,
  // Task 4.3a: when provided, the grounding grade is computed per field and a
  // GroundingSummary is attached. Optional so the legacy four-metric callers
  // (and their tests) are byte-for-byte unchanged.
  groundingSpecs?: Record<string, GroundingSpec>
): DocTypeMetricSummary {
  const candidateFields = candidate?.fields ?? {};
  const results: FieldMetricResult[] = [];

  for (const def of schemaFields) {
    const goldField = gold.fields[def.id];
    if (!goldField) {
      // Gold envelope does not declare this field. Skip it from the
      // summary; the fixture loader is the place to flag schema/gold
      // drift, not metrics.
      continue;
    }
    const candField = candidateFields[def.id];
    const exact = exactMatch(goldField, candField);
    const normalized = normalizedMatch(goldField, candField);
    const grounded = evidenceGrounded(goldField, candField, ocrText);
    const absenceOk = absenceStateCorrect(goldField, candField);
    const hasError = !(exact && normalized && grounded && absenceOk);
    results.push({
      field_id: def.id,
      severity: def.severity,
      gold_absence_state: goldField.absence_state,
      candidate_absence_state: (candField?.absence_state ?? "missing") as AbsenceState | "missing",
      exact_match: exact,
      normalized_match: normalized,
      evidence_grounded: grounded,
      absence_state_correct: absenceOk,
      has_error: hasError,
    });
  }

  // Evidence-grounding grade (Task 4.3a), computed separately from the four
  // value/absence metrics above and never collapsed into them.
  let grounding: GroundingSummary | undefined;
  if (groundingSpecs) {
    const groundingFields: FieldGroundingResult[] = [];
    for (const def of schemaFields) {
      const spec = groundingSpecs[def.id];
      if (!spec) continue; // no grounding spec for this field -> skip
      groundingFields.push(groundingGrade(spec, candidateFields[def.id], ocrText));
    }
    grounding = summarizeGrounding(groundingFields);
  }

  const n = results.length;
  const rate = (count: number) => (n === 0 ? 0 : count / n);
  return {
    doc_type: docType,
    fixture_id: fixtureId,
    fields: results,
    exact_match_rate: rate(results.filter((r) => r.exact_match).length),
    normalized_match_rate: rate(results.filter((r) => r.normalized_match).length),
    evidence_grounded_rate: rate(results.filter((r) => r.evidence_grounded).length),
    absence_state_correct_rate: rate(results.filter((r) => r.absence_state_correct).length),
    severity_weighted_error_rate: severityWeightedErrorRate(results),
    ...(grounding ? { grounding } : {}),
  };
}

export const __TEST_ONLY__ = { severityWeight };
