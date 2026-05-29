// src/lib/claim-store/applier.ts
//
// Claim-store transaction applier.
// Architecture §5.5. The only writer to warehouse.claims, warehouse.claim_closures,
// and warehouse.derivation_records in normal pipeline operation.
//
// Wraps insertion + closure application in a single Postgres transaction.
// Any safety-rule failure rolls back the entire batch.
//
// Pure functions live elsewhere (emitters, fuzzy-tenant-match). This module
// is the I/O boundary.

import { prisma } from "@/lib/db";
import type { Claim, ClaimClosure, EmissionResult } from "../emitters/types.ts";
import type {
  ApplyContext,
  ApplyResult,
  BlockedClosureIntent,
} from "./types.ts";
import { APPLIER_VERSION } from "./types.ts";
import { fuzzyTenantMatch } from "./fuzzy-tenant-match.ts";

// TODO(closing-matrix-allowlist): enforce predicate-pair allowlist from
// domain knowledge front-matter (§5.5.4). Currently the applier accepts any
// (event_predicate, target_predicate) pair. The closing-matrix consumer
// contract is a separate task after the second emitter type ships.

// TODO(optional-match-confidence-downgrade): when intent.match_strictness =
// "optional" and fuzzy match fails, downgrade the closure's confidence rather
// than ignoring the match. Currently optional == always proceed. Architecture
// §5.5.4 wording allows either interpretation; clarify before second emitter.

/**
 * The subset of PrismaClient that is available inside a $transaction callback.
 * Used to allow tests to inject their own transaction for rollback-based cleanup.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrismaTransactionClient = any;

/**
 * Apply an EmissionResult: insert claims, apply closures, write DerivationRecords.
 * One Postgres transaction. Rolls back on any safety failure.
 *
 * When opts.tx is provided, the applier uses that transaction client instead of
 * opening a new one. This allows tests to wrap calls in their own transaction
 * and throw to rollback, avoiding GoBD-blocked DELETEs.
 */
export async function applyEmission(
  emission: EmissionResult,
  context: ApplyContext,
  opts?: { tx?: PrismaTransactionClient }
): Promise<ApplyResult> {
  // Pre-transaction sanity: every claim in claims_to_insert must reference
  // context.property_id. Cross-property emission is a hard error.
  for (const c of emission.claims_to_insert) {
    if (c.property_id !== context.property_id) {
      throw new Error(
        `Claim property_id ${c.property_id} does not match context.property_id ${context.property_id}`
      );
    }
  }

  if (opts?.tx) {
    return applyEmissionInner(opts.tx, emission, context);
  }
  return prisma.$transaction(async (tx) => {
    return applyEmissionInner(tx, emission, context);
  });
}

