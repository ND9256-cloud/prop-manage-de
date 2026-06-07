// Wohnungsübergabeprotokoll claim emitter. Dispatches on uebergabe_typ.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
// Input -> output. Tested in isolation. CI enforces (see emitter-purity.test.ts).
//
// Architecture refs:
//   §4.5   -- doc-type taxonomy + Übergabeprotokoll dispatch
//   §5.5.2 -- closing matrix (tenant_moved_out, ownership_transferred)
//   §5.5.3 -- close_mode semantics
//   §5.5.4 -- applier safety rules (Hofmann safeguard backstop)
//   schemas/wohnungsuebergabeprotokoll/schema.yaml -- fields, schema_version 2026-05-27-v1
//   domain_knowledge/wohnungsuebergabeprotokoll.md -- closes rules + Hofmann gotcha
//
// THE HOFMANN SAFEGUARD (read before editing the Eigentümerwechsel branch):
//   An Eigentümerwechsel transfers OWNERSHIP, not TENANCY. Under BGB §566
//   ("Kauf bricht nicht Miete"), existing leases survive a change of owner.
//   The Eigentümerwechsel branch MUST NEVER emit a closure intent targeting
//   tenant_active, kaltmiete, kaution, or nebenkostenvorauszahlung. It closes
//   ONLY the previous owner claim. Do not add tenant closures here under any
//   circumstance. The applier (§5.5.4 checkVacantPossessionWarning) is the
//   backstop, but the first line of defense is that this branch simply never
//   constructs such an intent. The safety is structural: the Eigentümerwechsel
//   function below has no code path that produces a tenant-related closure
//   intent. Real failure: Hofmann (HHS55 DG, Nov 2025).
//
// close_mode precedence note (architecture wins over domain knowledge):
//   The domain knowledge file declares close_overlapping_only for the
//   Eigentümerwechsel owner closure. Architecture §5.5.2 / §5.5.3 specify
//   close_overlapping_and_supersede_future for ownership transfers (the new
//   owner genuinely supersedes the prior one and we want
//   superseded_by_claim_id to preserve the audit chain). This emitter uses
//   the architecture value; the domain knowledge file will be updated to
//   match in a cosmetic follow-up.

import type {
  Claim,
  ClaimClosure,
  Confidence,
  EmissionResult,
  EmitterContext,
} from "./types.ts";
import type { Evidence } from "../evidence/types.ts";

export const EMITTER_NAME = "wohnungsuebergabeprotokoll";
export const EMITTER_VERSION = "1.0.0";

// --- Envelope shape ---------------------------------------------------------
// Mirrors warehouse.document_extractions_v2.fields for this doc_type. Only the
// subset the emitter consumes is typed; the envelope may carry more
// (meter_readings, damages_noted, signatures, vacant_possession_*).

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
  // Backward-compatible evidence union (Task 4.3c-b-ii-A): direct_quote or
  // table_cell. Typed so the envelope can carry table_cell without a type break.
  evidence?: Evidence[];
  normalized_value?: unknown;
}

interface EnumField extends FieldBase {
  normalized_value?: string;
}

interface DateField extends FieldBase {
  normalized_value?: string; // ISO date
}

interface PartyField extends FieldBase {
  normalized_value?: {
    name?: string;
    is_legal_entity?: boolean;
    legal_form?: string | null;
  };
}

interface UebergabeEnvelope {
  doc_type: "wohnungsuebergabeprotokoll";
  schema_version: string;
  fields: {
    uebergabe_typ?: EnumField;
    unit_ref?: EnumField;
    uebergabe_datum?: DateField;
    kaeufer?: PartyField;
    verkaeufer?: PartyField;
    mieter_in?: PartyField;
    mieter_out?: PartyField;
    [k: string]: FieldBase | undefined;
  };
  lifecycle?: Record<string, unknown>;
}

/** A field counts as "present" only when absence_state === "present". */
function isPresent(field: FieldBase | undefined): boolean {
  return field?.absence_state === "present";
}

