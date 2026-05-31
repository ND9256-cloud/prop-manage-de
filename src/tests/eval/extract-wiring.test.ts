// Deterministic wiring test for extract mode. No Anthropic API calls.
//
// What this asserts:
//   - runExtract with a mocked callSonnet reads source.txt from a real
//     fixture, calls the mock, validates the envelope shape, and writes
//     a candidate envelope to <out>/<fixture_id>.
//   - The candidate file is well-formed JSON, has the expected fields,
//     and carries the production schema_version + Sonnet model id.
//   - The prompt handed to Sonnet contains the OCR text and the schema
//     prompt fragment — so we know the extractor wired the right pieces.
//
// This test is the CI gate. The live smoke (real Sonnet call) is manual
// and lives in 4.1b's PR notes, not in this file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runExtract } from "../../../scripts/eval/run.ts";
import { SONNET_MODEL, type ExtractorDeps } from "../../../scripts/eval/extractor.ts";
import { loadFixtures } from "../../../scripts/eval/loader.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

// A minimal mietvertrag envelope that the schema validator accepts.
// Mirrors the shape generateV2Envelope produces, with one "present"
// field (kaltmiete) so the verifier sweep runs and the resulting
// envelope is non-trivially well-formed.
const MOCK_FIELDS = {
  kaltmiete: {
    raw_value: "650,00 Euro",
    normalized_value: { amount: 65000, currency: "EUR" },
    evidence: [{ quote: "Die Grundmiete beträgt monatlich 650,00 Euro", page: 1, bbox: null }],
    confidence: "high",
    absence_state: "present",
    validation_status: "valid",
  },
  unit_ref: {
    raw_value: "1.OG",
    normalized_value: "1.OG",
    evidence: [{ quote: "1. Obergeschoss", page: 1, bbox: null }],
    confidence: "high",
    absence_state: "present",
    validation_status: "valid",
  },
  tenant_identity: {
    raw_value: null,
    normalized_value: null,
    evidence: [],
    confidence: null,
    absence_state: "absent",
    validation_status: "valid",
  },
  landlord_identity: {
    raw_value: null,
    normalized_value: null,
    evidence: [],
    confidence: null,
    absence_state: "absent",
    validation_status: "valid",
  },
  mietbeginn: {
    raw_value: "01.04.2025",
    normalized_value: "2025-04-01",
    evidence: [{ quote: "Mietbeginn 01.04.2025", page: 1, bbox: null }],
    confidence: "high",
    absence_state: "present",
    validation_status: "valid",
  },
  mietende: {
    raw_value: null,
    normalized_value: null,
    evidence: [],
    confidence: null,
    absence_state: "not_applicable",
    validation_status: "valid",
  },
  nebenkostenvorauszahlung: {
    raw_value: null,
    normalized_value: null,
    evidence: [],
    confidence: null,
    absence_state: "absent",
    validation_status: "valid",
  },
  kaution: {
    raw_value: null,
    normalized_value: null,
    evidence: [],
    confidence: null,
    absence_state: "absent",
    validation_status: "valid",
  },
};

let lastPromptSeen: string | null = null;
const mockDeps: ExtractorDeps = {
  async callSonnet(prompt: string) {
    lastPromptSeen = prompt;
    return JSON.stringify(MOCK_FIELDS);
  },
};

async function main() {
// Sanity-check that the Lena Mietvertrag fixture has source.txt — Task 4.1b
// adds this so live extraction has real OCR to feed Sonnet.
const fixtures = loadFixtures({ docType: "mietvertrag" });
const lena = fixtures.find((f) => f.fixture_id.startsWith("mietvertrag/everding-ko132-1og/"));
ok(!!lena, "wiring test: Lena fixture found");
ok(!!lena!.source_text_path, "wiring test: Lena source.txt exists (Task 4.1b added it)");

// loadFixtures sorts deterministically; with --fixture-cap=1 we take the
// first matching mietvertrag fixture (whichever it is). What matters for
// wiring is the candidate envelope shape, not which fixture supplied OCR.
const expectedFixtureId = fixtures[0]!.fixture_id;

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-extract-wiring-"));
try {
  const result = await runExtract(
    { mode: "extract", split: "all", docType: "mietvertrag", live: true, fixtureCap: 1, out: outDir },
    mockDeps,
  );

  eq(result.model, SONNET_MODEL, "wiring test: result advertises Sonnet model");
  eq(result.fixtures.length, 1, "wiring test: exactly one fixture extracted (--fixture-cap=1)");
  eq(result.fixtures[0].fixture_id, expectedFixtureId, "wiring test: first matching fixture was extracted");

  const candidatePath = result.fixtures[0].out_path;
  ok(fs.existsSync(candidatePath), `wiring test: candidate envelope written to ${candidatePath}`);

  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  eq(candidate.doc_type, "mietvertrag", "wiring test: candidate doc_type");
  eq(candidate.model, SONNET_MODEL, "wiring test: candidate.model is Sonnet");
  ok(typeof candidate.schema_version === "string" && candidate.schema_version.length > 0, "wiring test: schema_version populated");
  ok(typeof candidate.fields === "object" && candidate.fields !== null, "wiring test: candidate.fields is object");
  ok("kaltmiete" in candidate.fields, "wiring test: kaltmiete present");
  eq(candidate.fields.kaltmiete.severity, "critical", "wiring test: severity injected from schema");
  eq(candidate.fields.kaltmiete.normalized_value.amount, 65000, "wiring test: kaltmiete normalized amount");

  // Lifecycle block was built from the extracted dates.
  eq(candidate.lifecycle.effective_date, "2025-04-01", "wiring test: lifecycle.effective_date = mietbeginn");
  eq(candidate.lifecycle.document_status, "active", "wiring test: lifecycle.document_status active");

  // Prompt contained the schema fragment and the OCR text.
  ok(lastPromptSeen !== null, "wiring test: callSonnet was invoked");
  ok(lastPromptSeen!.includes("kaltmiete"), "wiring test: prompt includes the kaltmiete schema field");
  ok(lastPromptSeen!.includes("Dokumenttext:"), "wiring test: prompt includes the OCR section");
  // The prompt always contains the OCR section header, and after it some
  // actual OCR text (we don't know which fixture was first; just that the
  // Dokumenttext block is non-empty).
  const dokIdx = lastPromptSeen!.indexOf("Dokumenttext:");
  ok(dokIdx >= 0 && lastPromptSeen!.slice(dokIdx + "Dokumenttext:".length).trim().length > 0, "wiring test: prompt body contains OCR content");

  // The output path lives inside outDir and mirrors fixture_id structure.
  ok(candidatePath.startsWith(outDir), "wiring test: candidate path under --out dir");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`✓ extract-wiring.test.ts: ${assertions} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