async function applyEmissionInner(
  tx: PrismaTransactionClient,
  emission: EmissionResult,
  context: ApplyContext
): Promise<ApplyResult> {
  // --- Tenant-isolation guard --------------------------------------------
  // @tenant-isolation-disable-next-line -- reason: claim-store applier verifies property belongs to org before any warehouse write, org_id from pipeline caller context
  const orgCheck = await tx.$queryRaw<{ organizationId: string }[]>`
    SELECT "organizationId" FROM "Property" WHERE id = ${context.property_id}::uuid
  `;
  if (orgCheck.length === 0) {
    throw new Error(`Property ${context.property_id} not found`);
  }
  if (orgCheck[0].organizationId !== context.org_id) {
    throw new Error(
      `Property ${context.property_id} does not belong to org ${context.org_id}`
    );
  }

  // --- Insert claims (with idempotency + supersession on value change) ---
  // Fact identity is (source_document_id, subject, predicate, valid_from).
  // The applier dedups on that tuple, not on source_extraction_run_id, so
  // re-processing a document doesn't stack parallel active claims.
  //   identical re-emission (same value)    → no-op (no insert, no supersede)
  //   same identity, different value         → supersede prior active claim
  //                                            via close_overlapping_and_supersede_future
  // Value equality is canonical (Postgres jsonb=jsonb in SQL).
  const inserted_claim_ids: string[] = [];
  const skipped_duplicate_claim_ids: string[] = [];
  const applied_closure_ids: string[] = [];
  const derivation_record_ids: string[] = [];
  // Map: claim object → its DB id (used by event-claim dispatch later)
  const claimIdByObject = new Map<Claim, string>();

  for (const claim of emission.claims_to_insert) {
    const existing = await findExistingClaim(tx, claim);
    if (existing && existing.value_matches) {
      // Identical re-application: true no-op.
      skipped_duplicate_claim_ids.push(existing.id);
      claimIdByObject.set(claim, existing.id);
      continue;
    }

    const insertedId = await insertClaim(tx, claim);
    inserted_claim_ids.push(insertedId);
    claimIdByObject.set(claim, insertedId);

    const drId = await writeDerivationRecord(tx, {
      property_id: claim.property_id,
      output_type: "claim",
      output_id: insertedId,
      input_claim_ids: [],
      input_extraction_run_ids: claim.source_extraction_run_id
        ? [claim.source_extraction_run_id]
        : [],
      rule_refs: [],
      emitter_version: context.emitter_version,
    });
    derivation_record_ids.push(drId);

    if (existing && !existing.value_matches) {
      // Same (source_document_id, subject, predicate, valid_from) but value
      // changed: supersede the prior active claim. Reuses the closure path
      // (UPDATE valid_to + superseded_at + superseded_by_claim_id, INSERT
      // claim_closures audit row) per §5.5.3.
      const closureId = await applyClosure(tx, {
        target_claim_id: existing.id,
        reason_claim_id: insertedId,
        close_mode: "close_overlapping_and_supersede_future",
        applied_valid_to: claim.valid_from,
      });
      applied_closure_ids.push(closureId);

      const closureDrId = await writeDerivationRecord(tx, {
        property_id: claim.property_id,
        output_type: "closure",
        output_id: closureId,
        input_claim_ids: [insertedId, existing.id],
        input_extraction_run_ids: context.extraction_run_id
          ? [context.extraction_run_id]
          : [],
        rule_refs: ["applier-dedup-supersession"],
        emitter_version: context.emitter_version,
      });
      derivation_record_ids.push(closureDrId);
    }
  }

  // --- Apply closures ---------------------------------------------------
  const blocked_closure_intents: BlockedClosureIntent[] = [];

  // Identify triggering event claim (must be exactly one if closure_intents
  // is non-empty, otherwise blocker dispatch is undefined).
  let triggerClaim: Claim | undefined;
  let triggerClaimId: string | undefined;
  if (emission.closure_intents.length > 0) {
    const eventClaims = emission.claims_to_insert.filter(
      c => c.claim_kind === "event"
    );
    if (eventClaims.length !== 1) {
      throw new Error(
        `EmissionResult with closure_intents must contain exactly 1 event claim, found ${eventClaims.length}`
      );
    }
    triggerClaim = eventClaims[0];
    triggerClaimId = claimIdByObject.get(triggerClaim);
  }

  for (const intent of emission.closure_intents) {
    // Respect emitter-set blocker_status.
    if (intent.blocker_status === "requires_review") {
      blocked_closure_intents.push({
        intent,
        reason: "emitter_set_requires_review",
        detail: "Emitter pre-flagged this closure as requires_review",
      });
      continue;
    }

    // Claim-aware blocker checks (§5.5.5). Dispatched on triggerClaim.predicate.
    const blockerCheck = await runBlockerChecks(tx, intent, triggerClaim!, context);
    if (blockerCheck) {
      blocked_closure_intents.push(blockerCheck);
      continue;
    }

    // Apply closure for each target_predicate.
    // Exclude claims just inserted in this emission — we don't close our own new claims.
    const allJustInsertedIds = new Set([...inserted_claim_ids, ...skipped_duplicate_claim_ids]);
    const targetClaimIds = (await findClaimsToClose(tx, intent, context.property_id))
      .filter(id => !allJustInsertedIds.has(id));

    for (const targetClaimId of targetClaimIds) {
      // Safety: no retroactive reach into already-superseded history.
      // @tenant-isolation-disable-next-line -- reason: claim-store applier checks supersession state before closure, property scoped via findClaimsToClose query
      const target = await tx.$queryRaw<
        { valid_from: Date; valid_to: Date | null; superseded_by_claim_id: string | null }[]
      >`
        SELECT valid_from, valid_to, superseded_by_claim_id
        FROM warehouse.claims WHERE id = ${targetClaimId}::uuid
      `;
      if (target.length === 0) continue;
      if (target[0].superseded_by_claim_id !== null) {
        // Cannot reach into already-superseded chain.
        continue;
      }

      // For future claims (valid_from > close_at), use valid_from as valid_to
      // to satisfy the valid_interval_sane CHECK constraint (valid_to >= valid_from).
      const targetValidFrom = target[0].valid_from instanceof Date
        ? target[0].valid_from.toISOString().slice(0, 10)
        : String(target[0].valid_from);
      const effectiveValidTo = targetValidFrom > intent.close_at
        ? targetValidFrom
        : intent.close_at;

      const closureId = await applyClosure(tx, {
        target_claim_id: targetClaimId,
        reason_claim_id: triggerClaimId!,
        close_mode: intent.close_mode,
        applied_valid_to: effectiveValidTo,
      });
      applied_closure_ids.push(closureId);

      const drId = await writeDerivationRecord(tx, {
        property_id: context.property_id,
        output_type: "closure",
        output_id: closureId,
        input_claim_ids: [triggerClaimId!, targetClaimId],
        input_extraction_run_ids: context.extraction_run_id
          ? [context.extraction_run_id]
          : [],
        rule_refs: [],
        emitter_version: context.emitter_version,
      });
      derivation_record_ids.push(drId);
    }
  }

  return {
    inserted_claim_ids,
    skipped_duplicate_claim_ids,
    applied_closure_ids,
    blocked_closure_intents,
    derivation_record_ids,
  };
}

