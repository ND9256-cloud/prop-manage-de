// Fixture loader for the eval harness.
//
// Layout (current):
//
//   tests/fixtures/extraction/<doc_type_or_case_dir>/<case_id>/
//     - expected.json | <doc_type>.json   (gold envelope)
//     - source.pdf | source.txt           (optional; needed for extract --live
//                                          and for evidence-grounded scoring)
//     - meta.json                         (optional; { split, tags, notes })
//
// Architecture §13.2 references a gold/dev/test split. The split is NOT
// yet formalized in the architecture document or in the existing fixture
// tree (all current fixtures are effectively "gold"). The loader makes
// `split` first-class via an optional per-fixture meta.json; default is
// "gold". When 4.3 formalizes the split this loader continues to work
// without code change — the fixture authors add a meta.json next to
// their expected envelope.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathToFileURL } from "node:url";

import type { ExtractionEnvelope, GroundingSpec, SchemaFieldDef } from "./types.ts";

// Resolve repo root: scripts/eval/loader.ts → ../../
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const FIXTURE_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "extraction");
export const SCHEMA_ROOT = path.join(REPO_ROOT, "schemas");

export type FixtureSplit = "gold" | "dev" | "test";

export interface FixtureMeta {
  split: FixtureSplit;
  tags: string[];
  notes?: string;
}

export interface LoadedFixture {
  fixture_id: string;            // <case_dir>/<envelope_filename>
  doc_type: string;              // from envelope.doc_type
  case_dir: string;              // absolute dir
  envelope_path: string;         // absolute path to gold envelope
  envelope: ExtractionEnvelope;
  source_text_path: string | null; // absolute path or null if input missing
  source_pdf_path: string | null;  // absolute path or null
  meta: FixtureMeta;
}

const DEFAULT_META: FixtureMeta = { split: "gold", tags: [] };

