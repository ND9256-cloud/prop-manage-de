// Brain shadow comparison classifier tests — Task 3.4.
//
// The three real divergences already seen in 3.3 (KO132 EG phantom vacancy,
// KO132 DG phantom vacancy, top-stats 100% vs 33% Vermietungsquote) must
// classify as known/informational. If any one of them ever lands in the
// `unknown` bucket, the nightly Discord alert will fire — and the fix should
// be either updating the classifier or accepting the new bucket as alert-worthy.
//
// Run:
//   npx tsx src/tests/scripts/brain-shadow-classify.test.ts

import {
  ALERT_CLASSES,
  classifyAggregate,
  classifyUnitPair,
  isAlertClass,
} from "../../../scripts/lib/brain-shadow-classify";

let passed = 0;
function ok(c: boolean, m: string) {
  if (!c) throw new Error(`Assertion failed: ${m}`);
  passed++;
  console.log(`  ✓ ${passed}. ${m}`);
}

console.log("Brain shadow comparison classifier tests\n");

// ---------------------------------------------------------------------------
// 1. KO132 EG case — composer vacant (no claim), legacy claims occupancy.
// ---------------------------------------------------------------------------

const ko132EG = classifyUnitPair(
  "EG",
  { occupancy_status: "vacant", kaltmiete_amount: null, tenant_name: null },
  { tenant_name: "Julija Paul", kaltmiete_amount: 57500 },
);
ok(ko132EG.length === 1, "KO132 EG produces exactly one divergence");
ok(
  ko132EG[0].divergence_class === "composer_vacant_legacy_occupied",
  "KO132 EG classifies as composer_vacant_legacy_occupied",
);
ok(ko132EG[0].alert === false, "KO132 EG is informational (no alert)");
ok(ko132EG[0].divergent_field === "occupancy_status", "KO132 EG divergent_field is occupancy_status");

// ---------------------------------------------------------------------------
// 2. KO132 DG case — composer vacant, legacy knew Saniye Kuru.
// ---------------------------------------------------------------------------

const ko132DG = classifyUnitPair(
  "DG",
  { occupancy_status: "vacant", kaltmiete_amount: null, tenant_name: null },
  { tenant_name: "Saniye Kuru", kaltmiete_amount: 47000 },
);
ok(ko132DG.length === 1, "KO132 DG produces exactly one divergence");
ok(
  ko132DG[0].divergence_class === "composer_vacant_legacy_occupied",
  "KO132 DG classifies as composer_vacant_legacy_occupied",
);
ok(ko132DG[0].alert === false, "KO132 DG is informational (no alert)");

// ---------------------------------------------------------------------------
// 3. Genuine kaltmiete mismatch — alert.
// ---------------------------------------------------------------------------

const mismatch = classifyUnitPair(
  "1.OG",
  { occupancy_status: "occupied", kaltmiete_amount: 65000, tenant_name: "Lena Everding" },
  { tenant_name: "Lena Everding", kaltmiete_amount: 70000 },
);
ok(mismatch.length === 1, "kaltmiete mismatch yields one divergence");
ok(
  mismatch[0].divergence_class === "kaltmiete_amount_mismatch",
  "kaltmiete mismatch classifies as kaltmiete_amount_mismatch",
);
ok(mismatch[0].alert === true, "kaltmiete mismatch ALERTS");
ok(mismatch[0].divergent_field === "kaltmiete", "kaltmiete mismatch field is kaltmiete");

// ---------------------------------------------------------------------------
// 4. Agreement — empty array.
// ---------------------------------------------------------------------------

const agree = classifyUnitPair(
  "1.OG",
  { occupancy_status: "occupied", kaltmiete_amount: 65000, tenant_name: "Lena Everding" },
  { tenant_name: "Lena Everding", kaltmiete_amount: 65000 },
);
ok(agree.length === 0, "occupied agreement produces no divergence rows");

const agreeVacant = classifyUnitPair(
  "EG",
  { occupancy_status: "vacant", kaltmiete_amount: null, tenant_name: null },
  { tenant_name: null, kaltmiete_amount: null },
);
ok(agreeVacant.length === 0, "vacant agreement produces no divergence rows");

// ---------------------------------------------------------------------------
// 5. Vermietungsquote mismatch — the 100%-vs-33% case from 3.3 top stats.
// ---------------------------------------------------------------------------

const verm = classifyAggregate(
  { vermietungsquote: 0.3333, total_kaltmiete: 65000 },
  { vermietungsquote: 1.0, total_kaltmiete: 359500 },
);
ok(
  verm.some(d => d.divergence_class === "vermietungsquote_mismatch"),
  "33%-vs-100% classifies as vermietungsquote_mismatch",
);
const vermRow = verm.find(d => d.divergence_class === "vermietungsquote_mismatch")!;
ok(vermRow.alert === false, "vermietungsquote_mismatch is informational");

// ---------------------------------------------------------------------------
// 6. composer_missing_unit — legacy knew a unit composer doesn't have.
// ---------------------------------------------------------------------------

const missing = classifyUnitPair(
  "KG",
  null,
  { tenant_name: "Some Tenant", kaltmiete_amount: 30000 },
);
ok(missing.length === 1, "composer_missing_unit produces one divergence");
ok(
  missing[0].divergence_class === "composer_missing_unit",
  "missing-from-composer classifies as composer_missing_unit",
);
ok(missing[0].alert === true, "composer_missing_unit ALERTS");