// === Helpers ==============================================================

/**
 * Look up an active claim with the same fact identity as `claim`:
 * (source_document_id, subject, predicate, valid_from).
 *
 * Returns the matching claim id plus a SQL-computed `value_matches` flag
 * (Postgres jsonb=jsonb — canonical: keys are sorted, whitespace is normalized,
 * numeric scalars compare by value not text). The caller uses `value_matches`
 * to distinguish "identical re-emission (skip)" from "same fact corrected
 * (supersede)".
 *
 * Filter `superseded_by_claim_id IS NULL AND valid_to IS NULL` restricts the
 * lookup to currently-active claims so that supersession path doesn't try to
 * re-set the immutable valid_to of an already-closed historical claim.
 *
 * Returns null when source_extraction_run_id is null (human_adjudication
 * path) — those claims never participate in extraction-replay dedup.
 */
async function findExistingClaim(
  tx: PrismaTransactionClient,
  claim: Claim
): Promise<{ id: string; value_matches: boolean } | null> {
  if (!claim.source_extraction_run_id) return null;
  if (!claim.source_document_id) return null;
  // @tenant-isolation-disable-next-line -- reason: claim-store applier dedup SELECT keyed on source_document_id which is property-scoped via warehouse.documents, property/org verified at transaction start
  const rows = await tx.$queryRaw<{ id: string; value_matches: boolean }[]>`
    SELECT id,
           value = ${JSON.stringify(claim.value)}::jsonb AS value_matches
    FROM warehouse.claims
    WHERE source_document_id = ${claim.source_document_id}::uuid
      AND subject = ${claim.subject}
      AND predicate = ${claim.predicate}
      AND valid_from = ${claim.valid_from}::date
      AND valid_to IS NULL
      AND superseded_by_claim_id IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function insertClaim(tx: PrismaTransactionClient, claim: Claim): Promise<string> {
  // @tenant-isolation-disable-next-line -- reason: claim-store applier INSERT into warehouse.claims, property_id verified against org at transaction start
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.claims (
      property_id, subject, predicate, value, claim_kind, source_type,
      valid_from, valid_to,
      source_document_id, source_extraction_run_id, source_field_path,
      human_actor_id, confidence, evidence_id
    ) VALUES (
      ${claim.property_id}::uuid, ${claim.subject}, ${claim.predicate},
      ${JSON.stringify(claim.value)}::jsonb, ${claim.claim_kind}, ${claim.source_type},
      ${claim.valid_from}::date, ${claim.valid_to ?? null}::date,
      ${claim.source_document_id}::uuid,
      ${claim.source_extraction_run_id ? claim.source_extraction_run_id : null}::uuid,
      ${claim.source_field_path},
      ${claim.human_actor_id ? claim.human_actor_id : null}::uuid, ${claim.confidence},
      ${claim.evidence_id ? claim.evidence_id : null}::uuid
    ) RETURNING id
  `;
  return rows[0].id;
}