function isEnvelope(o: unknown): o is ExtractionEnvelope {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  return typeof obj.doc_type === "string" && typeof obj.fields === "object" && obj.fields != null;
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadMeta(caseDir: string): FixtureMeta {
  const metaPath = path.join(caseDir, "meta.json");
  if (!fs.existsSync(metaPath)) return DEFAULT_META;
  try {
    const raw = readJson(metaPath) as Partial<FixtureMeta>;
    const split: FixtureSplit = raw.split === "dev" || raw.split === "test" ? raw.split : "gold";
    return {
      split,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
      notes: typeof raw.notes === "string" ? raw.notes : undefined,
    };
  } catch {
    return DEFAULT_META;
  }
}

// Resolves a SINGLE gold envelope's source OCR/PDF, per-envelope (Task 4.3b,
// Option B — preserve fixture_ids, additive). Multi-envelope case dirs used to
// share one source.txt, so every secondary envelope scored against the wrong
// document's OCR. Resolution order:
//   1. `<envelope_basename>.source.{txt,pdf}` in the same dir — a dedicated
//      per-envelope source (e.g. mietvertrag.source.txt next to mietvertrag.json).
//   2. If the dir holds exactly ONE gold envelope, fall back to the dir's
//      shared `source.txt` / `ocr.txt` / `source.pdf` (the single-envelope case
//      is unambiguous — Lena keeps resolving to her source.txt).
//   3. Otherwise null (multi-envelope dir whose per-doc OCR is not yet
//      backfilled — WS3). null means "pending_source", not a scoring failure.
function resolveEnvelopeSources(
  caseDir: string,
  envelopeFile: string,
  goldEnvelopeCount: number,
): { txt: string | null; pdf: string | null } {
  const base = envelopeFile.replace(/\.json$/, "");
  let txt: string | null = null;
  let pdf: string | null = null;

  // 1. Dedicated per-envelope source.
  const dedicatedTxt = path.join(caseDir, `${base}.source.txt`);
  if (fs.existsSync(dedicatedTxt)) txt = dedicatedTxt;
  const dedicatedPdf = path.join(caseDir, `${base}.source.pdf`);
  if (fs.existsSync(dedicatedPdf)) pdf = dedicatedPdf;

  // 2. Single-envelope dir → fall back to the shared dir-level source.
  if (txt === null && goldEnvelopeCount === 1) {
    for (const c of ["source.txt", "ocr.txt"]) {
      const p = path.join(caseDir, c);
      if (fs.existsSync(p)) { txt = p; break; }
    }
  }
  if (pdf === null && goldEnvelopeCount === 1) {
    const p = path.join(caseDir, "source.pdf");
    if (fs.existsSync(p)) pdf = p;
  }

  // 3. Otherwise null (multi-envelope dir, secondary not yet backfilled).
  return { txt, pdf };
}

// Walks the fixture tree and returns every (case_dir, envelope_file) pair.
// The case_dir is the immediate parent of the envelope file. Multiple
// envelopes in the same case_dir (e.g., hofmann/hhs55-dg/mietvertrag.json +
// eigentuemerwechsel.json) each become a separate LoadedFixture.
export function loadFixtures(options: {
  split?: FixtureSplit | "all";
  docType?: string;
} = {}): LoadedFixture[] {
  const { split = "all", docType } = options;
  const out: LoadedFixture[] = [];
  if (!fs.existsSync(FIXTURE_ROOT)) return out;
  walkCaseDirs(FIXTURE_ROOT, (caseDir) => {
    const entries = fs.readdirSync(caseDir).filter((f) => f.endsWith(".json") && f !== "meta.json");
    const meta = loadMeta(caseDir);
    if (split !== "all" && meta.split !== split) return;
    // Parse every envelope in the dir once. The gold-envelope COUNT drives the
    // single-dir source fallback (resolveEnvelopeSources), so it is computed
    // over ALL gold envelopes in the dir, independent of the docType/split
    // filters applied to the emitted fixtures below.
    const parsedEntries: { entry: string; envelope: ExtractionEnvelope }[] = [];
    for (const entry of entries) {
      let parsed: unknown;
      try { parsed = readJson(path.join(caseDir, entry)); } catch { continue; }
      if (!isEnvelope(parsed)) continue;
      parsedEntries.push({ entry, envelope: parsed });
    }
    const goldEnvelopeCount = parsedEntries.length;
    for (const { entry, envelope } of parsedEntries) {
      if (docType && envelope.doc_type !== docType) continue;
      const sources = resolveEnvelopeSources(caseDir, entry, goldEnvelopeCount);
      const relCase = path.relative(FIXTURE_ROOT, caseDir);
      out.push({
        fixture_id: `${relCase}/${entry}`,
        doc_type: envelope.doc_type,
        case_dir: caseDir,
        envelope_path: path.join(caseDir, entry),
        envelope,
        source_text_path: sources.txt,
        source_pdf_path: sources.pdf,
        meta,
      });
    }
  });
  // Deterministic order across platforms.
  out.sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
  return out;
}

// A "case directory" is any directory that contains at least one .json
// envelope. We walk the tree and emit each such directory once. This
// keeps the loader simple and survives both the current 2-level layout
// (<doc_type>/<case>/) and the multi-doc Hofmann layout
// (<scenario>/<case>/{mietvertrag,eigentuemerwechsel}.json).
function walkCaseDirs(root: string, visit: (dir: string) => void): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const hasEnvelope = entries.some((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "meta.json");
    if (hasEnvelope) visit(dir);
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
}

// ── Schema field defs ────────────────────────────────────────────────────
// Loads schemas/<doc_type>/schema.yaml. We use a minimal hand-rolled
// YAML reader for the `fields:` list, because metrics need only `id` +
// `severity`. Avoids pulling js-yaml into a script that already has a
// narrow scope (full YAML parsing is exercised by scripts/gen-schemas.ts).

export function loadSchemaFields(docType: string): SchemaFieldDef[] {
  const schemaPath = path.join(SCHEMA_ROOT, docType, "schema.yaml");
  if (!fs.existsSync(schemaPath)) return [];
  const text = fs.readFileSync(schemaPath, "utf8");
  return parseFieldsSection(text);
}

// Minimal YAML parser tuned to the schema.yaml `fields:` list shape.
// Each field entry begins with `  - id: <id>` at column 2 (two spaces).
// Continuation lines `    <key>: <value>` at column 4 are properties
// of the current field. We extract `id` and `severity` only; everything
// else is ignored (we are not building a full YAML parser).
export function parseFieldsSection(text: string): SchemaFieldDef[] {
  const lines = text.split("\n");
  const out: SchemaFieldDef[] = [];
  let inFields = false;
  let current: Partial<SchemaFieldDef> | null = null;
  for (const raw of lines) {
    if (/^fields:\s*$/.test(raw)) { inFields = true; continue; }
    if (!inFields) continue;
    // A line that starts a new top-level key (no leading whitespace, ends
    // with colon) terminates the fields section.
    if (/^\S/.test(raw) && raw.includes(":")) {
      if (current && current.id && current.severity) out.push(current as SchemaFieldDef);
      current = null;
      inFields = false;
      continue;
    }
    const itemMatch = raw.match(/^  -\s*id:\s*(\S+)\s*$/);
    if (itemMatch) {
      if (current && current.id && current.severity) out.push(current as SchemaFieldDef);
      current = { id: itemMatch[1] };
      continue;
    }
    if (!current) continue;
    const propMatch = raw.match(/^    ([a-z_][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (propMatch) {
      const key = propMatch[1];
      const val = propMatch[2];
      if (key === "severity") {
        if (val === "critical" || val === "important" || val === "nice_to_have") {
          current.severity = val;
        }
      } else if (key === "type") {
        current.type = val;
      }
    }
  }
  if (current && current.id && current.severity) out.push(current as SchemaFieldDef);
  return out;
}

// ── Grounding specs (Task 4.3a) ──────────────────────────────────────────
// Loads the per-field grounding label sets from the GENERATED, schema-driven
// artifact schemas/<doc_type>/generated/field_specs.ts (GROUNDING_SPECS), so
// the grounding scorer never hardcodes label sets. Async because the generated
// file is an ES module imported by path. Returns {} when the doc_type has no
// generated specs (or the import fails) so the score path degrades gracefully.
export async function loadGroundingSpecs(docType: string): Promise<Record<string, GroundingSpec>> {
  const specPath = path.join(SCHEMA_ROOT, docType, "generated", "field_specs.ts");
  if (!fs.existsSync(specPath)) return {};
  try {
    const mod = (await import(pathToFileURL(specPath).href)) as {
      GROUNDING_SPECS?: Record<string, GroundingSpec>;
    };
    return mod.GROUNDING_SPECS ?? {};
  } catch {
    return {};
  }
}

export function readOcrText(fixture: LoadedFixture): string | undefined {
  if (!fixture.source_text_path) return undefined;
  try { return fs.readFileSync(fixture.source_text_path, "utf8"); }
  catch { return undefined; }
}
