// Wohnungsübergabeprotokoll claim emitter tests.
// Pure-function tests, no DB. Five scenarios covering the four uebergabe_typ
// branches plus a missing-required-field case.
//
// The Hofmann safeguard is asserted explicitly in Scenario 3 (Eigentümer-
// wechsel must NOT emit any tenant_active / kaltmiete / kaution /
// nebenkostenvorauszahlung closure intent — the structural defense in code).

import assert from "node:assert/strict";
import {
  emitWohnungsuebergabeprotokollClaims,
  EMITTER_NAME,
  EMITTER_VERSION,
} from "../lib/emitters/wohnungsuebergabeprotokoll.ts";
import type { EmitterContext } from "../lib/emitters/types.ts";

// --- Stable test context ---

const CTX: EmitterContext = {
  property_id: "00000000-0000-0000-0000-000000000001",
  source_document_id: "00000000-0000-0000-0000-000000000002",
  source_extraction_run_id: "00000000-0000-0000-0000-000000000003",
  evidence_id_for_field: () => null,
};

const TENANT_PREDICATES = new Set([
  "tenant_active",
  "kaltmiete",
  "kaution",
  "nebenkostenvorauszahlung",
]);

let assertions = 0;

// === Scenario 1 — Einzug ===================================================
// New tenant arrives. One tenant_active event claim, no closures.

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: { absence_state: "present", confidence: "high", normalized_value: "Einzug" },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "1.OG" },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2025-04-01" },
      mieter_in: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Everding, Lena", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };

  const result = emitWohnungsuebergabeprotokollClaims(envelope, CTX);

  // emitter metadata constants
  assert.equal(EMITTER_NAME, "wohnungsuebergabeprotokoll");
  assert.equal(EMITTER_VERSION, "1.0.0");
  assertions += 2;

  assert.equal(result.claims_to_insert.length, 1, "Einzug emits exactly 1 claim");
  assert.equal(result.closure_intents.length, 0, "Einzug emits no closures");
  assertions += 2;

  const tenantActive = result.claims_to_insert[0];
  assert.equal(tenantActive.predicate, "tenant_active");
  assert.equal(tenantActive.claim_kind, "event");
  assert.equal(tenantActive.subject, "unit:1.OG");
  assert.equal(tenantActive.valid_from, "2025-04-01");
  assert.equal(tenantActive.valid_to, null);
  assert.equal(tenantActive.property_id, CTX.property_id);
  const tenants = tenantActive.value.tenants as { name: string }[];
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].name, "Everding, Lena");
  assertions += 8;
}

// === Scenario 2 — Auszug ===================================================
// Tenant departs. One lease_terminated event claim + 4 closure intents.

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: { absence_state: "present", confidence: "high", normalized_value: "Auszug" },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "EG" },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2024-06-30" },
      mieter_out: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Paul, Friedrich", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };

  const result = emitWohnungsuebergabeprotokollClaims(envelope, CTX);

  assert.equal(result.claims_to_insert.length, 1, "Auszug emits exactly 1 claim (the event)");
  assertions++;

  const event = result.claims_to_insert[0];
  assert.equal(event.predicate, "lease_terminated");
  assert.equal(event.claim_kind, "event");
  assert.equal(event.subject, "unit:EG");
  assert.equal(event.valid_from, "2024-06-30");
  const terminating = event.value.terminating_parties as { name: string }[];
  assert.equal(terminating.length, 1);
  assert.equal(terminating[0].name, "Paul, Friedrich");
  assertions += 6;

  // Closures: 4 intents, one per target predicate.
  assert.equal(result.closure_intents.length, 4, "Auszug emits 4 closure intents");
  assertions++;

  for (const intent of result.closure_intents) {
    assert.equal(intent.close_mode, "close_overlapping_and_future");
    assert.equal(intent.close_at, "2024-06-30");
    assert.equal(intent.target_subject, "unit:EG");
    assert.equal(intent.target_predicates.length, 1);
    assert.equal(intent.blocker_status, "none");
    assertions += 5;
  }

  const targetPredicateSet = new Set(
    result.closure_intents.flatMap((i) => i.target_predicates)
  );
  assert.equal(targetPredicateSet.size, 4);
  for (const p of ["kaltmiete", "tenant_active", "kaution", "nebenkostenvorauszahlung"]) {
    assert.ok(
      targetPredicateSet.has(p),
      `Auszug must close target_predicate ${p}`
    );
    assertions++;
  }
  assertions++;

  // tenant_active closure carries the tenant_identity match (required).
  const tenantClosure = result.closure_intents.find((i) =>
    i.target_predicates.includes("tenant_active")
  )!;
  assert.equal(tenantClosure.match.tenant_identity, "Paul, Friedrich");
  assert.equal(tenantClosure.match_strictness, "required");
  assertions += 2;

  // Non-tenant closures must NOT have tenant_identity (would filter all candidates out).
  for (const intent of result.closure_intents) {
    if (intent.target_predicates.includes("tenant_active")) continue;
    assert.equal(
      intent.match.tenant_identity,
      undefined,
      `non-tenant closure for ${intent.target_predicates[0]} must not set tenant_identity match`
    );
    assert.equal(intent.match_strictness, "absent");
    assertions += 2;
  }
}

