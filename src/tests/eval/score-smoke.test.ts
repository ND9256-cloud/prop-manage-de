// Smoke test: score mode against the existing real fixtures.
// Gold-vs-gold MUST produce zero severity-weighted error and a
// well-formed result document.
//
// Caveat: evidence_grounded is only checked when a source OCR text
// file exists alongside the fixture. Today only the Lena fixture has
// a source.pdf (no .txt). Until Task 4.3 produces OCR text inputs,
// the smoke asserts:
//   - exact_match_rate == 1
//   - normalized_match_rate == 1
//   - absence_state_correct_rate == 1
//   - severity_weighted_error_rate considers evidence (and may be
//     non-zero where OCR text is missing).

import assert from "node:assert/strict";

import { loadFixtures, loadSchemaFields, readOcrText } from "../../../scripts/eval/loader.ts";
import { scoreFixture } from "../../../scripts/eval/metrics.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

const fixtures = loadFixtures();
ok(fixtures.length > 0, "score smoke: at least one fixture loaded from tests/fixtures/extraction/");

for (const f of fixtures) {
  const schemaFields = loadSchemaFields(f.doc_type);
  if (schemaFields.length === 0) {
    // Some synthetic fixtures use doc_types we haven't fully wired into
    // schemas — skip them; the loader's job is to surface real fixtures.
    continue;
  }
  const ocr = readOcrText(f);
  const summary = scoreFixture(f.fixture_id, f.doc_type, f.envelope, f.envelope, schemaFields, ocr);
  // Structural assertions.
  eq(summary.doc_type, f.doc_type, `summary.doc_type matches for ${f.fixture_id}`);
  eq(summary.fixture_id, f.fixture_id, `summary.fixture_id matches for ${f.fixture_id}`);
  ok(Array.isArray(summary.fields), `summary.fields is array for ${f.fixture_id}`);
  ok(summary.fields.length > 0, `summary.fields non-empty for ${f.fixture_id}`);
  // Gold-vs-gold guarantees on the three metrics that don't depend on
  // source text:
  eq(summary.exact_match_rate, 1, `exact_match_rate=1 for self-score ${f.fixture_id}`);
  eq(summary.normalized_match_rate, 1, `normalized_match_rate=1 for self-score ${f.fixture_id}`);
  eq(summary.absence_state_correct_rate, 1, `absence_state_correct_rate=1 for self-score ${f.fixture_id}`);
  // Rates must be in [0, 1].
  ok(
    summary.severity_weighted_error_rate >= 0 && summary.severity_weighted_error_rate <= 1,
    `severity_weighted_error_rate in [0,1] for ${f.fixture_id}`
  );
}

console.log(`✓ score-smoke.test.ts: ${assertions} assertions passed across ${fixtures.length} fixtures`);
