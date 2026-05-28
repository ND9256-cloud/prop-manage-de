// Mietvertragsnachtrag claim emitter. Dispatches on nachtrag_scope.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
// Input -> output. Tested in isolation. CI enforces (see emitter-purity.test.ts).
//
// Architecture refs:
//   §4.2   -- claim_kind enum includes "reference"
//   §4.4   -- emitter contract (pure function)
//   §4.5   -- doc-type taxonomy + Nachtrag dispatch
//   schemas/mietvertragsnachtrag/schema.yaml -- fields, schema_version 2026-05-28-v1
//   domain_knowledge/mietvertragsnachtrag.md -- delegation + gotchas
//
// Dispatch:
//   rent_change → reshape into a Mieterhöhung-shaped extraction, delegate to
//     emitMieterhoehungClaims. Single source of truth for the kaltmiete
//     close_overlapping_only supersession. A bilateral rent-change Nachtrag
//     and a unilateral §558 notice therefore produce byte-identical claim
//     shapes and identical close edges.
//   tenant_identity_change / deposit_change / ancillary_cost_change /
//   term_change / usage_right_change / other →
//     one reference-kind "amendment_present" claim carrying scope + payload
//     + status "unsupported_requires_review". NO closure intents.
//     Critically, tenant_identity_change does NOT close tenant_active.
//
// Missing nachtrag_scope or an unknown scope returns an empty result (defers
// to triage). Inside the rent_change branch, an absent new_kaltmiete reaches
// the Mieterhöhung emitter and throws there — the loud failure that protects
// against silent rent corruption when Step 4 misroutes a non-rent Nachtrag.

import type {
  Claim,
  Confidence,
  EmissionResult,
  EmitterContext,
} from "./types.ts";
import { emitMieterhoehungClaims } from "./mieterhoehung.ts";

export const EMITTER_NAME = "mietvertragsnachtrag";
export const EMITTER_VERSION = "1.0.0";

// --- Envelope shape ---------------------------------------------------------
// Mirrors warehouse.document_extractions_v2.fields for this doc_type. Only the
// subset the emitter consumes is typed; the envelope may carry more.

type AbsenceState =
  | "present"
  | "absent"
  | "illegible"
  | "ambiguous"
  | "contradicted"
  | "not_applicable"
  | "inferred"
  | "requires_human_review";

interface FieldBase {
  absence_state: AbsenceState;
  confidence?: Confidence;
  raw_value?: string;
  evidence?: { page?: number; quote?: string }[];
  normalized_value?: unknown;
}

interface EnumField extends FieldBase {
  normalized_value?: string;
}

interface DateField extends FieldBase {
  normalized_value?: string; // ISO date
}

interface BooleanField extends FieldBase {
  normalized_value?: boolean;
}

interface StructuredField extends FieldBase {
  // Scopes carry per-scope structured payloads. The exact shape is per-scope
  // and validated upstream by the envelope_validator; the emitter reads keys
  // it knows about and forwards the rest as opaque payload.
  normalized_value?: Record<string, unknown>;
}

interface MoneyValue {
  amount: number;
  currency: string;
}

interface MietvertragsnachtragEnvelope {
  doc_type: "mietvertragsnachtrag";
  schema_version: string;
  fields: {
    nachtrag_scope?: EnumField;
    unit_ref?: EnumField;
    effective_date?: DateField;
    tenant_identity?: StructuredField;
    landlord_signature_present?: BooleanField;
    tenant_signature_present?: BooleanField;
    document_status?: EnumField;
    rent_change_payload?: StructuredField;
    tenant_identity_change_payload?: StructuredField;
    deposit_change_payload?: StructuredField;
    ancillary_cost_change_payload?: StructuredField;
    term_change_payload?: StructuredField;
    usage_right_change_payload?: StructuredField;
    other_change_descriptor?: FieldBase;
    [k: string]: FieldBase | undefined;
  };
  lifecycle?: Record<string, unknown>;
}

/** A field counts as "present" only when absence_state === "present". */
function isPresent(field: FieldBase | undefined): boolean {
  return field?.absence_state === "present";
}

/** Extracts the typed payload for the active scope; returns {} when absent. */
function payloadForScope(
  fields: MietvertragsnachtragEnvelope["fields"],
  scope: string
): Record<string, unknown> {
  const keyByScope: Record<string, string> = {
    tenant_identity_change: "tenant_identity_change_payload",
    deposit_change: "deposit_change_payload",
    ancillary_cost_change: "ancillary_cost_change_payload",
    term_change: "term_change_payload",
    usage_right_change: "usage_right_change_payload",
  };
  const key = keyByScope[scope];
  if (key) {
    const field = fields[key] as StructuredField | undefined;
    return isPresent(field) ? (field?.normalized_value as Record<string, unknown>) ?? {} : {};
  }
  if (scope === "other") {
    const desc = fields.other_change_descriptor;
    if (isPresent(desc)) {
      return { description: desc?.normalized_value };
    }
    return {};
  }
  return {};
}