// === Scenario 3 — Eigentümerwechsel (the Hofmann safeguard) ================
// Property sale. New owner + new ownership_transferred event + previous-owner
// closure. NEVER closes tenant/kaltmiete/kaution claims.

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "Eigentümerwechsel",
      },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2025-11-15" },
      kaeufer: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          name: "Denn Immobilienverwaltung eGbR",
          is_legal_entity: true,
          legal_form: "eGbR",
        },
      },
      verkaeufer: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Bernhardt, Cornelia", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };

  const result = emitWohnungsuebergabeprotokollClaims(envelope, CTX);

  // Two claims: ownership_transferred event + owner assertion.
  assert.equal(result.claims_to_insert.length, 2);
  assertions++;

  const event = result.claims_to_insert.find((c) => c.claim_kind === "event")!;
  assert.ok(event, "ownership_transferred event claim emitted");
  assert.equal(event.predicate, "ownership_transferred");
  assert.equal(event.subject, "property");
  assert.equal(event.valid_from, "2025-11-15");
  assertions += 4;

  const ownerClaim = result.claims_to_insert.find((c) => c.claim_kind === "assertion")!;
  assert.ok(ownerClaim, "new owner assertion claim emitted");
  assert.equal(ownerClaim.predicate, "owner");
  assert.equal(ownerClaim.subject, "property");
  assert.equal(ownerClaim.valid_from, "2025-11-15");
  const ownerValue = ownerClaim.value.owner as { name: string; is_legal_entity: boolean; legal_form: string };
  assert.equal(ownerValue.name, "Denn Immobilienverwaltung eGbR");
  assert.equal(ownerValue.is_legal_entity, true);
  assert.equal(ownerValue.legal_form, "eGbR");
  assertions += 7;

  // Exactly one closure intent, targeting "owner" ONLY.
  assert.equal(result.closure_intents.length, 1, "Eigentümerwechsel emits exactly 1 closure intent");
  assertions++;

  const ownerClosure = result.closure_intents[0];
  assert.deepStrictEqual(ownerClosure.target_predicates, ["owner"]);
  assert.equal(ownerClosure.close_mode, "close_overlapping_and_supersede_future");
  assert.equal(ownerClosure.close_at, "2025-11-14"); // uebergabe_datum - 1
  assert.equal(ownerClosure.target_subject, "property");
  assert.equal(ownerClosure.blocker_status, "none");
  // match against verkaeufer
  assert.equal(ownerClosure.match.tenant_identity, "Bernhardt, Cornelia");
  assertions += 6;

  // THE HOFMANN ASSERTION: no closure intent targets tenant-related predicates.
  for (const intent of result.closure_intents) {
    for (const predicate of intent.target_predicates) {
      assert.ok(
        !TENANT_PREDICATES.has(predicate),
        `HOFMANN VIOLATION: Eigentümerwechsel closure targets tenant predicate '${predicate}' — must never happen`
      );
      assertions++;
    }
  }
}

// === Scenario 4 — unklar ===================================================
// Document does not clearly signal which event. Defers to triage.

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: { absence_state: "present", confidence: "low", normalized_value: "unklar" },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2025-04-01" },
    },
    lifecycle: {},
  };

  const result = emitWohnungsuebergabeprotokollClaims(envelope, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assert.equal(result.closure_intents.length, 0);
  assertions += 2;
}

// === Scenario 5 — missing required field (defer, not crash) ================
// Auszug without unit_ref → empty result. Does NOT throw (unlike Mieterhöhung).

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: { absence_state: "present", confidence: "high", normalized_value: "Auszug" },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2024-06-30" },
      unit_ref: { absence_state: "absent" },
      mieter_out: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Paul, Friedrich", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };

  const result = emitWohnungsuebergabeprotokollClaims(envelope, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assert.equal(result.closure_intents.length, 0);
  assertions += 2;

  // Also: unrecognized uebergabe_typ → empty result (no throw).
  const env2: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: {
        absence_state: "present",
        confidence: "low",
        normalized_value: "Begehung",
      },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2024-06-30" },
    },
    lifecycle: {},
  };
  const result2 = emitWohnungsuebergabeprotokollClaims(env2, CTX);
  assert.equal(result2.claims_to_insert.length, 0);
  assert.equal(result2.closure_intents.length, 0);
  assertions += 2;

  // Missing uebergabe_datum on any branch → empty result.
  const env3: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: { absence_state: "present", confidence: "high", normalized_value: "Einzug" },
      uebergabe_datum: { absence_state: "absent" },
      unit_ref: { absence_state: "present", confidence: "high", normalized_value: "EG" },
      mieter_in: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "X, Y", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };
  const result3 = emitWohnungsuebergabeprotokollClaims(env3, CTX);
  assert.equal(result3.claims_to_insert.length, 0);
  assert.equal(result3.closure_intents.length, 0);
  assertions += 2;
}

// === Scenario 6 — Determinism ==============================================

{
  const envelope: any = {
    doc_type: "wohnungsuebergabeprotokoll",
    schema_version: "2026-05-27-v1",
    fields: {
      uebergabe_typ: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "Eigentümerwechsel",
      },
      uebergabe_datum: { absence_state: "present", confidence: "high", normalized_value: "2025-11-15" },
      kaeufer: {
        absence_state: "present",
        confidence: "high",
        normalized_value: {
          name: "Denn Immobilienverwaltung eGbR",
          is_legal_entity: true,
          legal_form: "eGbR",
        },
      },
      verkaeufer: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Bernhardt, Cornelia", is_legal_entity: false, legal_form: null },
      },
    },
    lifecycle: {},
  };
  const r1 = emitWohnungsuebergabeprotokollClaims(envelope, CTX);
  const r2 = emitWohnungsuebergabeprotokollClaims(envelope, CTX);
  assert.deepStrictEqual(r1, r2);
  assertions++;
}

console.log(`emitter-wohnungsuebergabeprotokoll: ${assertions} assertions — OK`);
