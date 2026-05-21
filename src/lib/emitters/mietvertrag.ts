// Mietvertrag claim emitter.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
// Input -> output. Tested in isolation. CI enforces (see emitter-purity.test.ts).
//
// Architecture refs:
//   $4.4 -- emitter contract
//   $4.5 -- claim_kind = "assertion" for Mietvertrag
//   schemas/mietvertrag/schema.yaml -- 8 fields, schema_version 2026-05-21-v1
//   domain_knowledge/mietvertrag.md -- closes: [] (Mietvertrag emits no closures)

import type { Claim, EmissionResult, EmitterContext } from "./types.ts";

/**
 * Minimal envelope shape this emitter reads. Mirrors warehouse.document_extractions_v2.fields.
 * Only the subset of fields the emitter consumes is typed; the envelope may have more.
 */
interface MietvertragEnvelope {
  doc_type: "mietvertrag";
  schema_version: string;
  fields: {
    kaltmiete?: MoneyField;
    nebenkostenvorauszahlung?: MoneyField;
    kaution?: MoneyField;
    unit_ref?: EnumField;
    tenant_identity?: StructuredField;
    landlord_identity?: StructuredField;
    mietbeginn?: DateField;
    mietende?: DateField;
  };
  lifecycle?: {
    document_status?: "draft" | "executed" | "ambiguous";
    effective_date?: string;
  };
}

interface FieldBase {
  absence_state:
    | "present"
    | "absent"
    | "illegible"
    | "ambiguous"
    | "contradicted"
    | "not_applicable"
    | "inferred"
    | "requires_human_review";
  confidence?: "high" | "medium" | "low";
  raw_value?: string;
  evidence?: { page?: number; quote?: string }[];
}

interface MoneyField extends FieldBase {
  normalized_value?: { amount: number; currency: string };
}

interface EnumField extends FieldBase {
  normalized_value?: string;
}

interface DateField extends FieldBase {
  normalized_value?: string; // ISO date
}

interface StructuredField extends FieldBase {
  normalized_value?: Record<string, unknown>;
}

/**
 * Pure emitter. Returns claims and closure intents derived from the envelope.
 *
 * Mietvertrag emits:
 *   - kaltmiete assertion (always, if present + valid)
 *   - tenant_active assertion (always, if tenant_identity present)
 *   - kaution assertion (only if extracted and absence_state=present)
 *
 * Mietvertrag emits no closures. closure_intents is always [].
 *
 * Returns empty arrays (does not throw) when:
 *   - document_status is "draft" (unsigned)
 *   - kaltmiete.absence_state != "present"
 *   - unit_ref.absence_state != "present"
 *   - mietbeginn.absence_state != "present"
 *   - tenant_identity is missing or empty
 *
 * These are the load-bearing fields. Anything less and the resolver
 * can't produce a correct answer, so it's safer to record nothing in
 * the claim store than to emit partial claims. The envelope is still
 * persisted; the case surfaces via the v2 triage path.
 */
export function emitMietvertragClaims(
  envelope: MietvertragEnvelope,
  context: EmitterContext
): EmissionResult {
  // Draft guard — never emit claims from unsigned contracts.
  if (envelope.lifecycle?.document_status === "draft") {
    return { claims_to_insert: [], closure_intents: [] };
  }

  const { kaltmiete, unit_ref, tenant_identity, mietbeginn, mietende, kaution } = envelope.fields;

  // Load-bearing-field guard.
  if (
    !kaltmiete || kaltmiete.absence_state !== "present" ||
    !unit_ref || unit_ref.absence_state !== "present" ||
    !mietbeginn || mietbeginn.absence_state !== "present" ||
    !tenant_identity || tenant_identity.absence_state !== "present"
  ) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  // Defensive: required normalized values must exist for "present".
  if (
    !kaltmiete.normalized_value ||
    !unit_ref.normalized_value ||
    !mietbeginn.normalized_value ||
    !tenant_identity.normalized_value ||
    !tenant_identity.normalized_value.name
  ) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  const subject = `unit:${unit_ref.normalized_value}`;
  const valid_from = mietbeginn.normalized_value;
  const valid_to = mietende?.absence_state === "present" && mietende.normalized_value
    ? mietende.normalized_value
    : null;

  const claims: Claim[] = [];

  // 1. kaltmiete assertion
  claims.push({
    property_id: context.property_id,
    subject,
    predicate: "kaltmiete",
    value: {
      amount: kaltmiete.normalized_value.amount,
      currency: kaltmiete.normalized_value.currency,
      raw_value: kaltmiete.raw_value,
    },
    claim_kind: "assertion",
    valid_from,
    valid_to,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.kaltmiete",
    confidence: kaltmiete.confidence ?? "medium",
    evidence_id: context.evidence_id_for_field("fields.kaltmiete"),
    source_type: "document_extraction",
    human_actor_id: null,
  });

  // 2. tenant_active assertion (single claim, tenant array on value for forward-compatibility)
  claims.push({
    property_id: context.property_id,
    subject,
    predicate: "tenant_active",
    value: {
      tenants: [tenant_identity.normalized_value],
    },
    claim_kind: "assertion",
    valid_from,
    valid_to,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.tenant_identity",
    confidence: tenant_identity.confidence ?? "medium",
    evidence_id: context.evidence_id_for_field("fields.tenant_identity"),
    source_type: "document_extraction",
    human_actor_id: null,
  });

  // 3. kaution assertion (optional — only emit if extracted)
  if (kaution && kaution.absence_state === "present" && kaution.normalized_value) {
    claims.push({
      property_id: context.property_id,
      subject,
      predicate: "kaution",
      value: {
        amount: kaution.normalized_value.amount,
        currency: kaution.normalized_value.currency,
        raw_value: kaution.raw_value,
      },
      claim_kind: "assertion",
      valid_from,
      valid_to,
      source_document_id: context.source_document_id,
      source_extraction_run_id: context.source_extraction_run_id,
      source_field_path: "fields.kaution",
      confidence: kaution.confidence ?? "medium",
      evidence_id: context.evidence_id_for_field("fields.kaution"),
      source_type: "document_extraction",
      human_actor_id: null,
    });
  }

  return {
    claims_to_insert: claims,
    closure_intents: [], // Mietvertrag closes nothing
  };
}
