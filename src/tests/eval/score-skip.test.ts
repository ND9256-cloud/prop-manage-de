// Regression test for Task 4.2b: score mode SKIPS fixtures that have no
// candidate envelope instead of scoring them as a total failure.
//
// The bug: a missing candidate was scored field-by-field against an empty
// envelope, marking every field a miss and dragging the aggregates down
// (the misleading 0.96 error rate). The fix: skip such fixtures, report
// them separately, and compute aggregates over scored fixtures only.
//
// This test drives computeScore (the pure scoring core) with three
// fixtures of which exactly ONE has a candidate. It asserts scored=1,
// skipped=2, and that the per_doc_type aggregate equals the single scored
// fixture's own rates — i.e. it is NOT dragged down by the two skips.

import assert from "node:assert/strict";

import { computeScore } from "../../../scripts/eval/run.ts";
import { scoreFixture } from "../../../scripts/eval/metrics.ts";
import { loadSchemaFields } from "../../../scripts/eval/loader.ts";
import type { LoadedFixture } from "../../../scripts/eval/loader.ts";
import type { ExtractionEnvelope } from "../../../scripts/eval/types.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

const DOC_TYPE = "mietvertrag";

// A well-formed gold envelope for the real mietvertrag schema. Used both as
// gold and (for the one scored fixture) as its own candidate, so the scored
// fixture is a clean self-score with rates we can recompute independently.
function goldEnvelope(): ExtractionEnvelope {
  return {
    doc_type: DOC_TYPE,
    schema_version: "2026-05-21-v1",
    fields: {
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
        raw_value: "Max Mustermann",
        normalized_value: { name: "Max Mustermann", is_legal_entity: false },
        evidence: [{ quote: "Mieter: Max Mustermann", page: 1, bbox: null }],
        confidence: "high",
        absence_state: "present",
        validation_status: "valid",
      },
      landlord_identity: {
        raw_value: "Petra Denn",
        normalized_value: { name: "Petra Denn", is_legal_entity: false },
        evidence: [{ quote: "Vermieter: Petra Denn", page: 1, bbox: null }],
        confidence: "high",
        absence_state: "present",
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
    },
  };
}

// Build a minimal in-memory LoadedFixture. No files touched: source paths
// are null (so readOcrText returns undefined, exactly like a fixture
// without OCR), and the envelope is supplied directly.
function fixture(id: string, envelope: ExtractionEnvelope): LoadedFixture {
  return {
    fixture_id: id,
    doc_type: envelope.doc_type,
    case_dir: `/virtual/${id}`,
    envelope_path: `/virtual/${id}/${DOC_TYPE}.json`,
    envelope,
    source_text_path: null,
    source_pdf_path: null,
    meta: { split: "gold", tags: [] },
  };
}

const gold = goldEnvelope();
const fixtures: LoadedFixture[] = [
  fixture("scored/has-candidate/mietvertrag.json", gold),
  fixture("skipped/no-candidate-a/mietvertrag.json", goldEnvelope()),
  fixture("skipped/no-candidate-b/mietvertrag.json", goldEnvelope()),
];

// Candidate exists for the first fixture only; the other two return undefined.
const candidateById: Record<string, ExtractionEnvelope> = {
  "scored/has-candidate/mietvertrag.json": gold,
};
const getCandidate = (f: LoadedFixture): ExtractionEnvelope | undefined =>
  candidateById[f.fixture_id];

const result = computeScore(fixtures, getCandidate, { split: "all", candidateMode: true });

// 1 scored, 2 skipped.
eq(result.meta.fixture_count, 1, "scored count = 1");
eq(result.per_fixture.length, 1, "per_fixture holds only the scored fixture");
eq(result.skipped_no_candidate.length, 2, "skipped count = 2");
eq(
  [...result.skipped_no_candidate].sort(),
  ["skipped/no-candidate-a/mietvertrag.json", "skipped/no-candidate-b/mietvertrag.json"],
  "skipped fixture_ids are the two without a candidate",
);
eq(
  result.per_fixture[0].fixture_id,
  "scored/has-candidate/mietvertrag.json",
  "the scored fixture is the one with a candidate",
);

// The aggregate must equal the single scored fixture's own rates — NOT
// dragged toward zero by the two skipped fixtures. Recompute the lone
// fixture's summary directly and compare.
const schemaFields = loadSchemaFields(DOC_TYPE);
ok(schemaFields.length > 0, "mietvertrag schema fields loaded");
const expected = scoreFixture(
  "scored/has-candidate/mietvertrag.json",
  DOC_TYPE,
  gold,
  gold,
  schemaFields,
  undefined,
);

const agg = result.per_doc_type[DOC_TYPE];
ok(!!agg, "per_doc_type has a mietvertrag aggregate");
eq(agg.fixture_count, 1, "aggregate counts only the scored fixture");
eq(agg.exact_match_rate, expected.exact_match_rate, "aggregate exact_match_rate == scored fixture's");
eq(agg.normalized_match_rate, expected.normalized_match_rate, "aggregate normalized_match_rate == scored fixture's");
eq(agg.evidence_grounded_rate, expected.evidence_grounded_rate, "aggregate evidence_grounded_rate == scored fixture's");
eq(agg.absence_state_correct_rate, expected.absence_state_correct_rate, "aggregate absence_state_correct_rate == scored fixture's");
eq(agg.severity_weighted_error_rate, expected.severity_weighted_error_rate, "aggregate severity_weighted_error_rate == scored fixture's");

// Self-score sanity: the metrics that don't depend on OCR are perfect, so
// the aggregate is genuinely high — proof the two skips didn't poison it.
eq(agg.exact_match_rate, 1, "self-scored exact_match_rate is 1 (not dragged down)");
eq(agg.normalized_match_rate, 1, "self-scored normalized_match_rate is 1 (not dragged down)");
eq(agg.absence_state_correct_rate, 1, "self-scored absence_state_correct_rate is 1 (not dragged down)");

console.log(`✓ score-skip.test.ts: ${assertions} assertions passed`);
