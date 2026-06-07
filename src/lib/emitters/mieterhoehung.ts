// Mieterhöhung claim emitter.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
// Input -> output. Tested in isolation. CI enforces (see emitter-purity.test.ts).
//
// Architecture refs:
//   §4.4  -- emitter contract (pure function)
//   §5.5.2 -- closing matrix: kaltmiete_amended -> kaltmiete, close_overlapping_only
//   §5.5.3 -- close_mode semantics
//   §5.5.5 -- claim-aware blockers (applier-side; emitter only sets the advisory flag)
//   schemas/mieterhoehung/schema.yaml -- fields, schema_version 2026-05-27-v1
//   domain_knowledge/mieterhoehung.md -- closes rule + gotchas
//
// First emitter in the v2 chain that produces closure intents. The claim-store
// applier (Task 1.8) requires exactly one event claim whenever a closure intent
// is present, and dispatches its Staffelmiete blocker check on the event claim's
// predicate ("kaltmiete_amended"). So the event claim and the closure intent are
// emitted together or not at all.

import type {
  Claim,
  ClaimClosure,
  Confidence,
  EmissionResult,
  EmitterContext,
} from "./types.ts";
import type { Evidence } from "../evidence/types.ts";

export const EMITTER_NAME = "mieterhoehung";
export const EMITTER_VERSION = "1.0.0";

/**
 * Minimal envelope shape this emitter reads. Mirrors
 * warehouse.document_extractions_v2.fields. Only the subset of fields the
 * emitter consumes is typed; the envelope may carry more (the §558/§559/Index
 * structured sub-objects are extractor-side and ignored here).
 */
interface MieterhoehungEnvelope {
  doc_type: "mieterhoehung";
  schema_version: string;
  fields: {
    new_kaltmiete?: MoneyField;
    previous_kaltmiete?: MoneyField;
    effective_date?: DateField;
    notice_date?: DateField;
    unit_ref?: EnumField;
    tenant_identity?: StructuredField;
    landlord_signature_present?: BooleanField;
    tenant_signature_present?: BooleanField;
    document_status?: EnumField;
    rechtsgrundlage?: EnumField;
    nachtrag_typ?: EnumField;
    staffelmiete_context?: BooleanField;
    [k: string]: FieldBase | undefined;
  };
  lifecycle?: Record<string, unknown>;
}

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

interface MoneyField extends FieldBase {
  normalized_value?: { amount: number; currency: string };
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
  normalized_value?: { name?: string; is_legal_entity?: boolean; legal_form?: string | null };
}

/** A field counts as "present" only when absence_state === "present". */
function isPresent(field: FieldBase | undefined): boolean {
  return field?.absence_state === "present";
}

/**
 * Pure emitter. Returns claims and closure intents derived from the envelope.
 *
 * Always emits:
 *   - one kaltmiete assertion claim (subject "unit:<unit_ref>"). Confidence is
 *     downgraded to "low" when closure prerequisites fail, so a draft/unsigned
 *     increase still surfaces its proposed rent in triage without silently
 *     superseding the open claim.
 *
 * Emits additionally, only when ALL closure prerequisites pass:
 *   - one kaltmiete_amended event claim (the applier's trigger claim and the
 *     reason_claim_id for every closure it writes)
 *   - one closure intent (ClaimClosure) targeting the prior open kaltmiete claim
 *     via close_overlapping_only, close edge = effective_date - 1 day.
 *
 * Closure prerequisites (front-matter `when`, §5.5.5):
 *   landlord_signature_present == true
 *   effective_date present
 *   unit_ref present
 *   document_status not in {draft, unsigned}
 *
 * Throws when new_kaltmiete is absent — without the new rent the document is not
 * a Mieterhöhung (it is a non-rent Mietvertragsnachtrag, or a misclassification).
 */
