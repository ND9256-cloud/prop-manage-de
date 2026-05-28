// PLZ verifier tests — architecture §10. The Kuru hallucinated-address case
// (36270 Eosbacher Str. near Schauenburg) is the canonical failure.
//
// Run:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/plz-verifier.test.ts

import {
  checkPlz,
  extractPlz,
  plzVerifier,
} from "../../supabase/functions/process-document/verifiers/plz";

let passed = 0;
function ok(c: boolean, m: string) {
  if (!c) throw new Error(`Assertion failed: ${m}`);
  passed++;
  console.log(`  ✓ ${passed}. ${m}`);
}

console.log("PLZ verifier tests\n");

// --- checkPlz: valid codes ---
ok(checkPlz("34270").ok === true, "34270 (Schauenburg) is valid");
ok(checkPlz("34270").found_bundesland === "Hessen", "34270 → Hessen");
ok(checkPlz("10115").found_bundesland === "Berlin", "10115 → Berlin");
ok(checkPlz("80331").found_bundesland === "Bayern", "80331 (München) → Bayern");
ok(checkPlz("20095").found_bundesland === "Hamburg", "20095 → Hamburg");
ok(checkPlz("01067").found_bundesland === "Sachsen", "01067 (Dresden) → Sachsen");

// --- THE KURU CASE: 36270 does not exist ---
ok(checkPlz("36270").ok === false, "KURU: 36270 fails (not a valid German PLZ)");
ok(checkPlz("36270").reason === "not_found", "KURU: 36270 reason === not_found");
ok(checkPlz("36270").found_bundesland === null, "KURU: 36270 has no Bundesland");

// --- malformed input ---
ok(checkPlz("3627").ok === false, "4-digit input fails");
ok(checkPlz("362700").ok === false, "6-digit input fails");
ok(checkPlz("ABCDE").ok === false, "non-numeric input fails");
ok(checkPlz("").ok === false, "empty input fails");

// --- Bundesland mismatch ---
ok(checkPlz("34270", "Hessen").ok === true, "34270 with expected Hessen passes");
ok(checkPlz("34270", "Bayern").ok === false, "34270 with expected Bayern fails");
ok(checkPlz("34270", "Bayern").reason === "bundesland_mismatch", "mismatch reason correct");
ok(checkPlz("34270", "hessen").ok === true, "Bundesland match is case-insensitive");

// --- extractPlz ---
ok(extractPlz("Korbacher Str. 132, 34270 Schauenburg") === "34270", "extract PLZ from full address");
ok(extractPlz("36270 Eosbacher Str.") === "36270", "extract hallucinated PLZ from Kuru string");
ok(extractPlz("no postal code here") === null, "no PLZ → null");

// --- plzVerifier wrapper (architecture §10 semantics) ---
const kuru = plzVerifier({ value: "36270 Eosbacher Str." });
ok(kuru.validation_status === "requires_human_review", "KURU verifier: requires_human_review");
ok(kuru.confidence_override === "low", "KURU verifier: confidence downgraded to low");
ok(kuru.detail !== null && kuru.detail.includes("36270"), "KURU verifier: detail names the bad PLZ");

const good = plzVerifier({ value: "Korbacher Str. 132, 34270 Schauenburg" });
ok(good.validation_status === "valid", "valid address: validation_status valid");
ok(good.confidence_override === null, "valid address: no confidence override");

const mismatch = plzVerifier({ value: "34270 Schauenburg", expectedBundesland: "Bayern" });
ok(mismatch.validation_status === "requires_human_review", "mismatch verifier: requires_human_review");
ok(mismatch.detail !== null && mismatch.detail.includes("Hessen"), "mismatch detail names found Bundesland");

const noPlz = plzVerifier({ value: "some address with no code" });
ok(noPlz.validation_status === "valid", "address without PLZ: nothing to verify, valid");

console.log(`\n✓ ${passed} PLZ verifier assertions passed`);
console.log("✓ Kuru hallucinated-address case (36270) structurally caught");
