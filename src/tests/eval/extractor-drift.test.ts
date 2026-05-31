// Drift guard for the eval extractor (Task 4.1b-followup).
//
// The eval extractor (scripts/eval/extractor.ts) re-hosts production Step 8b
// for Node. Two pieces of production behaviour cannot be imported directly:
//
//   1. The German system-prompt wrapper. It lives in the Deno Edge Function
//      (supabase/functions/process-document/index.ts) and is duplicated
//      verbatim in extractor.ts. This test reads both source files, extracts
//      each wrapper template literal, normalizes the `${...}` interpolations
//      (only the variable names differ), and asserts they are byte-identical.
//      If production edits the wrapper without updating the eval copy, this
//      fails.
//
//   2. The field specs + verifier refs. These are now driven from the schema
//      source via schemas/mietvertrag/generated/field_specs.ts (regenerated
//      from schema.yaml by `npm run gen:schemas`). This test asserts the
//      schema-driven values equal the expected mietvertrag set, so a schema
//      change that would alter extraction behaviour is caught here as well as
//      by the wiring/metrics/score tests.
//
// No Anthropic API calls.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIELD_SPECS as MIETVERTRAG_FIELD_SPECS,
  VERIFIER_REFS as MIETVERTRAG_VERIFIER_REFS,
} from "../../../schemas/mietvertrag/generated/field_specs.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PRODUCTION_INDEX = path.join(REPO_ROOT, "supabase/functions/process-document/index.ts");
const EVAL_EXTRACTOR = path.join(REPO_ROOT, "scripts/eval/extractor.ts");

// Both wrappers begin with this anchor and are the only template literal in
// their respective files that starts with it. Extract the backtick-delimited
// literal around the anchor and replace each `${...}` interpolation with a
// placeholder so differing variable names (v2Config.prompt vs cfg.prompt,
// ocrText vs trimmed) don't register as drift — only the literal text must match.
const WRAPPER_ANCHOR = "Du bist ein präziser Dokumentenanalyse-Assistent";

function extractWrapper(source: string, label: string): string {
  const anchor = source.indexOf(WRAPPER_ANCHOR);
  assert.ok(anchor !== -1, `drift test: wrapper anchor not found in ${label}`);
  const open = source.lastIndexOf("`", anchor);
  const close = source.indexOf("`", anchor);
  assert.ok(open !== -1 && close !== -1 && close > anchor, `drift test: wrapper backticks not found in ${label}`);
  const literal = source.slice(open + 1, close);
  return literal.replace(/\$\{[^}]*\}/g, "${}");
}

// Expected mietvertrag field specs + verifier refs (the known-good set the
// wiring/metrics/score tests are calibrated against). The schema-driven config
// must equal this; if schema.yaml changes the extraction contract, update both
// here and the calibrated tests deliberately.
const EXPECTED_FIELD_SPECS = {
  kaltmiete: { id: "kaltmiete", type: "money", severity: "critical" },
  unit_ref: { id: "unit_ref", type: "enum", enum_values: ["EG", "1.OG", "2.OG", "3.OG", "4.OG", "DG", "Keller", "Souterrain"], severity: "critical" },
  tenant_identity: { id: "tenant_identity", type: "structured", severity: "critical" },
  mietbeginn: { id: "mietbeginn", type: "date", severity: "critical" },
  mietende: { id: "mietende", type: "date", severity: "important" },
  nebenkostenvorauszahlung: { id: "nebenkostenvorauszahlung", type: "money", severity: "important" },
  kaution: { id: "kaution", type: "money", severity: "important" },
  landlord_identity: { id: "landlord_identity", type: "structured", severity: "critical" },
};

const EXPECTED_VERIFIER_REFS = {
  kaltmiete: ["monetary-verbatim"],
  unit_ref: ["enum"],
  mietbeginn: ["date-format"],
  mietende: ["date-format"],
  nebenkostenvorauszahlung: ["monetary-verbatim"],
  kaution: ["monetary-verbatim"],
};

function main() {
  // 1. System-prompt wrapper byte-match between production and eval.
  const indexSrc = fs.readFileSync(PRODUCTION_INDEX, "utf8");
  const extractorSrc = fs.readFileSync(EVAL_EXTRACTOR, "utf8");

  const productionWrapper = extractWrapper(indexSrc, "index.ts");
  const evalWrapper = extractWrapper(extractorSrc, "extractor.ts");

  ok(productionWrapper.length > 0, "drift test: production wrapper extracted");
  eq(
    evalWrapper,
    productionWrapper,
    "drift test: eval extractor wrapper byte-matches production index.ts wrapper",
  );

  // 2. Schema-driven field specs + verifier refs equal the expected set.
  // assert.deepStrictEqual takes unknowns, so the generic eq() helper's
  // same-type constraint doesn't fight the generated index-signature types.
  assertions++;
  assert.deepStrictEqual(
    { ...MIETVERTRAG_FIELD_SPECS },
    EXPECTED_FIELD_SPECS,
    "drift test: schema-driven FIELD_SPECS match expected mietvertrag set",
  );
  assertions++;
  assert.deepStrictEqual(
    { ...MIETVERTRAG_VERIFIER_REFS },
    EXPECTED_VERIFIER_REFS,
    "drift test: schema-driven VERIFIER_REFS match expected mietvertrag set",
  );

  console.log(`✓ extractor-drift.test.ts: ${assertions} assertions passed`);
}

main();
