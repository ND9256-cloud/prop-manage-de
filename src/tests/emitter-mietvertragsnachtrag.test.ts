// Mietvertragsnachtrag claim emitter tests.
// Pure-function tests, no DB. Four scenarios covering the delegation pattern
// for rent_change, the reference-claim-only behavior for non-rent scopes,
// and the misclassification rejection (the safety property: a non-rent
// Nachtrag fed to the Mieterhöhung emitter throws loudly).
//
// Shapes match the SHIPPED types in src/lib/emitters/types.ts (Claim,
// ClaimClosure, ClaimKind includes "reference").

import assert from "node:assert/strict";
import {
  emitMietvertragsnachtragClaims,
  EMITTER_NAME,
  EMITTER_VERSION,
} from "../lib/emitters/mietvertragsnachtrag.ts";
import { emitMieterhoehungClaims } from "../lib/emitters/mieterhoehung.ts";
import type { EmitterContext } from "../lib/emitters/types.ts";

// --- Stable test context ---

const CTX: EmitterContext = {
  property_id: "00000000-0000-0000-0000-000000000001",
  source_document_id: "00000000-0000-0000-0000-000000000002",
  source_extraction_run_id: "00000000-0000-0000-0000-000000000003",
  evidence_id_for_field: () => null,
};

let assertions = 0;

// === Scenario 1 — Pet-clause Nachtrag (usage_right_change) ==================
// Non-rent scope. One reference "amendment_present" claim, no closures.

{
  const envelope: any = {
    doc_type: "mietvertragsnachtrag",
    schema_version: "2026-05-28-v1",
    fields: {
      nachtrag_scope: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "usage_right_change",
      },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "1.OG" },
      effective_date: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2025-03-01",
      },
      tenant_identity: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Everding, Lena", is_legal_entity: false, legal_form: null },
      },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      tenant_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
      usage_right_change_payload: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          usage_right_type: "Tierhaltung",
          permitted: true,
          change_notes: "Hundehaltung erlaubt",
        },
      },
    },
    lifecycle: {},
  };

  const result = emitMietvertragsnachtragClaims(envelope, CTX);

  // emitter metadata constants are exported
  assert.equal(EMITTER_NAME, "mietvertragsnachtrag");
  assert.equal(EMITTER_VERSION, "1.0.0");
  assertions += 2;

  // exactly one reference claim, zero closures
  assert.equal(result.claims_to_insert.length, 1, "usage_right_change emits exactly 1 claim");
  assert.equal(result.closure_intents.length, 0, "non-rent scopes emit no closures");
  assertions += 2;

  const ref = result.claims_to_insert[0];
  assert.equal(ref.claim_kind, "reference");
  assert.equal(ref.predicate, "amendment_present");
  assert.equal(ref.subject, "unit:1.OG");
  assert.equal((ref.value as any).scope, "usage_right_change");
  assert.equal((ref.value as any).status, "unsupported_requires_review");
  assert.equal((ref.value as any).payload.usage_right_type, "Tierhaltung");
  assert.equal((ref.value as any).payload.permitted, true);
  assert.equal(ref.valid_from, "2025-03-01");
  assert.equal(ref.valid_to, null);
  assert.equal(ref.property_id, CTX.property_id);
  assert.equal(ref.source_type, "document_extraction");
  assert.equal(ref.source_field_path, "fields.nachtrag_scope");
  assertions += 11;
}

// === Scenario 2 — Tenant identity change ==================================
// Non-rent scope. Reference claim only. CRITICALLY no closure targeting
// tenant_active — the tenancy persists; only a party detail changes.

{
  const envelope: any = {
    doc_type: "mietvertragsnachtrag",
    schema_version: "2026-05-28-v1",
    fields: {
      nachtrag_scope: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "tenant_identity_change",
      },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "EG" },
      effective_date: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2025-05-01",
      },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      tenant_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
      tenant_identity_change_payload: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          old_tenant_identity: { name: "Paul, Julija", is_legal_entity: false },
          new_tenant_identity: { name: "Paul-Schmidt, Julija", is_legal_entity: false },
          change_reason: "Heirat",
        },
      },
    },
    lifecycle: {},
  };

  const result = emitMietvertragsnachtragClaims(envelope, CTX);

  assert.equal(result.claims_to_insert.length, 1);
  assert.equal(result.closure_intents.length, 0);
  assertions += 2;

  const ref = result.claims_to_insert[0];
  assert.equal(ref.claim_kind, "reference");
  assert.equal(ref.predicate, "amendment_present");
  assert.equal((ref.value as any).scope, "tenant_identity_change");
  assert.equal((ref.value as any).status, "unsupported_requires_review");
  assert.equal((ref.value as any).payload.change_reason, "Heirat");
  assertions += 5;

  // Safety property: tenant_active must NEVER be closed by this scope. The
  // tenancy continues; only the party-detail changes. The claims_to_insert
  // list must therefore contain no closure on tenant_active and the
  // closure_intents list must be empty (already asserted above; this is the
  // explicit safety assertion for the spec).
  for (const c of result.claims_to_insert) {
    assert.notEqual(c.predicate, "tenant_active");
  }
  assert.ok(
    result.closure_intents.every((ci) => !ci.target_predicates.includes("tenant_active")),
    "tenant_identity_change must NOT close tenant_active"
  );
  assertions += result.claims_to_insert.length + 1;
}