async function findClaimsToClose(
  tx: PrismaTransactionClient,
  intent: ClaimClosure,
  property_id: string
): Promise<string[]> {
  const predicates = intent.target_predicates;
  const subject = intent.target_subject;
  const closeAt = intent.close_at;

  // Three close_modes → three SQL patterns.
  let rows: { id: string; value: Record<string, unknown> }[];
  if (intent.close_mode === "close_overlapping_only") {
    // @tenant-isolation-disable-next-line -- reason: claim-store applier SELECT claims to close, property scoped by property_id parameter verified at transaction start
    rows = await tx.$queryRaw<{ id: string; value: Record<string, unknown> }[]>`
      SELECT id, value FROM warehouse.claims
      WHERE property_id = ${property_id}::uuid
        AND subject = ${subject}
        AND predicate = ANY(${predicates}::text[])
        AND valid_from <= ${closeAt}::date
        AND (valid_to IS NULL OR valid_to > ${closeAt}::date)
        AND superseded_by_claim_id IS NULL
    `;
  } else {
    // close_overlapping_and_future and close_overlapping_and_supersede_future
    // share the same SELECT; difference is in UPDATE (handled by applyClosure).
    // @tenant-isolation-disable-next-line -- reason: claim-store applier SELECT claims to close including future, property scoped by property_id parameter verified at transaction start
    rows = await tx.$queryRaw<{ id: string; value: Record<string, unknown> }[]>`
      SELECT id, value FROM warehouse.claims
      WHERE property_id = ${property_id}::uuid
        AND subject = ${subject}
        AND predicate = ANY(${predicates}::text[])
        AND (
          (valid_from <= ${closeAt}::date AND (valid_to IS NULL OR valid_to > ${closeAt}::date))
          OR valid_from > ${closeAt}::date
        )
        AND superseded_by_claim_id IS NULL
    `;
  }

  // Match filtering — if intent.match_strictness requires tenant identity,
  // filter rows whose value.tenants[*].name does not fuzzy-match.
  if (intent.match_strictness === "required" && intent.match.tenant_identity) {
    return rows
      .filter(r => valueHasTenantMatch(r.value, intent.match.tenant_identity!))
      .map(r => r.id);
  }
  if (intent.match_strictness === "optional" && intent.match.tenant_identity) {
    // Optional match: prefer matches but include non-matching rows with confidence
    // downgrade (downgrade is a Phase 1.5 follow-up; for now include all rows).
    return rows.map(r => r.id);
  }
  return rows.map(r => r.id);
}

