#!/usr/bin/env -S npx tsx
// Eval harness CLI (Task 4.1 scaffolding).
//
// Two modes, both deterministic from the caller's point of view:
//
//   npx tsx scripts/eval/run.ts score [--split gold|dev|test|all]
//                                     [--doc-type <id>]
//                                     [--candidate <dir>]
//
//     Scores every fixture's gold envelope (or, if --candidate is given,
//     a candidate envelope of the same name in <candidate>/<fixture_id>)
//     against the schema. Default: scores gold-vs-gold ("self-score"), a
//     smoke test that should produce zero error on well-formed fixtures.
//
//   npx tsx scripts/eval/run.ts extract --live --fixture-cap <N>
//                                     [--split gold|dev|test|all]
//                                     [--doc-type <id>]
//                                     [--out <dir>]
//
//     Runs Step 8b extraction live against each fixture's OCR text
//     input. REQUIRES --live and --fixture-cap (no defaults; both must
//     be explicit) to keep spend bounded. Errors cleanly if any matched
//     fixture has no source text file (the case at PR time — see 4.3).
//
// Output:
//   eval/results/<timestamp>.json (or as --out specifies)
//
// Architecture: §13.2 metrics, §16.3 eval cost. No semantic LLM judgment
// of evidence (deferred to §13.2 critic in Task 4.5).

import fs from "node:fs";
import path from "node:path";

import { loadFixtures, loadSchemaFields, readOcrText, REPO_ROOT, type LoadedFixture, type FixtureSplit } from "./loader.ts";
import { scoreFixture } from "./metrics.ts";
import { extractEnvelope, hasExtractorFor, makeAnthropicDeps, SONNET_MODEL, type ExtractorDeps } from "./extractor.ts";
import type { EvalRunResult, ExtractionEnvelope, DocTypeMetricSummary } from "./types.ts";