export function emitMieterhoehungClaims(
  envelope: MieterhoehungEnvelope,
  context: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};

  const newKaltmieteField = f.new_kaltmiete as MoneyField | undefined;
  const effectiveDateField = f.effective_date as DateField | undefined;
  const noticeDateField = f.notice_date as DateField | undefined;
  const unitRefField = f.unit_ref as EnumField | undefined;
  const landlordSigField = f.landlord_signature_present as BooleanField | undefined;
  const documentStatusField = f.document_status as EnumField | undefined;
  const staffelmieteField = f.staffelmiete_context as BooleanField | undefined;
  const tenantField = f.tenant_identity as StructuredField | undefined;
  const rechtsgrundlageField = f.rechtsgrundlage as EnumField | undefined;
  const previousKaltmieteField = f.previous_kaltmiete as MoneyField | undefined;

  // --- new_kaltmiete is load-bearing: absent is a hard error -----------------
  if (
    !isPresent(newKaltmieteField) ||
    !newKaltmieteField?.normalized_value ||
    typeof newKaltmieteField.normalized_value.amount !== "number"
  ) {
    throw new Error(
      `mieterhoehung emitter: new_kaltmiete is required but absent ` +
        `(absence_state=${newKaltmieteField?.absence_state ?? "missing"}); cannot emit. ` +
        `A document without a new rent is not a Mieterhöhung.`
    );
  }
  const newKaltmiete = newKaltmieteField.normalized_value;

  const effective_date = isPresent(effectiveDateField)
    ? effectiveDateField?.normalized_value ?? null
    : null;
  const notice_date = isPresent(noticeDateField)
    ? noticeDateField?.normalized_value ?? null
    : null;
  const unit_ref = isPresent(unitRefField) ? unitRefField?.normalized_value ?? null : null;
  const landlord_signed =
    isPresent(landlordSigField) && landlordSigField?.normalized_value === true;
  const document_status = isPresent(documentStatusField)
    ? documentStatusField?.normalized_value ?? null
    : null;
  const staffelmiete_context =
    isPresent(staffelmieteField) && staffelmieteField?.normalized_value === true;
  const tenant = isPresent(tenantField) ? tenantField?.normalized_value ?? null : null;

  // --- Closure prerequisite check (front-matter `when`, §5.5.5) --------------
  const prerequisitesMet =
    landlord_signed === true &&
    effective_date !== null &&
    unit_ref !== null &&
    document_status !== "draft" &&
    document_status !== "unsigned";

  const subject = unit_ref ? `unit:${unit_ref}` : "unit:unknown";

  // valid_from for the new claim: effective_date when present; otherwise
  // notice_date if available; otherwise today. (close edge never uses these
  // fallbacks — it is only computed when effective_date is present.)
  const valid_from =
    effective_date ?? notice_date ?? new Date().toISOString().slice(0, 10);

  const confidence: Confidence = prerequisitesMet ? "high" : "low";

  const claims: Claim[] = [];

  // 1. New kaltmiete assertion — always emitted.
  claims.push({
    property_id: context.property_id,
    subject,
    predicate: "kaltmiete",
    value: {
      amount: newKaltmiete.amount,
      currency: newKaltmiete.currency,
      raw_value: newKaltmieteField.raw_value,
    },
    claim_kind: "assertion",
    valid_from,
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.new_kaltmiete",
    confidence,
    evidence_id: context.evidence_id_for_field("fields.new_kaltmiete"),
    source_type: "document_extraction",
    human_actor_id: null,
  });

  const closure_intents: ClaimClosure[] = [];

  if (prerequisitesMet) {
    // 2. kaltmiete_amended event claim — the applier's trigger / reason claim.
    claims.push({
      property_id: context.property_id,
      subject,
      predicate: "kaltmiete_amended",
      value: {
        new_amount: newKaltmiete.amount,
        currency: newKaltmiete.currency,
        previous_amount: previousKaltmieteField?.normalized_value?.amount ?? null,
        effective_date,
        rechtsgrundlage: rechtsgrundlageField?.normalized_value ?? null,
      },
      claim_kind: "event",
      valid_from: effective_date as string,
      valid_to: null,
      source_document_id: context.source_document_id,
      source_extraction_run_id: context.source_extraction_run_id,
      source_field_path: "fields.effective_date",
      confidence,
      evidence_id: context.evidence_id_for_field("fields.effective_date"),
      source_type: "document_extraction",
      human_actor_id: null,
    });

    // 3. Closure intent. close_at = effective_date - 1 day (UTC).
    const effDate = new Date((effective_date as string) + "T00:00:00.000Z");
    effDate.setUTCDate(effDate.getUTCDate() - 1);
    const close_at = effDate.toISOString().slice(0, 10);

    const tenantName = tenant?.name ?? null;

    closure_intents.push({
      target_subject: subject,
      target_predicates: ["kaltmiete"],
      close_at,
      close_mode: "close_overlapping_only",
      match: tenantName ? { tenant_identity: tenantName } : {},
      match_strictness: tenantName ? "optional" : "absent",
      // Advisory flag only. The applier (checkStaffelmieteConflict, §5.5.5)
      // re-checks the claim store for open future-dated kaltmiete claims and
      // blocks regardless of this flag.
      blocker_status: staffelmiete_context ? "requires_review" : "none",
    });
  }

  return {
    claims_to_insert: claims,
    closure_intents,
  };
}
