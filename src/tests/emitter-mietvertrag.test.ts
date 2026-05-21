// Mietvertrag claim emitter tests.
// Tests written against architecture spec BEFORE running the emitter.
// If a test fails, the emitter is wrong — not the other way around.

import assert from "node:assert/strict";
import { emitMietvertragClaims } from "../lib/emitters/mietvertrag.ts";
import type { EmitterContext } from "../lib/emitters/types.ts";

// --- Stable test context ---

const CTX: EmitterContext = {
  property_id: "00000000-0000-0000-0000-000000000001",
  source_document_id: "00000000-0000-0000-0000-000000000002",
  source_extraction_run_id: "00000000-0000-0000-0000-000000000003",
  evidence_id_for_field: () => null,
};

// --- Lena fixture (KO132 1.OG, EUR 650, mietbeginn 2025-04-01, no kaution) ---

function lenaEnvelope(): any {
  return {
    doc_type: "mietvertrag",
    schema_version: "2026-05-21-v1",
    fields: {
      kaltmiete: {
        absence_state: "present",
        confidence: "high",
        raw_value: "650,00 EUR",
        normalized_value: { amount: 65000, currency: "EUR" },
      },
      unit_ref: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "1.OG",
      },
      tenant_identity: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Everding, Lena" },
      },
      mietbeginn: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2025-04-01",
      },
      mietende: {
        absence_state: "not_applicable",
        confidence: "high",
      },
    },
    lifecycle: {
      document_status: "executed",
      effective_date: "2025-04-01",
    },
  };
}

// --- Paul-like fixture with kaution present ---

function paulWithKautionEnvelope(): any {
  return {
    doc_type: "mietvertrag",
    schema_version: "2026-05-21-v1",
    fields: {
      kaltmiete: {
        absence_state: "present",
        confidence: "high",
        raw_value: "575,00 EUR",
        normalized_value: { amount: 57500, currency: "EUR" },
      },
      unit_ref: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "EG",
      },
      tenant_identity: {
        absence_state: "present",
        confidence: "high",
        normalized_value: { name: "Paul, Julija" },
      },
      mietbeginn: {
        absence_state: "present",
        confidence: "high",
        normalized_value: "2024-01-01",
      },
      mietende: {
        absence_state: "not_applicable",
        confidence: "high",
      },
      kaution: {
        absence_state: "present",
        confidence: "high",
        raw_value: "1.725,00 EUR",
        normalized_value: { amount: 172500, currency: "EUR" },
      },
    },
    lifecycle: {
      document_status: "executed",
    },
  };
}

let assertions = 0;

// --- Happy path (Lena fixture) ---

// 1. Returns 2 claims (kaltmiete + tenant_active) for Lena's envelope (no kaution extracted)
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  assert.equal(result.claims_to_insert.length, 2);
  assertions++;
}

// 2. kaltmiete claim has correct predicate, subject, value
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.predicate, "kaltmiete");
  assert.equal(kaltmiete.subject, "unit:1.OG");
  assert.equal(kaltmiete.value.amount, 65000);
  assert.equal(kaltmiete.value.currency, "EUR");
  assertions += 4;
}

// 3. kaltmiete claim has valid_from and valid_to
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.valid_from, "2025-04-01");
  assert.equal(kaltmiete.valid_to, null);
  assertions += 2;
}

// 4. kaltmiete claim has correct claim_kind and source_type
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.claim_kind, "assertion");
  assert.equal(kaltmiete.source_type, "document_extraction");
  assertions += 2;
}

// 5. tenant_active claim has correct tenant name
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const tenant = result.claims_to_insert.find(c => c.predicate === "tenant_active")!;
  const tenants = tenant.value.tenants as Array<{ name: string }>;
  assert.equal(tenants[0].name, "Everding, Lena");
  assertions++;
}

// 6. Both claims have correct context IDs
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  for (const claim of result.claims_to_insert) {
    assert.equal(claim.property_id, "00000000-0000-0000-0000-000000000001");
    assert.equal(claim.source_document_id, "00000000-0000-0000-0000-000000000002");
    assert.equal(claim.source_extraction_run_id, "00000000-0000-0000-0000-000000000003");
  }
  assertions += 6;
}

// 7. closure_intents is empty array
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  assert.deepStrictEqual(result.closure_intents, []);
  assertions++;
}