interface CliArgs {
  mode: "score" | "extract";
  split: FixtureSplit | "all";
  docType?: string;
  candidateDir?: string;
  out?: string;
  live: boolean;
  fixtureCap?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "score",
    split: "all",
    live: false,
  };
  const positional = argv.filter((a) => !a.startsWith("--"));
  const mode = positional[0];
  if (mode === "extract") args.mode = "extract";
  else if (mode === "score") args.mode = "score";
  else if (mode !== undefined) throw new Error(`unknown mode "${mode}"; expected "score" or "extract"`);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (label: string) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${label} requires a value`);
      }
      i++;
      return v;
    };
    switch (a) {
      case "--live":
        args.live = true;
        break;
      case "--split": {
        const v = next("--split");
        if (v !== "gold" && v !== "dev" && v !== "test" && v !== "all") {
          throw new Error(`--split must be one of gold|dev|test|all, got "${v}"`);
        }
        args.split = v;
        break;
      }
      case "--doc-type":
        args.docType = next("--doc-type");
        break;
      case "--candidate":
        args.candidateDir = next("--candidate");
        break;
      case "--out":
        args.out = next("--out");
        break;
      case "--fixture-cap": {
        const v = parseInt(next("--fixture-cap"), 10);
        if (!Number.isFinite(v) || v <= 0) throw new Error("--fixture-cap must be a positive integer");
        args.fixtureCap = v;
        break;
      }
      default:
        // Positional args (mode) already handled.
        break;
    }
  }
  return args;
}

function timestamp(): string {
  // ISO 8601 in UTC, no colons (filesystem-safe).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function defaultOutputPath(): string {
  return path.join(REPO_ROOT, "eval", "results", `${timestamp()}.json`);
}

function loadCandidateEnvelope(candidateDir: string, fixture: LoadedFixture): ExtractionEnvelope | undefined {
  // Mirror layout: <candidate_dir>/<fixture_id> where fixture_id is
  // already case_dir/envelope_filename relative to FIXTURE_ROOT.
  const candidatePath = path.join(candidateDir, fixture.fixture_id);
  if (!fs.existsSync(candidatePath)) return undefined;
  try {
    const obj = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    return obj as ExtractionEnvelope;
  } catch {
    return undefined;
  }
}

function aggregateDocType(summaries: DocTypeMetricSummary[]): EvalRunResult["per_doc_type"] {
  const byType: Record<string, DocTypeMetricSummary[]> = {};
  for (const s of summaries) {
    (byType[s.doc_type] ??= []).push(s);
  }
  const out: EvalRunResult["per_doc_type"] = {};
  for (const [docType, items] of Object.entries(byType)) {
    const mean = (vals: number[]) => (vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length);
    out[docType] = {
      fixture_count: items.length,
      exact_match_rate: mean(items.map((i) => i.exact_match_rate)),
      normalized_match_rate: mean(items.map((i) => i.normalized_match_rate)),
      evidence_grounded_rate: mean(items.map((i) => i.evidence_grounded_rate)),
      absence_state_correct_rate: mean(items.map((i) => i.absence_state_correct_rate)),
      severity_weighted_error_rate: mean(items.map((i) => i.severity_weighted_error_rate)),
    };
  }
  return out;
}

async function runScore(args: CliArgs): Promise<EvalRunResult> {
  const fixtures = loadFixtures({ split: args.split, docType: args.docType });
  if (fixtures.length === 0) {
    throw new Error(
      `no fixtures matched split=${args.split} doc-type=${args.docType ?? "*"}`
    );
  }

  const summaries: DocTypeMetricSummary[] = [];
  for (const f of fixtures) {
    const schemaFields = loadSchemaFields(f.doc_type);
    if (schemaFields.length === 0) {
      console.warn(`[skip] no schema fields found for doc_type "${f.doc_type}" (${f.fixture_id})`);
      continue;
    }
    const candidate = args.candidateDir
      ? loadCandidateEnvelope(args.candidateDir, f)
      : f.envelope;
    const ocrText = readOcrText(f);
    summaries.push(scoreFixture(f.fixture_id, f.doc_type, f.envelope, candidate, schemaFields, ocrText));
  }

  return {
    meta: {
      mode: "score",
      model: args.candidateDir ? "candidate" : "gold-self-score",
      ran_at: new Date().toISOString(),
      split: args.split,
      fixture_count: summaries.length,
    },
    per_fixture: summaries,
    per_doc_type: aggregateDocType(summaries),
  };
}

// Where extract mode writes candidate envelopes when --out is omitted.
function defaultExtractOutDir(): string {
  return path.join(REPO_ROOT, "eval", "candidates", timestamp());
}

export interface ExtractRunResult {
  out_dir: string;
  fixtures: { fixture_id: string; out_path: string }[];
  model: string;
}

// Runs Step 8b extraction against each matched fixture and writes the
// candidate envelope to <out>/<fixture_id>. Exported so the wiring test
// can drive it with a mocked ExtractorDeps (no API call, deterministic).
export async function runExtract(args: CliArgs, deps: ExtractorDeps): Promise<ExtractRunResult> {
  if (!args.live) {
    throw new Error("extract mode requires --live flag (gating gateway for spend bound)");
  }
  if (!args.fixtureCap) {
    throw new Error("extract --live requires --fixture-cap N");
  }

  const fixtures = loadFixtures({ split: args.split, docType: args.docType }).slice(0, args.fixtureCap);
  if (fixtures.length === 0) {
    throw new Error(`no fixtures matched split=${args.split} doc-type=${args.docType ?? "*"}`);
  }

  const missingOcr = fixtures.filter((f) => !f.source_text_path);
  if (missingOcr.length > 0) {
    const lines = missingOcr.map((f) => `  - ${f.fixture_id} (no source.txt in ${f.case_dir})`);
    throw new Error(
      `extract --live blocked: ${missingOcr.length}/${fixtures.length} fixtures lack OCR input.\n` +
        `Add source.txt next to the gold envelope (real OCR text from warehouse.documents.ocr_text).\n` +
        `Missing inputs:\n${lines.join("\n")}`,
    );
  }

  const missingExtractor = fixtures.filter((f) => !hasExtractorFor(f.doc_type));
  if (missingExtractor.length > 0) {
    const lines = missingExtractor.map((f) => `  - ${f.fixture_id} (doc_type "${f.doc_type}")`);
    throw new Error(
      `extract --live blocked: no V2 extractor config for these fixtures' doc_types.\n` +
        `Add the doc_type to scripts/eval/extractor.ts V2_CONFIGS, or filter with --doc-type.\n` +
        `Unsupported:\n${lines.join("\n")}`,
    );
  }

  const outDir = args.out ? path.resolve(args.out) : defaultExtractOutDir();
  const out: ExtractRunResult = { out_dir: outDir, fixtures: [], model: SONNET_MODEL };

  for (const f of fixtures) {
    const ocrText = readOcrText(f);
    if (!ocrText) {
      throw new Error(`extract --live: source.txt at ${f.source_text_path} returned empty content`);
    }
    const envelope = await extractEnvelope(ocrText, f.doc_type, deps);
    const outPath = path.join(outDir, f.fixture_id);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2));
    out.fixtures.push({ fixture_id: f.fixture_id, out_path: outPath });
    console.log(`  ✓ ${f.fixture_id} -> ${outPath}`);
  }

  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "extract") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const result = await runExtract(args, makeAnthropicDeps(apiKey));
    console.log(
      `extract complete: wrote ${result.fixtures.length} candidate envelope(s) to ${result.out_dir} (model=${result.model})`,
    );
    return;
  }

  const result = await runScore(args);
  const outPath = args.out ? path.resolve(args.out) : defaultOutputPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(
    `  mode=${result.meta.mode} split=${result.meta.split} fixtures=${result.meta.fixture_count}`,
  );
  for (const [docType, agg] of Object.entries(result.per_doc_type)) {
    console.log(
      `  ${docType}: exact=${agg.exact_match_rate.toFixed(3)} ` +
        `norm=${agg.normalized_match_rate.toFixed(3)} ` +
        `evidence=${agg.evidence_grounded_rate.toFixed(3)} ` +
        `absence=${agg.absence_state_correct_rate.toFixed(3)} ` +
        `severity_err=${agg.severity_weighted_error_rate.toFixed(3)}`,
    );
  }
}

// Only auto-run as a CLI when invoked directly. Tests import named
// exports from this file and must not trigger main() at import time.
const isCliEntry = (() => {
  try {
    const here = new URL(import.meta.url).pathname;
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return argv1 !== "" && path.resolve(here) === argv1;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export type { CliArgs };
export { parseArgs };
