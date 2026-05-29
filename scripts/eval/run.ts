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

function runExtract(args: CliArgs): never {
  // Task 4.1 ships the scaffolding only. extract --live requires:
  //   1. --live flag (present)
  //   2. --fixture-cap N (present, positive)
  //   3. matched fixtures with source.txt OCR inputs (the gap)
  //
  // The first two are validated before this function runs. Here we
  // load fixtures and report whether their OCR inputs exist. If any
  // do not, we error cleanly (task: "extract mode is blocked until
  // inputs exist (4.3)").
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
  const missing = fixtures.filter((f) => !f.source_text_path);
  if (missing.length > 0) {
    const lines = missing.map((f) => `  - ${f.fixture_id} (no source.txt in ${f.case_dir})`);
    throw new Error(
      `extract --live blocked: ${missing.length}/${fixtures.length} fixtures lack OCR input.\n` +
        `Fixture inputs (OCR text Step 8b consumes) are produced by Task 4.3 gold-set work. ` +
        `Until then, extract --live cannot run.\n` +
        `Missing inputs:\n${lines.join("\n")}`
    );
  }
  // Unreachable today: no fixture has an OCR input file (see Task 4.3).
  // When 4.3 lands, this is where we'd invoke Step 8b extraction
  // and write candidate envelopes. The wiring is intentionally out
  // of scope here to keep 4.1 a pure scaffolding PR.
  throw new Error(
    "extract --live reached the extraction step but the live extractor wiring is deferred. " +
      "Scaffolding only in Task 4.1; Task 4.5 wires the candidate models (Sonnet + Opus)."
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let result: EvalRunResult;
  if (args.mode === "extract") {
    runExtract(args); // throws
    return;           // unreachable, satisfies TS
  } else {
    result = await runScore(args);
  }

  const outPath = args.out ? path.resolve(args.out) : defaultOutputPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(
    `  mode=${result.meta.mode} split=${result.meta.split} fixtures=${result.meta.fixture_count}`
  );
  for (const [docType, agg] of Object.entries(result.per_doc_type)) {
    console.log(
      `  ${docType}: exact=${agg.exact_match_rate.toFixed(3)} ` +
        `norm=${agg.normalized_match_rate.toFixed(3)} ` +
        `evidence=${agg.evidence_grounded_rate.toFixed(3)} ` +
        `absence=${agg.absence_state_correct_rate.toFixed(3)} ` +
        `severity_err=${agg.severity_weighted_error_rate.toFixed(3)}`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