// 8. source_field_path matches the field key for each claim
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  const tenant = result.claims_to_insert.find(c => c.predicate === "tenant_active")!;
  assert.equal(kaltmiete.source_field_path, "fields.kaltmiete");
  assert.equal(tenant.source_field_path, "fields.tenant_identity");
  assertions += 2;
}

// --- Kaution emission (Paul-like fixture with kaution present) ---

// 9. Returns 3 claims when kaution.absence_state="present"
{
  const result = emitMietvertragClaims(paulWithKautionEnvelope(), CTX);
  assert.equal(result.claims_to_insert.length, 3);
  assertions++;
}

// 10. kaution claim has correct value, subject, predicate
{
  const result = emitMietvertragClaims(paulWithKautionEnvelope(), CTX);
  const kaution = result.claims_to_insert.find(c => c.predicate === "kaution")!;
  assert.ok(kaution.value.amount);
  assert.equal(kaution.subject, "unit:EG");
  assert.equal(kaution.predicate, "kaution");
  assertions += 3;
}

// --- Kaution absence ---

// 11. Returns 2 claims (no kaution) when kaution.absence_state="absent"
{
  const env = paulWithKautionEnvelope();
  env.fields.kaution = { absence_state: "absent" as const, confidence: "high" as const };
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 2);
  assert.ok(!result.claims_to_insert.find(c => c.predicate === "kaution"));
  assertions += 2;
}

// 12. Returns 2 claims (no kaution) when kaution.absence_state="inferred"
{
  const env = paulWithKautionEnvelope();
  env.fields.kaution = {
    absence_state: "inferred" as const,
    confidence: "medium" as const,
    normalized_value: { amount: 172500, currency: "EUR" },
  };
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 2);
  assertions++;
}

// 13. Returns 2 claims (no kaution) when kaution.absence_state="requires_human_review"
{
  const env = paulWithKautionEnvelope();
  env.fields.kaution = {
    absence_state: "requires_human_review" as const,
    confidence: "low" as const,
    normalized_value: { amount: 172500, currency: "EUR" },
  };
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 2);
  assertions++;
}

// --- Draft / unsigned guard ---

// 14. Returns empty when lifecycle.document_status === "draft"
{
  const env = lenaEnvelope();
  env.lifecycle!.document_status = "draft";
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assert.deepStrictEqual(result.closure_intents, []);
  assertions += 2;
}

// --- Load-bearing-field guards ---

// 15. Returns empty when kaltmiete.absence_state="ambiguous"
{
  const env = lenaEnvelope();
  env.fields.kaltmiete!.absence_state = "ambiguous";
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assertions++;
}

// 16. Returns empty when unit_ref is missing entirely
{
  const env = lenaEnvelope();
  delete env.fields.unit_ref;
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assertions++;
}

// 17. Returns empty when mietbeginn.absence_state="illegible"
{
  const env = lenaEnvelope();
  env.fields.mietbeginn!.absence_state = "illegible";
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assertions++;
}

// 18. Returns empty when tenant_identity.normalized_value is missing the name field
{
  const env = lenaEnvelope();
  env.fields.tenant_identity!.normalized_value = { email: "lena@example.com" };
  const result = emitMietvertragClaims(env, CTX);
  assert.equal(result.claims_to_insert.length, 0);
  assertions++;
}

// --- Mietende handling ---

// 19. valid_to is null when mietende.absence_state="not_applicable" (unbefristet)
{
  const result = emitMietvertragClaims(lenaEnvelope(), CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.valid_to, null);
  assertions++;
}

// 20. valid_to is the ISO date when mietende.absence_state="present" (befristet)
{
  const env = lenaEnvelope();
  env.fields.mietende = {
    absence_state: "present" as const,
    confidence: "high" as const,
    normalized_value: "2027-03-31",
  };
  const result = emitMietvertragClaims(env, CTX);
  const kaltmiete = result.claims_to_insert.find(c => c.predicate === "kaltmiete")!;
  assert.equal(kaltmiete.valid_to, "2027-03-31");
  const tenant = result.claims_to_insert.find(c => c.predicate === "tenant_active")!;
  assert.equal(tenant.valid_to, "2027-03-31");
  assertions += 2;
}

// --- Determinism ---

// 21. Calling the emitter twice with identical inputs returns deeply equal results
{
  const env = lenaEnvelope();
  const r1 = emitMietvertragClaims(env, CTX);
  const r2 = emitMietvertragClaims(env, CTX);
  assert.deepStrictEqual(r1, r2);
  assertions++;
}

console.log(`emitter-mietvertrag: ${assertions} assertions — OK`);