// === Scenario 3 — Bilateral rent change (delegation) ======================
// rent_change scope → reshape into a Mieterhöhung extraction and delegate.
// The result must match a Mieterhöhung EmissionResult exactly: kaltmiete
// assertion + kaltmiete_amended event + close_overlapping_only intent.

{
  const envelope: any = {
    doc_type: "mietvertragsnachtrag",
    schema_version: "2026-05-28-v1",
    fields: {
      nachtrag_scope: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "rent_change",
      },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "EG" },
      effective_date: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2024-07-01",
      },
      tenant_identity: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Paul, Test", is_legal_entity: false, legal_form: null },
      },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      tenant_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
      rent_change_payload: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          new_kaltmiete: { amount: 60000, currency: "EUR" },
          previous_kaltmiete: { amount: 55000, currency: "EUR" },
          rechtsgrundlage: "bilateral",
          staffelmiete_context: false,
        },
      },
    },
    lifecycle: {},
  };

  const result = emitMietvertragsnachtragClaims(envelope, CTX);

  // Delegation produces the Mieterhöhung-shaped result: 2 claims + 1 closure.
  assert.equal(result.claims_to_insert.length, 2, "rent_change delegation emits 2 claims");
  assert.equal(result.closure_intents.length, 1, "rent_change delegation emits 1 closure");
  assertions += 2;

  // 1. kaltmiete assertion at €600.00
  const kaltmiete = result.claims_to_insert.find((c) => c.predicate === "kaltmiete")!;
  assert.ok(kaltmiete, "kaltmiete assertion present");
  assert.equal(kaltmiete.claim_kind, "assertion");
  assert.equal(kaltmiete.subject, "unit:EG");
  assert.equal((kaltmiete.value as any).amount, 60000);
  assert.equal((kaltmiete.value as any).currency, "EUR");
  assert.equal(kaltmiete.valid_from, "2024-07-01");
  assert.equal(kaltmiete.confidence, "high");
  assertions += 7;

  // 2. kaltmiete_amended event claim (applier's trigger / reason claim)
  const event = result.claims_to_insert.find((c) => c.claim_kind === "event")!;
  assert.ok(event, "kaltmiete_amended event claim present");
  assert.equal(event.predicate, "kaltmiete_amended");
  assert.equal(event.subject, "unit:EG");
  assert.equal((event.value as any).new_amount, 60000);
  assert.equal((event.value as any).previous_amount, 55000);
  assert.equal(event.valid_from, "2024-07-01");
  assertions += 6;

  // 3. Closure intent: close_overlapping_only on kaltmiete, close_at = effective_date - 1 day
  const closure = result.closure_intents[0];
  assert.equal(closure.target_subject, "unit:EG");
  assert.deepStrictEqual(closure.target_predicates, ["kaltmiete"]);
  assert.equal(closure.close_mode, "close_overlapping_only");
  assert.equal(closure.close_at, "2024-06-30");
  assert.equal(closure.blocker_status, "none");
  assert.equal(closure.match.tenant_identity, "Paul, Test");
  assertions += 6;
}

// === Scenario 4 — Misclassification rejection =============================
// A usage_right_change envelope fed DIRECTLY to emitMieterhoehungClaims
// (simulating Step 4 misrouting). The Mieterhöhung emitter must throw
// because new_kaltmiete is absent. This is the safe loud failure that
// protects against silent rent corruption when classification goes wrong.

{
  // Build the misrouted envelope: shape is Mieterhöhung's (Step 4 routed
  // here) but the underlying document is a non-rent Nachtrag, so
  // new_kaltmiete is absent.
  const misroutedEnvelope: any = {
    doc_type: "mieterhoehung",
    schema_version: "2026-05-28-v1",
    fields: {
      new_kaltmiete: { absence_state: "absent" },
      effective_date: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2025-03-01",
      },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "1.OG" },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
    },
    lifecycle: {},
  };

  assert.throws(
    () => emitMieterhoehungClaims(misroutedEnvelope, CTX),
    /new_kaltmiete is required but absent/,
    "Misclassified non-rent Nachtrag fed to Mieterhöhung emitter must throw — loud rejection beats silent rent corruption"
  );
  assertions++;
}

// === Scenario 5 — Determinism ============================================

{
  const envelope: any = {
    doc_type: "mietvertragsnachtrag",
    schema_version: "2026-05-28-v1",
    fields: {
      nachtrag_scope: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "deposit_change",
      },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "DG" },
      effective_date: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2025-06-15",
      },
      landlord_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      tenant_signature_present: { absence_state: "present", confidence: "high", normalized_value: true },
      document_status: { absence_state: "present", confidence: "high", normalized_value: "signed" },
      deposit_change_payload: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          new_kaution: { amount: 180000, currency: "EUR" },
          previous_kaution: { amount: 150000, currency: "EUR" },
        },
      },
    },
    lifecycle: {},
  };
  const r1 = emitMietvertragsnachtragClaims(envelope, CTX);
  const r2 = emitMietvertragsnachtragClaims(envelope, CTX);
  assert.deepStrictEqual(r1, r2, "emitter is deterministic");
  assertions++;
}

console.log(`emitter-mietvertragsnachtrag: ${assertions} assertions — OK`);
