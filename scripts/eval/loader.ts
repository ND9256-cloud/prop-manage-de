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

import type { ExtractionEnvelope, SchemaFieldDef } from "./types.ts";

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

function findSourceFiles(caseDir: string): { txt: string | null; pdf: string | null } {
  const txtCandidates = ["source.txt", "ocr.txt"];
  const pdfCandidates = ["source.pdf"];
  let txt: string | null = null;
  let pdf: string | null = null;
  for (const c of txtCandidates) {
    const p = path.join(caseDir, c);
    if (fs.existsSync(p)) { txt = p; break; }
  }
  for (const c of pdfCandidates) {
    const p = path.join(caseDir, c);
    if (fs.existsSync(p)) { pdf = p; break; }
  }
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
    const sources = findSourceFiles(caseDir);
    for (const entry of entries) {
      const envelopePath = path.join(caseDir, entry);
      let parsed: unknown;
      try { parsed = readJson(envelopePath); } catch { continue; }
      if (!isEnvelope(parsed)) continue;
      if (docType && parsed.doc_type !== docType) continue;
      const relCase = path.relative(FIXTURE_ROOT, caseDir);
      out.push({
        fixture_id: `${relCase}/${entry}`,
        doc_type: parsed.doc_type,
        case_dir: caseDir,
        envelope_path: envelopePath,
        envelope: parsed,
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

export function readOcrText(fixture: LoadedFixture): string | undefined {
  if (!fixture.source_text_path) return undefined;
  try { return fs.readFileSync(fixture.source_text_path, "utf8"); }
  catch { return undefined; }
}