function valueHasTenantMatch(value: Record<string, unknown>, tenantName: string): boolean {
  // tenant_active claims have value.tenants[]; other predicates might not.
  if (!value || !Array.isArray(value.tenants)) return false;
  for (const t of value.tenants) {
    if (typeof t?.name === "string") {
      const r = fuzzyTenantMatch(t.name, tenantName);
      if (r === "exact_match") return true;
    }
  }
  return false;
}

async function applyClosure(
  tx: PrismaTransactionClient,
  args: {
    target_claim_id: string;
    reason_claim_id: string;
    close_mode: ClaimClosure["close_mode"];
    applied_valid_to: string;
  }
): Promise<string> {
  // valid_to is set for all close_modes; superseded_at + superseded_by_claim_id
  // are set only for close_overlapping_and_supersede_future per architecture
  // §5.5.3. close_overlapping_only sets only valid_to so the closed claim
  // remains visible to historical resolver queries with as_of_date < valid_to.
  // @tenant-isolation-disable-next-line -- reason: claim-store applier UPDATE warehouse.claims supersession columns, target claim already verified as property-scoped
  await tx.$executeRaw`
    UPDATE warehouse.claims
    SET valid_to = ${args.applied_valid_to}::date,
        superseded_at = CASE WHEN ${args.close_mode} = 'close_overlapping_and_supersede_future' THEN now() ELSE NULL END,
        superseded_by_claim_id = CASE WHEN ${args.close_mode} = 'close_overlapping_and_supersede_future' THEN ${args.reason_claim_id}::uuid ELSE NULL END
    WHERE id = ${args.target_claim_id}::uuid
  `;

  // @tenant-isolation-disable-next-line -- reason: claim-store applier INSERT into warehouse.claim_closures audit log, claim ids already verified as property-scoped
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.claim_closures (
      target_claim_id, reason_claim_id, close_mode, applied_valid_to, applier_version
    ) VALUES (
      ${args.target_claim_id}::uuid, ${args.reason_claim_id}::uuid,
      ${args.close_mode}, ${args.applied_valid_to}::date, ${APPLIER_VERSION}
    ) RETURNING id
  `;
  return rows[0].id;
}

async function writeDerivationRecord(
  tx: PrismaTransactionClient,
  args: {
    property_id: string;
    output_type: "claim" | "closure" | "resolved_fact" | "property_snapshot" | "derived_claim";
    output_id: string;
    input_claim_ids: string[];
    input_extraction_run_ids: string[];
    rule_refs: string[];
    emitter_version: string | null;
  }
): Promise<string> {
  // @tenant-isolation-disable-next-line -- reason: claim-store applier INSERT into warehouse.derivation_records, property_id verified at transaction start
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO warehouse.derivation_records (
      property_id, output_type, output_id,
      input_claim_ids, input_extraction_run_ids, rule_refs, emitter_version
    ) VALUES (
      ${args.property_id}::uuid, ${args.output_type}, ${args.output_id}::uuid,
      ${args.input_claim_ids}::uuid[], ${args.input_extraction_run_ids}::uuid[],
      ${args.rule_refs}::text[], ${args.emitter_version}
    ) RETURNING id
  `;
  return rows[0].id;
}

// === Claim-aware blocker checks (§5.5.5) ===================================

async function runBlockerChecks(
  tx: PrismaTransactionClient,
  intent: ClaimClosure,
  triggerClaim: Claim,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  switch (triggerClaim.predicate) {
    case "lease_terminated":
    case "tenant_moved_out":
      return await checkMultiTenantPartial(tx, intent, triggerClaim, context);
    case "ownership_transferred":
      return await checkVacantPossessionWarning(intent);
    case "kaltmiete_amended":
      return await checkStaffelmieteConflict(tx, intent, context);
    default:
      return null;
  }
}