/** Compute (date - 1 day) in UTC, returning YYYY-MM-DD. Mirrors Mieterhöhung. */
function previousDay(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure emitter. Dispatches on uebergabe_typ into four branches.
 *
 *   Einzug             → 1 tenant_active event claim, no closures
 *   Auszug             → 1 lease_terminated event claim + 4 closure intents
 *                        (kaltmiete, tenant_active, kaution,
 *                         nebenkostenvorauszahlung) close_overlapping_and_future
 *   Eigentümerwechsel  → 1 ownership_transferred event claim + 1 new owner
 *                        assertion claim + 1 closure intent for the previous
 *                        owner (close_overlapping_and_supersede_future).
 *                        NEVER closes tenant claims — the Hofmann safeguard.
 *   unklar / unknown   → empty result (defers to triage)
 *
 * Missing required field for a branch (e.g. Auszug without unit_ref) returns
 * an empty result rather than throwing — an incomplete Übergabeprotokoll is
 * still a valid document and should defer to human triage rather than crash
 * the pipeline. (Contrast with Mieterhöhung where missing new_kaltmiete is a
 * hard error because the document is then not a Mieterhöhung at all.)
 */
export function emitWohnungsuebergabeprotokollClaims(
  envelope: UebergabeEnvelope,
  context: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};

  const uebergabe_typ = isPresent(f.uebergabe_typ)
    ? (f.uebergabe_typ?.normalized_value as string | undefined) ?? null
    : null;
  const uebergabe_datum = isPresent(f.uebergabe_datum)
    ? (f.uebergabe_datum?.normalized_value as string | undefined) ?? null
    : null;

  // unklar, unrecognized, or missing → emit nothing.
  if (uebergabe_typ === null || uebergabe_typ === "unklar") {
    return { claims_to_insert: [], closure_intents: [] };
  }
  // Every branch needs the handover date.
  if (uebergabe_datum === null) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  switch (uebergabe_typ) {
    case "Einzug":
      return emitEinzug(f, context, uebergabe_datum);
    case "Auszug":
      return emitAuszug(f, context, uebergabe_datum);
    case "Eigentümerwechsel":
      return emitEigentuemerwechsel(f, context, uebergabe_datum);
    default:
      return { claims_to_insert: [], closure_intents: [] };
  }
}

// === Einzug ================================================================
// New tenant arrives. Emits a tenant_active event claim for the unit. Does
// NOT close any prior tenant_active — the previous tenant's departure is a
// separate Auszug document (per domain knowledge).