/**
 * Pure emitter. Dispatches on nachtrag_scope.
 *
 * rent_change          → delegate to emitMieterhoehungClaims (single source of
 *                        truth for kaltmiete close_overlapping_only supersession)
 * tenant_identity_change |
 * deposit_change         |
 * ancillary_cost_change  | → one reference "amendment_present" claim,
 * term_change            |   value.status = "unsupported_requires_review",
 * usage_right_change     |   NO closure intents.
 * other                  |
 *
 * Missing or unknown nachtrag_scope returns an empty result (defers to triage).
 */
export function emitMietvertragsnachtragClaims(
  envelope: MietvertragsnachtragEnvelope,
  context: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};

  const scopeField = f.nachtrag_scope;
  if (!isPresent(scopeField)) {
    return { claims_to_insert: [], closure_intents: [] };
  }
  const scope = scopeField?.normalized_value ?? null;
  if (!scope) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  // --- rent_change → delegate ----------------------------------------------
  // Reshape rent_change_payload + the common fields into a Mieterhöhung-shaped
  // extraction and hand off. The Mieterhöhung emitter owns the kaltmiete
  // close_overlapping_only supersession; this branch does NOT reimplement it.
  if (scope === "rent_change") {
    const rentPayloadField = f.rent_change_payload as StructuredField | undefined;
    const payload = isPresent(rentPayloadField)
      ? (rentPayloadField?.normalized_value as Record<string, unknown>) ?? {}
      : {};

    const newKaltmiete = payload.new_kaltmiete as MoneyValue | undefined;
    const previousKaltmiete = payload.previous_kaltmiete as MoneyValue | undefined;
    const rechtsgrundlage =
      (payload.rechtsgrundlage as string | undefined) ?? "bilateral";
    const staffelmieteContext =
      typeof payload.staffelmiete_context === "boolean"
        ? (payload.staffelmiete_context as boolean)
        : false;

    // Build a Mieterhöhung envelope. Field shapes mirror exactly what
    // emitMieterhoehungClaims reads. When new_kaltmiete is absent the
    // delegate will throw — that is the safe loud failure we want.
    const mieterhoehungEnvelope = {
      doc_type: "mieterhoehung" as const,
      schema_version: envelope.schema_version,
      fields: {
        new_kaltmiete: newKaltmiete
          ? {
              absence_state: "present" as const,
              confidence: rentPayloadField?.confidence ?? "high",
              raw_value: rentPayloadField?.raw_value,
              normalized_value: newKaltmiete,
            }
          : { absence_state: "absent" as const },
        previous_kaltmiete: previousKaltmiete
          ? {
              absence_state: "present" as const,
              confidence: rentPayloadField?.confidence ?? "high",
              normalized_value: previousKaltmiete,
            }
          : { absence_state: "absent" as const },
        effective_date: f.effective_date,
        unit_ref: f.unit_ref,
        tenant_identity: f.tenant_identity,
        landlord_signature_present: f.landlord_signature_present,
        document_status: f.document_status,
        rechtsgrundlage: {
          absence_state: "present" as const,
          confidence: "high" as const,
          normalized_value: rechtsgrundlage,
        },
        staffelmiete_context: {
          absence_state: "present" as const,
          confidence: "high" as const,
          normalized_value: staffelmieteContext,
        },
      },
      lifecycle: envelope.lifecycle ?? {},
    };

    return emitMieterhoehungClaims(mieterhoehungEnvelope as never, context);
  }

  // --- non-rent scopes → one reference claim, no closures ------------------
  const knownScopes = new Set([
    "tenant_identity_change",
    "deposit_change",
    "ancillary_cost_change",
    "term_change",
    "usage_right_change",
    "other",
  ]);
  if (!knownScopes.has(scope)) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  const unit_ref = isPresent(f.unit_ref) ? f.unit_ref?.normalized_value ?? null : null;
  const subject = unit_ref ? `unit:${unit_ref}` : "property";

  const effective_date = isPresent(f.effective_date)
    ? f.effective_date?.normalized_value ?? null
    : null;
  const valid_from = effective_date ?? new Date().toISOString().slice(0, 10);

  const referenceClaim: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "amendment_present",
    value: {
      scope,
      status: "unsupported_requires_review",
      payload: payloadForScope(f, scope),
    },
    claim_kind: "reference",
    valid_from,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.nachtrag_scope",
    confidence: "medium",
    evidence_id: context.evidence_id_for_field("fields.nachtrag_scope"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  return { claims_to_insert: [referenceClaim], closure_intents: [] };
}