async function checkMultiTenantPartial(
  tx: PrismaTransactionClient,
  intent: ClaimClosure,
  triggerClaim: Claim,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  // Find all currently-active tenant_active claims for the same (property, subject).
  // @tenant-isolation-disable-next-line -- reason: claim-store applier SELECT active tenant claims for multi-tenant blocker check, property scoped by context.property_id
  const activeTenantClaims = await tx.$queryRaw<{ value: Record<string, unknown> }[]>`
    SELECT value FROM warehouse.claims
    WHERE property_id = ${context.property_id}::uuid
      AND subject = ${intent.target_subject}
      AND predicate = 'tenant_active'
      AND valid_to IS NULL
      AND superseded_by_claim_id IS NULL
  `;

  // Extract distinct active tenant names from value.tenants[].name.
  const activeNames = new Set<string>();
  for (const row of activeTenantClaims) {
    if (Array.isArray(row.value?.tenants)) {
      for (const t of row.value.tenants) {
        if (typeof t?.name === "string") activeNames.add(t.name);
      }
    }
  }

  // Extract terminating parties from the trigger claim's value.terminating_parties[].
  const terminating: string[] = Array.isArray(triggerClaim.value?.terminating_parties)
    ? (triggerClaim.value.terminating_parties as Array<Record<string, unknown>>).map(p => p?.name).filter(Boolean) as string[]
    : [];

  if (activeNames.size === 0) {
    return null;
  }

  if (terminating.length === 0) {
    return {
      intent,
      reason: "multi_tenant_partial",
      detail: `Trigger event has no terminating_parties listed; cannot verify all ${activeNames.size} active tenants are terminating`,
    };
  }

  // For each active tenant, check that at least one terminating party matches via fuzzy match.
  const unmatchedActive: string[] = [];
  for (const activeName of activeNames) {
    const matched = terminating.some(
      tn => fuzzyTenantMatch(activeName, tn) === "exact_match"
    );
    if (!matched) unmatchedActive.push(activeName);
  }

  if (unmatchedActive.length > 0) {
    return {
      intent,
      reason: "multi_tenant_partial",
      detail: `Active tenants not in terminating parties: ${unmatchedActive.join(", ")}`,
    };
  }
  return null;
}

async function checkVacantPossessionWarning(
  intent: ClaimClosure,
): Promise<BlockedClosureIntent | null> {
  // Per §5.5.5: Eigentümerwechsel closures must never target tenant-related
  // predicates (Hofmann safeguard).
  const tenantPredicates = new Set([
    "tenant_active",
    "kaltmiete",
    "nebenkostenvorauszahlung",
    "kaution",
  ]);
  const closesTenantClaims = intent.target_predicates.some(p => tenantPredicates.has(p));
  if (closesTenantClaims) {
    return {
      intent,
      reason: "vacant_possession_warning",
      detail: "ownership_transferred closures must never target tenant-related predicates (Hofmann safeguard, §5.5.2)",
    };
  }
  return null;
}

async function checkStaffelmieteConflict(
  tx: PrismaTransactionClient,
  intent: ClaimClosure,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  // Per §5.5.5: if open future-dated kaltmiete claims exist for the same
  // (property, subject), the closure is requires_review.
  // @tenant-isolation-disable-next-line -- reason: claim-store applier SELECT future kaltmiete claims for Staffelmiete conflict check, property scoped by context.property_id
  const futureKaltmiete = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM warehouse.claims
    WHERE property_id = ${context.property_id}::uuid
      AND subject = ${intent.target_subject}
      AND predicate = 'kaltmiete'
      AND valid_from > ${intent.close_at}::date
      AND source_extraction_run_id != ${context.extraction_run_id}::uuid
      AND superseded_by_claim_id IS NULL
  `;
  if (futureKaltmiete.length > 0) {
    return {
      intent,
      reason: "staffelmiete_conflict",
      detail: `${futureKaltmiete.length} future-dated kaltmiete claim(s) exist for ${intent.target_subject} after ${intent.close_at}`,
    };
  }
  return null;
}