function emitEinzug(
  f: UebergabeEnvelope["fields"],
  context: EmitterContext,
  uebergabe_datum: string
): EmissionResult {
  const unit_ref = isPresent(f.unit_ref)
    ? (f.unit_ref?.normalized_value as string | undefined) ?? null
    : null;
  const mieterIn = isPresent(f.mieter_in) ? f.mieter_in?.normalized_value ?? null : null;
  if (unit_ref === null || mieterIn === null || !mieterIn.name) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  const subject = `unit:${unit_ref}`;

  const tenantActive: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "tenant_active",
    value: {
      tenants: [mieterIn],
      uebergabe_datum,
    },
    claim_kind: "event",
    valid_from: uebergabe_datum,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.mieter_in",
    confidence: "high",
    evidence_id: context.evidence_id_for_field("fields.mieter_in"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  return { claims_to_insert: [tenantActive], closure_intents: [] };
}

// === Auszug ================================================================
// Tenant departs. Emits the lease_terminated event claim (the applier's
// trigger / reason claim for closures and the dispatch key for the
// multi-tenant-partial blocker §5.5.5) plus four closure intents.
//
// Closing four predicates defensively: kaltmiete and tenant_active are
// guaranteed to have open claims from the Mietvertrag; kaution and
// nebenkostenvorauszahlung may not yet be emitted by the Mietvertrag emitter
// today, but closing a predicate with no open claims is a harmless no-op
// (findClaimsToClose returns []) and Auszug will already do the right thing
// when Mietvertrag starts emitting them.

function emitAuszug(
  f: UebergabeEnvelope["fields"],
  context: EmitterContext,
  uebergabe_datum: string
): EmissionResult {
  const unit_ref = isPresent(f.unit_ref)
    ? (f.unit_ref?.normalized_value as string | undefined) ?? null
    : null;
  const mieterOut = isPresent(f.mieter_out) ? f.mieter_out?.normalized_value ?? null : null;
  if (unit_ref === null || mieterOut === null || !mieterOut.name) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  const subject = `unit:${unit_ref}`;

  const leaseTerminated: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "lease_terminated",
    value: {
      // terminating_parties is read by the applier's checkMultiTenantPartial
      // blocker (§5.5.5) to verify every currently-active tenant on the unit
      // is leaving. For a single-tenant unit this is just mieter_out.
      terminating_parties: [mieterOut],
      uebergabe_datum,
    },
    claim_kind: "event",
    valid_from: uebergabe_datum,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.uebergabe_datum",
    confidence: "high",
    evidence_id: context.evidence_id_for_field("fields.uebergabe_datum"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  // tenant_active closure carries the tenant-identity match (required
  // strictness). The other three closures do NOT — their target claims
  // (kaltmiete, kaution, nebenkostenvorauszahlung) carry no tenants[] in
  // their value, so a required tenant-identity match would filter every
  // candidate out via applier.valueHasTenantMatch and the closure would
  // silently no-op. Per-predicate match policy is correct here.
  const tenantClosure: ClaimClosure = {
    target_subject: subject,
    target_predicates: ["tenant_active"],
    close_at: uebergabe_datum,
    close_mode: "close_overlapping_and_future",
    match: { tenant_identity: mieterOut.name },
    match_strictness: "required",
    blocker_status: "none",
  };

  const otherClosures: ClaimClosure[] = ["kaltmiete", "kaution", "nebenkostenvorauszahlung"].map(
    (predicate) => ({
      target_subject: subject,
      target_predicates: [predicate],
      close_at: uebergabe_datum,
      close_mode: "close_overlapping_and_future",
      match: {},
      match_strictness: "absent",
      blocker_status: "none",
    })
  );

  return {
    claims_to_insert: [leaseTerminated],
    closure_intents: [tenantClosure, ...otherClosures],
  };
}

// === Eigentümerwechsel =====================================================
// Property sale. Owner changes; tenants do NOT. Emits:
//   1. ownership_transferred event claim (subject "property") — applier's
//      trigger / reason claim and dispatch key for checkVacantPossessionWarning
//   2. new owner assertion claim (subject "property", value.owner = kaeufer)
//   3. closure intent for the previous owner (target_predicates ["owner"]),
//      close_overlapping_and_supersede_future, close_at = uebergabe_datum - 1
//
// THE HOFMANN SAFEGUARD: this function DELIBERATELY does not construct any
// closure intent for tenant_active / kaltmiete / kaution / nebenkostenvor-
// auszahlung. Do not add one. The applier's checkVacantPossessionWarning
// rejects ownership→tenant closures as a backstop, but the structural defense
// is here.

function emitEigentuemerwechsel(
  f: UebergabeEnvelope["fields"],
  context: EmitterContext,
  uebergabe_datum: string
): EmissionResult {
  const kaeufer = isPresent(f.kaeufer) ? f.kaeufer?.normalized_value ?? null : null;
  const verkaeufer = isPresent(f.verkaeufer) ? f.verkaeufer?.normalized_value ?? null : null;
  if (kaeufer === null || !kaeufer.name || verkaeufer === null || !verkaeufer.name) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  // Owner claims are property-level. The literal "property" subject is per
  // architecture §4.2 examples; property_id is already a separate column.
  const subject = "property";

  const ownershipTransferred: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "ownership_transferred",
    value: {
      previous_owner: verkaeufer,
      new_owner: kaeufer,
      uebergabe_datum,
    },
    claim_kind: "event",
    valid_from: uebergabe_datum,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.uebergabe_datum",
    confidence: "high",
    evidence_id: context.evidence_id_for_field("fields.uebergabe_datum"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  const ownerAssertion: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "owner",
    value: {
      owner: kaeufer,
    },
    claim_kind: "assertion",
    valid_from: uebergabe_datum,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.kaeufer",
    confidence: "high",
    evidence_id: context.evidence_id_for_field("fields.kaeufer"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  // The previous owner's authority ends the day before the new owner takes
  // over. new_owner.valid_from = uebergabe_datum; previous owner close_at =
  // uebergabe_datum - 1 (per spec §5.5.3 and §5.5.2 for ownership transfers).
  const close_at = previousDay(uebergabe_datum);

  // match.tenant_identity carries the verkaeufer name here because the
  // shipped ClaimClosure.match shape has no dedicated owner_identity slot.
  // match_strictness is "optional" so the applier does not require value
  // match against tenants[] (owner claim values carry value.owner, not
  // tenants[]). The identity is documented for the audit trail; if multiple
  // open owner claims ever exist (they shouldn't), a future owner-aware
  // match strategy can use this field.
  const ownerClosure: ClaimClosure = {
    target_subject: subject,
    target_predicates: ["owner"],
    close_at,
    close_mode: "close_overlapping_and_supersede_future",
    match: { tenant_identity: verkaeufer.name },
    match_strictness: "optional",
    blocker_status: "none",
  };

  return {
    claims_to_insert: [ownershipTransferred, ownerAssertion],
    closure_intents: [ownerClosure],
  };
}