// ---------------------------------------------------------------------------
// 7. legacy_missing_unit — composer has a unit legacy never knew about.
// ---------------------------------------------------------------------------

const legacyMissing = classifyUnitPair(
  "2.OG",
  { occupancy_status: "vacant", kaltmiete_amount: null, tenant_name: null },
  null,
);
ok(legacyMissing.length === 1, "legacy_missing_unit produces one divergence");
ok(
  legacyMissing[0].divergence_class === "legacy_missing_unit",
  "missing-from-legacy classifies as legacy_missing_unit",
);
ok(legacyMissing[0].alert === false, "legacy_missing_unit is informational");

// ---------------------------------------------------------------------------
// 8. composer_occupied_legacy_vacant — legacy stale.
// ---------------------------------------------------------------------------

const stale = classifyUnitPair(
  "1.OG",
  { occupancy_status: "occupied", kaltmiete_amount: 65000, tenant_name: "Lena Everding" },
  { tenant_name: null, kaltmiete_amount: null },
);
ok(stale.length === 1, "composer_occupied_legacy_vacant produces one divergence");
ok(
  stale[0].divergence_class === "composer_occupied_legacy_vacant",
  "occupied/legacy-empty classifies as composer_occupied_legacy_vacant",
);
ok(stale[0].alert === false, "composer_occupied_legacy_vacant is informational");

// ---------------------------------------------------------------------------
// 9. Unknown — structurally weird input.
// ---------------------------------------------------------------------------

const weird = classifyUnitPair(
  "?",
  { occupancy_status: "needs_review", kaltmiete_amount: 65000, tenant_name: null },
  { tenant_name: "Someone", kaltmiete_amount: 65000 },
);
ok(weird.length === 1, "needs_review + legacy occupied classifies as one divergence");
ok(weird[0].divergence_class === "unknown", "needs_review+occupied unknown");
ok(weird[0].alert === true, "unknown class ALERTS");

const bothNull = classifyUnitPair("phantom", null, null);
ok(bothNull.length === 1, "both-null is one unknown row");
ok(bothNull[0].divergence_class === "unknown", "both-null classifies as unknown");
ok(bothNull[0].alert === true, "both-null ALERTS");

// ---------------------------------------------------------------------------
// 10. ALERT_CLASSES set integrity.
// ---------------------------------------------------------------------------

ok(ALERT_CLASSES.has("kaltmiete_amount_mismatch"), "ALERT_CLASSES includes kaltmiete_amount_mismatch");
ok(ALERT_CLASSES.has("composer_missing_unit"), "ALERT_CLASSES includes composer_missing_unit");
ok(ALERT_CLASSES.has("unknown"), "ALERT_CLASSES includes unknown");
ok(!ALERT_CLASSES.has("composer_vacant_legacy_occupied"), "ALERT_CLASSES excludes composer_vacant_legacy_occupied");
ok(!ALERT_CLASSES.has("vermietungsquote_mismatch"), "ALERT_CLASSES excludes vermietungsquote_mismatch");
ok(!ALERT_CLASSES.has("legacy_missing_unit"), "ALERT_CLASSES excludes legacy_missing_unit");
ok(isAlertClass("unknown") === true, "isAlertClass('unknown') === true");
ok(isAlertClass("legacy_missing_unit") === false, "isAlertClass('legacy_missing_unit') === false");

// ---------------------------------------------------------------------------
// 11. classifyAggregate — null legacy still records informational divergence.
// ---------------------------------------------------------------------------

const aggNullLegacy = classifyAggregate(
  { vermietungsquote: 0.5, total_kaltmiete: 100000 },
  { vermietungsquote: null, total_kaltmiete: null },
);
ok(
  aggNullLegacy.some(d => d.divergence_class === "vermietungsquote_mismatch" && !d.alert),
  "null-legacy vermietungsquote records informational mismatch",
);

// total_kaltmiete with null on either side: no divergence row.
const aggNullTotal = classifyAggregate(
  { vermietungsquote: 0.5, total_kaltmiete: null },
  { vermietungsquote: 0.5, total_kaltmiete: 100000 },
);
ok(
  !aggNullTotal.some(d => d.divergence_class === "total_kaltmiete_mismatch"),
  "null composer total_kaltmiete does not produce total_kaltmiete_mismatch",
);

// ---------------------------------------------------------------------------
// 12. classifyAggregate — both sides agree, no rows.
// ---------------------------------------------------------------------------

const aggAgree = classifyAggregate(
  { vermietungsquote: 1.0, total_kaltmiete: 359500 },
  { vermietungsquote: 1.0, total_kaltmiete: 359500 },
);
ok(aggAgree.length === 0, "fully-agreeing aggregate produces no rows");

// ---------------------------------------------------------------------------
// 13. The 3.3 follow-up framing: three real divergences classify NON-alerting.
// ---------------------------------------------------------------------------
//
// This is the explicit contract from the task brief: shadow mode should NOT
// alert on the three already-known divergences from 3.3. If this assertion
// ever fails, either the classifier regressed or a new alert class is genuinely
// warranted.

const allKnownAlertCount =
  ko132EG.filter(d => d.alert).length +
  ko132DG.filter(d => d.alert).length +
  verm.filter(d => d.alert).length;
ok(
  allKnownAlertCount === 0,
  "the three known 3.3 divergences produce ZERO alerts in aggregate",
);

console.log(`\n✅ All ${passed} assertions passed.`);
