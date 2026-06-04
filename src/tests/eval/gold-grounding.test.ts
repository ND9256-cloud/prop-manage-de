// Gold-self-grounding invariant (Task 4.3b).
//
// A fixture layout is only sound if every gold envelope resolves to its OWN
// source OCR. This test locks that with a CI invariant: for every gold envelope
// WITH a non-null resolved source, every PRESENT, NON-DERIVED field MUST ground
// at grade 3 (the Task 4.3a / 4.3a-names grade) in that envelope's own source.
// A gold value that does not ground in its own document is a hard failure — the
// fixture is mislabeled or pointed at the wrong OCR.
//
// Skipped (NOT failures):
//   - fields with absence_state != "present" (absent / not_applicable / …):
//     there is no asserted value to ground.
//   - derived/composite fields (unit_ref etc.): deferred to Task 4.3c.
//   - non-gradeable fields (no grounding spec, or excluded as non_scalar):
//     out of scope for this invariant.
//   - whole envelopes whose source resolves to null: reported as
//     `pending_source` (multi-envelope dirs whose per-doc OCR is not yet
//     backfilled — WS3), NEVER as a failure.
//
// Pure, DB-free, API-free: loads on-disk fixtures + the generated GROUNDING_SPECS
// and the deterministic groundingGrade. No Anthropic call, no re-extraction.

import assert from "node:assert/strict";

import { loadFixtures, loadGroundingSpecs, readOcrText } from "../../../scripts/eval/loader.ts";
import { groundingGrade } from "../../../scripts/eval/metrics.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}

interface FieldFailure {
  fixture_id: string;
  field_id: string;
  grade: number | null;
}

// Task 4.3c-a: derived fields graded by c-a are REPORTED with their grade but do
// NOT hard-fail this invariant (hard-gating of derived fields waits until 4.3c is
// complete). Lena's unit_ref must not break the green gate regardless of grade.
interface DerivedReport {
  fixture_id: string;
  field_id: string;
  grade: number | null;
  excluded: string | null;
}

async function main() {
const fixtures = loadFixtures();
ok(fixtures.length > 0, "gold-grounding: at least one fixture loaded");

const assertedEnvelopes: string[] = [];
const pendingSource: string[] = [];
const failures: FieldFailure[] = [];
const derivedReports: DerivedReport[] = [];

for (const f of fixtures) {
  const ocr = f.source_text_path ? readOcrText(f) : undefined;
  if (!ocr) {
    // Source resolves to null (or is unreadable) → not assertable yet.
    pendingSource.push(f.fixture_id);
    continue;
  }
  assertedEnvelopes.push(f.fixture_id);

  const specs = await loadGroundingSpecs(f.doc_type);
  for (const [fieldId, goldField] of Object.entries(f.envelope.fields)) {
    // Only PRESENT fields carry a value to ground.
    if (goldField.absence_state !== "present") continue;
    const spec = specs[fieldId];
    if (!spec) continue;        // no grounding spec → not part of the invariant

    const r = groundingGrade(spec, goldField, ocr);

    // Derived fields (e.g. unit_ref): REPORT-ONLY in c-a — captured with their
    // grade for visibility but never gated (composite derived → derived_pending;
    // single-source derived → 0/1/3). They do NOT contribute to `failures`.
    if (spec.derived) {
      derivedReports.push({ fixture_id: f.fixture_id, field_id: fieldId, grade: r.grade, excluded: r.excluded });
      continue;
    }

    if (!r.graded) continue;    // excluded (non_scalar/…) → not assertable here

    if (r.grade !== 3) {
      failures.push({ fixture_id: f.fixture_id, field_id: fieldId, grade: r.grade });
    }
  }
}

// ── Summary (always printed) ──────────────────────────────────────────────
console.log(
  `gold-grounding: asserted_envelopes=${assertedEnvelopes.length} ` +
    `pending_source=${pendingSource.length} failures=${failures.length}`,
);
for (const id of assertedEnvelopes) console.log(`  asserted     ${id}`);
for (const id of pendingSource) console.log(`  pending_src  ${id}`);
for (const fail of failures) {
  console.log(`  BELOW GRADE 3  ${fail.fixture_id} :: ${fail.field_id} → grade ${fail.grade}`);
}
// Derived fields (report-only, NOT gated in 4.3c-a).
for (const d of derivedReports) {
  const verdict = d.excluded ? `excluded ${d.excluded}` : `grade ${d.grade}`;
  console.log(`  derived(rpt)   ${d.fixture_id} :: ${d.field_id} → ${verdict}`);
}

// ── Lena (single-envelope dir) MUST be asserted at grade 3 ─────────────────
const lenaId = "mietvertrag/everding-ko132-1og/expected.json";
ok(
  assertedEnvelopes.includes(lenaId),
  "gold-grounding: Lena (single-envelope dir) resolves to her own source and is asserted",
);
ok(
  !pendingSource.includes(lenaId),
  "gold-grounding: Lena is NOT pending_source",
);
ok(
  !failures.some((x) => x.fixture_id === lenaId),
  "gold-grounding: Lena's present non-derived fields all ground at grade 3",
);
// Task 4.3c-a: Lena's unit_ref (derived) is REPORTED, never a failure. Its grade
// is whatever is honest (her evidence is a table cell, not a clean floor phrase),
// and it must not gate the green invariant.
ok(
  derivedReports.some((d) => d.fixture_id === lenaId && d.field_id === "unit_ref"),
  "gold-grounding: Lena's unit_ref is reported as a derived field (report-only)",
);
ok(
  !failures.some((x) => x.fixture_id === lenaId && x.field_id === "unit_ref"),
  "gold-grounding: Lena's unit_ref (derived) never hard-fails the invariant in 4.3c-a",
);

// ── Known multi-envelope secondaries MUST be pending_source, not failed ────
// hofmann (3 envelopes) + the three supersession dirs (2 envelopes each) share
// one source.txt today, so per-envelope resolution returns null for each → they
// are reported pending_source until WS3 backfills per-doc OCR. They must never
// appear as a grounding failure.
const expectedPending = [
  "hofmann/hhs55-dg/auszug.json",
  "hofmann/hhs55-dg/eigentuemerwechsel.json",
  "hofmann/hhs55-dg/mietvertrag.json",
  "supersession/kuru-ko132-dg/mieterhoehung.json",
  "supersession/kuru-ko132-dg/mietvertrag.json",
  "supersession/paul-ko132-eg/mieterhoehung.json",
  "supersession/paul-ko132-eg/mietvertrag.json",
  "supersession/weber-hhs55-og/mieterhoehung.json",
  "supersession/weber-hhs55-og/mietvertrag.json",
];
for (const id of expectedPending) {
  ok(pendingSource.includes(id), `gold-grounding: multi-envelope secondary ${id} is pending_source`);
  ok(!assertedEnvelopes.includes(id), `gold-grounding: ${id} is not asserted (shared source not its own)`);
  ok(!failures.some((x) => x.fixture_id === id), `gold-grounding: ${id} is not a failure`);
}

// ── The invariant itself: zero fields below grade 3 across asserted envelopes ─
ok(
  failures.length === 0,
  `gold-grounding: every asserted gold field grounds at grade 3 (${failures.length} below-grade-3 failures)`,
);

console.log(`✓ gold-grounding.test.ts: ${assertions} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
