// Mieterhöhung claim emitter tests.
// Tests written against architecture spec (§5.5.2 closing matrix). If a test
// fails, the emitter is wrong — not the other way around.
//
// Shapes match the SHIPPED types in src/lib/emitters/types.ts (Claim,
// ClaimClosure) and the applier contract in src/lib/claim-store/applier.ts,
// which requires exactly one event claim (kaltmiete_amended) whenever a
// closure intent is present.

import assert from "node:assert/strict";
import { emitMieterhoehungClaims, EMITTER_NAME, EMITTER_VERSION } from "../lib/emitters/mieterhoehung.ts";
import type { EmitterContext } from "../lib/emitters/types.ts";

// --- Stable test context ---

const CTX: EmitterContext = {
  property_id: "00000000-0000-0000-0000-000000000001",
  source_document_id: "00000000-0000-0000-0000-000000000002",
  source_extraction_run_id: "00000000-0000-0000-0000-000000000003",
  evidence_id_for_field: () => null,
};

// --- Paul fixture (EG, €525 → €575, §558, signed, no Staffelmiete) ---

function paulEnvelope(): any {
  return {
    doc_type: "mieterhoehung",
    schema_version: "2026-05-27-v1",
    fields: {
      new_kaltmiete: {
        absence_state: "present",
        confidence: "high",
        raw_value: "575,00 €",
        normalized_value: { amount: 57500, currency: "EUR" },
      },
      previous_kaltmiete: {
        absence_state: "present",
        confidence: "high",
        raw_value: "525,00 €",
        normalized_value: { amount: 52500, currency: "EUR" },
      },
      effective_date: { absence_state: "present", confidence: "high", normalized_value: "2024-01-01" },
      notice_date: { absence_state: "present", confidence: "high", normalized_value: "2023-09-15" },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "EG" },
      tenant_identity: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Paul, Test", is_legal_entity: false, legal_form: null },
      },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      tenant_signature_present: { absence_state: "present", confidence: "high", normalized_value: false },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
      rechtsgrundlage: { absence_state: "present", confidence: "high", normalized_value: "§558" },
      nachtrag_typ: { absence_state: "present", confidence: "high", normalized_value: "mieterhoehung" },
      staffelmiete_context: { absence_state: "present", confidence: "high", normalized_value: false },
    },
    lifecycle: {},
  };
}

let assertions = 0;

// === Scenario 1 — Paul happy path (signed, no Staffelmiete) ================

{
  const result = emitMieterhoehungClaims(paulEnvelope(), CTX);

  // emitter metadata constants are exported
  assert.equal(EMITTER_NAME, "mieterhoehung");
  assert.equal(EMITTER_VERSION, "1.0.0");
  assertions += 2;

  // claims_to_insert: one assertion + one event claim
  assert.equal(result.claims_to_insert.length, 2);
  assertions++;

  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.ok(kaltmiete, "kaltmiete assertion present");
  assert.equal(kaltmiete.claim_kind, "assertion");
  assert.equal(kaltmiete.subject, "unit:EG");
  assert.equal(kaltmiete.value.amount, 57500);
  assert.equal(kaltmiete.value.currency, "EUR");
  assert.equal(kaltmiete.valid_from, "2024-01-01");
  assert.equal(kaltmiete.valid_to, null);
  assert.equal(kaltmiete.confidence, "high");
  assert.equal(kaltmiete.source_type, "document_extraction");
  assert.equal(kaltmiete.source_field_path, "fields.new_kaltmiete");
  assert.equal(kaltmiete.property_id, CTX.property_id);
  assertions += 11;

  // event claim — the applier's trigger / reason claim
  const event = result.claims_to_insert.find(c => c.claim_kind === "event")!;
  assert.ok(event, "kaltmiete_amended event claim present");
  assert.equal(event.predicate, "kaltmiete_amended");
  assert.equal(event.subject, "unit:EG");
  assert.equal(event.valid_from, "2024-01-01");
  assert.equal(event.value.new_amount, 57500);
  assert.equal(event.value.previous_amount, 52500);
  assertions += 6;

  // closure intent
  assert.equal(result.closure_intents.length, 1);
  const closure = result.closure_intents[0];
  assert.equal(closure.target_subject, "unit:EG");
  assert.deepStrictEqual(closure.target_predicates, ["kaltmiete"]);
  assert.equal(closure.close_mode, "close_overlapping_only");
  assert.equal(closure.close_at, "2023-12-31"); // effective_date - 1 day
  assert.equal(closure.blocker_status, "none");
  assert.equal(closure.match.tenant_identity, "Paul, Test");
  assert.equal(closure.match_strictness, "optional");
  assertions += 8;
}

// === Scenario 2 — Draft / unsigned (no closure, no event claim) ============

{
  const env = paulEnvelope();
  env.fields.landlord_signature_present.normalized_value = false;
  env.fields.document_status.normalized_value = "draft";
  const result = emitMieterhoehungClaims(env, CTX);

  // still emit the kaltmiete assertion (data is not lost)
  assert.equal(result.claims_to_insert.length, 1);
  assert.equal(result.claims_to_insert[0].predicate, "kaltmiete");
  // confidence downgraded
  assert.equal(result.claims_to_insert[0].confidence, "low");
  // no closure, and therefore no event claim (applier invariant)
  assert.equal(result.closure_intents.length, 0);
  assert.ok(!result.claims_to_insert.find(c => c.claim_kind === "event"));
  assertions += 5;
}

// === Scenario 3 — Staffelmiete context (requires_review blocker) ===========

{
  const env = paulEnvelope();
  env.fields.staffelmiete_context.normalized_value = true;
  const result = emitMieterhoehungClaims(env, CTX);

  assert.equal(result.claims_to_insert.length, 2);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.confidence, "high"); // prerequisites still met
  assert.equal(result.closure_intents.length, 1);
  const closure = result.closure_intents[0];
  assert.equal(closure.blocker_status, "requires_review");
  assert.equal(closure.close_mode, "close_overlapping_only"); // still produced, just flagged
  assert.equal(closure.target_subject, "unit:EG");
  assert.deepStrictEqual(closure.target_predicates, ["kaltmiete"]);
  assertions += 7;
}

// === Scenario 4 — Missing effective_date (claim only, no closure) ==========

{
  const env = paulEnvelope();
  env.fields.effective_date = { absence_state: "absent" };
  const result = emitMieterhoehungClaims(env, CTX);

  // claim still emitted, valid_from falls back to notice_date, confidence low
  assert.equal(result.claims_to_insert.length, 1);
  assert.equal(result.claims_to_insert[0].confidence, "low");
  assert.equal(result.claims_to_insert[0].valid_from, "2023-09-15"); // notice_date fallback
  assert.equal(result.closure_intents.length, 0);
  assertions += 4;
}

// === Scenario 5 — Missing new_kaltmiete throws =============================

{
  const env = paulEnvelope();
  env.fields.new_kaltmiete = { absence_state: "absent" };
  assert.throws(
    () => emitMieterhoehungClaims(env, CTX),
    /new_kaltmiete is required but absent/,
    "missing new_kaltmiete must throw"
  );
  assertions++;
}

// === Scenario 6 — Determinism =============================================

{
  const env = paulEnvelope();
  const r1 = emitMieterhoehungClaims(env, CTX);
  const r2 = emitMieterhoehungClaims(env, CTX);
  assert.deepStrictEqual(r1, r2);
  assertions++;
}

console.log(`emitter-mieterhoehung: ${assertions} assertions — OK`);
