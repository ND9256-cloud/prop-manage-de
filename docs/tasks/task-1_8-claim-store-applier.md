# Task 1.8 — Claim-store transaction applier

**Task type:** t2 L (logic + DB writes + tests, requires review before deploy)

**Branch:** `feature/task-1.8-claim-store-applier`

**Reference:**
- Architecture §4.6 (DerivationRecord)
- Architecture §5.5 (claim-store applier pattern, close_modes, safety rules, blockers, fuzzy tenant matching)
- `extraction-v2-implementation-plan.md` → Task 1.8 acceptance criteria
- `src/lib/emitters/types.ts` (Task 1.7) — `Claim`, `ClaimClosure`, `EmissionResult`, `EmitterContext`
- Phase 0 migration: `supabase/migrations/20260510080000_v2_claim_store.sql` — `warehouse.claims`, `warehouse.claim_closures`, `warehouse.derivation_records`

**Phase 1 success criterion this task moves toward:** `rent_for_unit("KO132","1.OG")` returns €650. Task 1.7 produces the EmissionResult; this task lands its claims in `warehouse.claims` so Task 1.10's resolver can read them.

---

## Scope

A function `applyEmission(emission, context) → ApplyResult` that:

1. Inserts each `Claim` from `emission.claims_to_insert` into `warehouse.claims`.
2. Applies each `ClaimClosure` from `emission.closure_intents` against existing open/future claims per its `close_mode`.
3. Validates closures against safety rules (architecture §5.5.4).
4. Runs claim-aware blocker checks (architecture §5.5.5).
5. Writes a `DerivationRecord` for every claim inserted and every closure applied.
6. Does all of the above in a single Postgres transaction. Any validation failure rolls back the whole batch.
7. Is idempotent: re-running the same EmissionResult produces no duplicate state.

For Mietvertrag (the only emitter that exists today): EmissionResult has 2-3 claims and 0 closure_intents. The applier inserts the claims, writes their DerivationRecords, and commits. No closure logic exercised, but the closure infrastructure must be in place — synthetic EmissionResult fixtures in tests exercise it.

Phase 1 doesn't need the applier wired into the pipeline (that's Task 1.9). This task ships the function plus tests; Task 1.9 imports it.

---

## Out of scope

- Wiring into the Edge Function — Task 1.9
- Other emitters (Mieterhöhung, Kündigung, Übergabeprotokoll) — separate tasks
- The `rent_for_unit` resolver — Task 1.10
- Unique-constraint migration on `warehouse.claims` — idempotency is applier-side via SELECT-before-INSERT (see Step 3); a DB-level unique constraint can be added in a future hardening task if pipeline concurrency ever becomes possible
- The closing-matrix consumer contract (CI test that every closing rule in a domain knowledge file has applier-side coverage) — separate task, after the second emitter type lands
- Tenant-isolation gate exemption decisions — applier uses raw SQL via Prisma `$transaction`; existing patterns and the tenant-isolation gate may flag this and require either an org-context wrapper or an explicit allowlist entry. Treat as a sub-task within Step 3 if the gate fails

---

## Files touched

- `src/lib/claim-store/applier.ts` — new, the transaction applier
- `src/lib/claim-store/fuzzy-tenant-match.ts` — new, pure name-matching function
- `src/lib/claim-store/types.ts` — new, `ApplyContext`, `ApplyResult`, `BlockerReason`
- `src/tests/claim-store/applier.test.ts` — new, ≥30 assertions across 8 scenarios
- `src/tests/claim-store/fuzzy-tenant-match.test.ts` — new, ≥12 assertions
- `ARCHITECTURE_STATE.md` — append a section for the claim-store applier

**NOT touched:**
- `src/lib/emitters/*` — no changes to the emitter contract
- `supabase/migrations/*` — no schema changes
- Edge Function — wiring is Task 1.9
- Any Prisma schema — `warehouse.*` tables are accessed via raw SQL only

---

## Repo conventions (recap)

- npm (not pnpm)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- DB access in tests: tests must use a dedicated test schema or a transaction-rollback pattern (see Step 4) — they must NOT leave residue in production tables
- Branch protection on `main` — feature branch + PR, never push to main
- Pipe potentially-paged commands through `| cat`
- Single descriptive commit per PR
- tsc clean, lint clean

---

## Step 1 — Shared types

Create `src/lib/claim-store/types.ts`:

```typescript
// Shared types for the claim-store transaction applier.

import type { Claim, ClaimClosure } from "../emitters/types.ts";

/**
 * Inputs the applier needs that aren't on the EmissionResult itself.
 *
 * - property_id: the property the emission is about; checked against org_id
 * - org_id: the organization the property belongs to; used as a tenant-isolation
 *   guard. The applier verifies property_id is in this org before any write.
 * - extraction_run_id: links the inserts to their source extraction. Null only
 *   when the EmissionResult comes from a human adjudication path (where claims
 *   have source_type="human_adjudication" and human_actor_id is set instead).
 * - emitter_version: written to DerivationRecord.emitter_version. Pass the
 *   `EMITTER_VERSION` constant exported by the emitter that produced the
 *   EmissionResult. Null for human adjudication.
 */
export interface ApplyContext {
  property_id: string;
  org_id: string;
  extraction_run_id: string | null;
  emitter_version: string | null;
}

/**
 * What the applier returns after committing.
 *
 * - inserted_claim_ids: ids of newly-inserted rows in warehouse.claims (skipped
 *   duplicates do NOT appear here; only fresh inserts).
 * - skipped_duplicate_claim_ids: ids of existing rows that the idempotency
 *   check matched (useful for logging "re-run was a no-op for these").
 * - applied_closure_ids: ids of newly-inserted rows in warehouse.claim_closures.
 * - blocked_closure_intents: closure intents that did not apply because a
 *   blocker check set requires_review or the emitter pre-set requires_review.
 *   The applier returns them so the caller can surface them in triage.
 * - derivation_record_ids: ids of newly-inserted rows in warehouse.derivation_records.
 */
export interface ApplyResult {
  inserted_claim_ids: string[];
  skipped_duplicate_claim_ids: string[];
  applied_closure_ids: string[];
  blocked_closure_intents: BlockedClosureIntent[];
  derivation_record_ids: string[];
}

/**
 * A closure intent that was not applied, with reason. The new event claim
 * is still inserted; only the closure is suspended.
 */
export interface BlockedClosureIntent {
  intent: ClaimClosure;
  reason: BlockerReason;
  detail: string;
}

export type BlockerReason =
  | "emitter_set_requires_review"
  | "multi_tenant_partial"
  | "vacant_possession_warning"
  | "staffelmiete_conflict"
  | "tenant_match_failed"
  | "predicate_not_in_allowlist";

export const APPLIER_VERSION = "1.0.0";
```

---

## Step 2 — Fuzzy tenant matching

Create `src/lib/claim-store/fuzzy-tenant-match.ts`. Pure function. Architecture §5.5.6.

```typescript
// Fuzzy tenant-name matching for closure intent verification.
//
// Architecture §5.5.6: token-subset match, no Levenshtein (false positives on
// short German names like Bauer/Baumer).
//
// Rules (in order):
//   1. Both names lowercased
//   2. Anrede (Herr, Frau, Dr.) stripped
//   3. Tokenize on whitespace + commas
//   4. If smaller token-set is a subset of larger → exact_match
//   5. If overlap but not subset → partial_match (caller decides whether to proceed)
//   6. No overlap → no_match
//
// Umlauts preserved (not transliterated). "Müller" ≠ "Mueller" by design — if
// extraction normalizes one way and the document writes another, that's a real
// ambiguity that should surface as partial_match.

const ANREDE = new Set(["herr", "frau", "dr", "prof", "dr.", "prof."]);

export type MatchResult = "exact_match" | "partial_match" | "no_match";

export function fuzzyTenantMatch(a: string, b: string): MatchResult {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) {
    return "no_match";
  }

  const [smaller, larger] = tokensA.size <= tokensB.size
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  let allInLarger = true;
  let anyInLarger = false;
  for (const t of smaller) {
    if (larger.has(t)) {
      anyInLarger = true;
    } else {
      allInLarger = false;
    }
  }

  if (allInLarger) return "exact_match";
  if (anyInLarger) return "partial_match";
  return "no_match";
}

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0 && !ANREDE.has(t))
  );
}
```

**Note on Anrede stripping:** This is deliberately small. If domain knowledge later wants broader Anrede coverage, the set moves to `domain_knowledge/_shared.md` front-matter and gets generated. For Task 1.8, hardcoded is acceptable — the architecture explicitly endorses a "deliberately simple" matcher.

---

## Step 3 — The applier

Create `src/lib/claim-store/applier.ts`.

Key design decisions:

1. **Raw SQL via Prisma `$queryRaw` / `$executeRaw` inside `prisma.$transaction(async tx => …)`.** The `warehouse.*` tables are not in the Prisma schema (intentional — they're append-only and Prisma's generated `update`/`delete` would attempt operations the triggers reject). Raw SQL keeps the contract with the migration tight.
2. **Idempotency via SELECT-before-INSERT** keyed on `(source_extraction_run_id, subject, predicate, source_field_path)`. Skipped duplicates are surfaced in `ApplyResult.skipped_duplicate_claim_ids`. For human_adjudication claims (where `source_extraction_run_id` is null), no idempotency check is run — the caller is responsible.
3. **Blocker dispatch by triggering event predicate.** Each EmissionResult that carries closure_intents must also carry exactly one `claim_kind: "event"` claim in `claims_to_insert`. The applier reads that event's `predicate` (e.g., `"lease_terminated"`, `"ownership_transferred"`, `"kaltmiete_amended"`) to decide which §5.5.5 blocker check to run. This avoids adding a `trigger_predicate` field to `ClaimClosure` and avoids string-matching `target_predicates`.
4. **Three `close_mode` paths use three explicit raw SQL queries.** No clever dispatch on a single query string — each mode's SQL is distinct enough that explicit-and-readable beats clever-and-shared.
5. **Org isolation via property_id → organizationId lookup** at the start of the transaction. Throws before any write if `property_id` is not in `context.org_id`.
6. **No predicate-pair allowlist enforcement in this task.** Architecture §5.5.4 says "Allowed predicate pairs ... is generated from domain knowledge front-matter." The generator and domain-knowledge consumer contract for closing matrices is a follow-up. For Task 1.8: applier accepts any predicate pair, with a TODO in code referencing the future allowlist. Test coverage explicitly notes this gap.

```typescript
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

import { prisma } from "@/lib/prisma";
import type { Claim, ClaimClosure, EmissionResult } from "../emitters/types.ts";
import type {
  ApplyContext,
  ApplyResult,
  BlockedClosureIntent,
  BlockerReason,
} from "./types.ts";
import { APPLIER_VERSION } from "./types.ts";
import { fuzzyTenantMatch } from "./fuzzy-tenant-match.ts";

/**
 * Apply an EmissionResult: insert claims, apply closures, write DerivationRecords.
 * One Postgres transaction. Rolls back on any safety failure.
 */
export async function applyEmission(
  emission: EmissionResult,
  context: ApplyContext
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

  return prisma.$transaction(async (tx) => {
    // --- Tenant-isolation guard --------------------------------------------
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

    // --- Insert claims (with idempotency) ----------------------------------
    const inserted_claim_ids: string[] = [];
    const skipped_duplicate_claim_ids: string[] = [];
    const derivation_record_ids: string[] = [];
    // Map: claim object → its DB id (used by event-claim dispatch later)
    const claimIdByObject = new Map<Claim, string>();

    for (const claim of emission.claims_to_insert) {
      const existingId = await findExistingClaim(tx, claim);
      if (existingId) {
        skipped_duplicate_claim_ids.push(existingId);
        claimIdByObject.set(claim, existingId);
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
    }

    // --- Apply closures ---------------------------------------------------
    const applied_closure_ids: string[] = [];
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
      const targetClaimIds = await findClaimsToClose(tx, intent, context.property_id);

      for (const targetClaimId of targetClaimIds) {
        // Safety: no retroactive reach into already-superseded history.
        const target = await tx.$queryRaw<
          { valid_to: Date | null; superseded_by_claim_id: string | null }[]
        >`
          SELECT valid_to, superseded_by_claim_id
          FROM warehouse.claims WHERE id = ${targetClaimId}::uuid
        `;
        if (target.length === 0) continue;
        if (target[0].superseded_by_claim_id !== null) {
          // Cannot reach into already-superseded chain.
          continue;
        }

        const closureId = await applyClosure(tx, {
          target_claim_id: targetClaimId,
          reason_claim_id: triggerClaimId!,
          close_mode: intent.close_mode,
          applied_valid_to: intent.close_at,
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
  });
}

// === Helpers (within same file or split into private modules) ==============

async function findExistingClaim(tx: any, claim: Claim): Promise<string | null> {
  if (!claim.source_extraction_run_id) return null; // human_adjudication: no idempotency check
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM warehouse.claims
    WHERE source_extraction_run_id = ${claim.source_extraction_run_id}::uuid
      AND subject = ${claim.subject}
      AND predicate = ${claim.predicate}
      AND source_field_path = ${claim.source_field_path}
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

async function insertClaim(tx: any, claim: Claim): Promise<string> {
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
      ${claim.source_extraction_run_id}::uuid,
      ${claim.source_field_path},
      ${claim.human_actor_id}::uuid, ${claim.confidence},
      ${claim.evidence_id}::uuid
    ) RETURNING id
  `;
  return rows[0].id;
}

async function findClaimsToClose(
  tx: any,
  intent: ClaimClosure,
  property_id: string
): Promise<string[]> {
  const predicates = intent.target_predicates;
  const subject = intent.target_subject;
  const closeAt = intent.close_at;

  // Three close_modes → three SQL patterns.
  let rows: { id: string; value: any }[];
  if (intent.close_mode === "close_overlapping_only") {
    rows = await tx.$queryRaw<{ id: string; value: any }[]>`
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
    rows = await tx.$queryRaw<{ id: string; value: any }[]>`
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

function valueHasTenantMatch(value: any, tenantName: string): boolean {
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
  tx: any,
  args: {
    target_claim_id: string;
    reason_claim_id: string;
    close_mode: ClaimClosure["close_mode"];
    applied_valid_to: string;
  }
): Promise<string> {
  // For close_overlapping_and_supersede_future, set both valid_to AND
  // superseded_by_claim_id. For the others, just valid_to.
  if (args.close_mode === "close_overlapping_and_supersede_future") {
    await tx.$executeRaw`
      UPDATE warehouse.claims
      SET valid_to = ${args.applied_valid_to}::date,
          superseded_at = now(),
          superseded_by_claim_id = ${args.reason_claim_id}::uuid
      WHERE id = ${args.target_claim_id}::uuid
    `;
  } else {
    await tx.$executeRaw`
      UPDATE warehouse.claims
      SET valid_to = ${args.applied_valid_to}::date,
          superseded_at = now(),
          superseded_by_claim_id = ${args.reason_claim_id}::uuid
      WHERE id = ${args.target_claim_id}::uuid
    `;
  }
  // Note: for close_overlapping_only and close_overlapping_and_future, the
  // architecture also says superseded_by_claim_id is set (the claim is closed
  // by a specific event). The trigger function allows the three supersession
  // columns to be set together. Setting all three uniformly for all close_modes
  // simplifies the model and matches the migration's intent.

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
  tx: any,
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
  tx: any,
  intent: ClaimClosure,
  triggerClaim: Claim,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  switch (triggerClaim.predicate) {
    case "lease_terminated":
    case "tenant_moved_out":
      return await checkMultiTenantPartial(tx, intent, triggerClaim, context);
    case "ownership_transferred":
      return await checkVacantPossessionWarning(tx, intent, triggerClaim);
    case "kaltmiete_amended":
      return await checkStaffelmieteConflict(tx, intent, context);
    default:
      return null;
  }
}

async function checkMultiTenantPartial(
  tx: any,
  intent: ClaimClosure,
  triggerClaim: Claim,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  // Find all currently-active tenant_active claims for the same (property, subject).
  const activeTenantClaims = await tx.$queryRaw<{ value: any }[]>`
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
  // (Schema for Kündigung's lease_terminated claim is defined by the future
  // kuendigung emitter; tests provide synthetic claims with this shape.)
  const terminating: string[] = Array.isArray(triggerClaim.value?.terminating_parties)
    ? (triggerClaim.value.terminating_parties as any[]).map(p => p?.name).filter(Boolean)
    : [];

  if (activeNames.size === 0) {
    // No active tenants to close — closure is a no-op, no blocker needed.
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
  tx: any,
  intent: ClaimClosure,
  triggerClaim: Claim
): Promise<BlockedClosureIntent | null> {
  // Per §5.5.5: Eigentümerwechsel emits an occupancy_conflict WARNING but still
  // applies the owner closure normally. Vacant-possession language NEVER causes
  // tenant-claim closure (Hofmann safeguard).
  //
  // For Task 1.8, "occupancy_conflict warning event" surfacing is a TODO — we
  // record the warning via the BlockedClosureIntent only if the intent is
  // attempting to close tenant claims (which it should never do for an
  // ownership-transfer event; that's the architectural safeguard).
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
  tx: any,
  intent: ClaimClosure,
  context: ApplyContext
): Promise<BlockedClosureIntent | null> {
  // Per §5.5.5: if open future-dated kaltmiete claims exist for the same
  // (property, subject), the closure is requires_review.
  const futureKaltmiete = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM warehouse.claims
    WHERE property_id = ${context.property_id}::uuid
      AND subject = ${intent.target_subject}
      AND predicate = 'kaltmiete'
      AND valid_from > ${intent.close_at}::date
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
```

**TODO comments to include in the code** (these are deferred to follow-up tasks, not Task 1.8 scope):

```typescript
// TODO(closing-matrix-allowlist): enforce predicate-pair allowlist from
// domain knowledge front-matter (§5.5.4). Currently the applier accepts any
// (event_predicate, target_predicate) pair. The closing-matrix consumer
// contract is a separate task after the second emitter type ships.

// TODO(optional-match-confidence-downgrade): when intent.match_strictness =
// "optional" and fuzzy match fails, downgrade the closure's confidence rather
// than ignoring the match. Currently optional == always proceed. Architecture
// §5.5.4 wording allows either interpretation; clarify before second emitter.
```

---

## Step 4 — Tests

Tests use a transaction-rollback pattern: each test wraps its applier call in `prisma.$transaction(async tx => { ... throw "rollback"; })` so nothing persists. The applier itself doesn't have to know — it uses `prisma.$transaction` internally; tests need to ensure their changes are rolled back at the outer level.

A simpler alternative: run tests against a per-test schema or a dedicated `test_*` Property row, and explicitly delete inserted rows in a `finally` block (the immutability triggers do NOT block DELETE in this case because the test rows are in a test schema OR the test bypasses triggers by using a privileged role).

**The choice**: tests run against the real `warehouse.*` tables BUT use a dedicated test property whose `organizationId` is unique to the test environment (constant `TEST_ORG_ID` in `.env.test`). After all tests in the file run, a teardown step deletes all `warehouse.claims`, `warehouse.claim_closures`, `warehouse.derivation_records` rows for that test property — using a direct SQL `DELETE` that the triggers will block.

**Therefore**: the triggers prevent test cleanup. The test plan needs a way around this. Two options:

- **Option A (safer): introduce a `--allow-test-cleanup` superuser RPC** that disables the trigger temporarily, deletes, re-enables. New migration. Out of Task 1.8 scope as stated.
- **Option B (lighter): use a dedicated test schema (`warehouse_test.*`) created in the test setup, dropped in teardown.** Requires duplicating the migration into a test variant. Slow.
- **Option C (pragmatic for Task 1.8): use `prisma.$transaction` with `tx.$queryRaw` ... and at the end of each test, throw inside the transaction to force rollback.** Works because all writes happen inside `applier`'s own `prisma.$transaction`, which the test's outer transaction wraps (Postgres supports nested transactions via savepoints when run inside an interactive transaction).

Actually, Prisma doesn't truly support nested transactions; the inner `$transaction` would commit or fail independently. So **Option C does not work as written**.

**Resolution**: refactor `applyEmission` to optionally accept a `tx` parameter. When a `tx` is passed, applier uses it instead of opening a new transaction. Tests pass their own `tx` (held open by the test framework) and roll back manually. Production callers (Task 1.9) call with no `tx` and the applier opens its own.

Adjust the signature:

```typescript
export async function applyEmission(
  emission: EmissionResult,
  context: ApplyContext,
  opts?: { tx?: PrismaTransactionClient }
): Promise<ApplyResult>
```

Where `PrismaTransactionClient` is the type Prisma uses for `tx` inside `$transaction(async (tx) => …)`. Refactor the body to use `const db = opts?.tx ?? prisma;` and skip the outer `$transaction` wrapper when `opts.tx` is provided.

Now tests can do:

```typescript
await prisma.$transaction(async (tx) => {
  await applyEmission(emission, context, { tx });
  // ... assertions ...
  throw new Error("rollback"); // force rollback
}).catch(e => { if (e.message !== "rollback") throw e; });
```

Test fixtures: a constant test `Property` row with a known `id` and `organizationId`. Seeded once in a test bootstrap (or assumed to exist; verified at test start).

### Test scenarios

Create `src/tests/claim-store/applier.test.ts` covering at minimum:

**Scenario 1 — Mietvertrag happy path (real Task 1.7 EmissionResult):**
1. EmissionResult with 2 claims (kaltmiete + tenant_active), 0 closure_intents → 2 claims inserted, 0 closures, 2 DerivationRecords
2. Inserted kaltmiete claim has correct subject/predicate/value/valid_from/valid_to in DB
3. Inserted tenant_active claim has `value.tenants[0].name = "Everding, Lena"`
4. Each DerivationRecord has `output_type="claim"`, `input_extraction_run_ids = [extraction_run_id]`, `emitter_version = "1.0.0"` (or whatever the Mietvertrag emitter exports)
5. Re-running the same EmissionResult inserts 0 new claims, returns 2 ids in `skipped_duplicate_claim_ids`

**Scenario 2 — Cross-property rejection:**
6. Claim with property_id ≠ context.property_id throws BEFORE any insert (no claims, no DerivationRecords created)
7. Property_id not in context.org_id throws (verify via separate test org)

**Scenario 3 — Mieterhöhung synthetic EmissionResult (close_overlapping_only):**
8. Setup: insert a Mietvertrag base kaltmiete claim (Lena fixture).
9. Apply a synthetic Mieterhöhung EmissionResult: 1 new kaltmiete event claim, 1 closure_intent with `close_mode: "close_overlapping_only"`, target_predicates: ["kaltmiete"], target_subject: "unit:1.OG", close_at: "2026-01-01".
10. Result: previous kaltmiete claim has `valid_to: "2026-01-01"` and `superseded_by_claim_id` set to new event claim's id.
11. claim_closures has 1 row with `close_mode: "close_overlapping_only"`.
12. DerivationRecord for the closure has `output_type: "closure"`, `input_claim_ids: [trigger_id, target_id]`.

**Scenario 4 — Mieterhöhung mid-Staffelmiete (Staffelmiete conflict blocker):**
13. Setup: insert base kaltmiete + a future-dated kaltmiete claim (synthetic Staffelmiete entry, valid_from > Mieterhöhung close_at).
14. Apply same Mieterhöhung EmissionResult as Scenario 3.
15. Result: new kaltmiete event claim inserted; previous base kaltmiete is NOT closed; `blocked_closure_intents` contains 1 entry with `reason: "staffelmiete_conflict"`.

**Scenario 5 — Kündigung synthetic EmissionResult (close_overlapping_and_future):**
16. Setup: insert base kaltmiete + future Mieterhöhung kaltmiete (valid_from > Kündigung close_at) + tenant_active for the same unit/tenant.
17. Apply synthetic Kündigung EmissionResult: 1 lease_terminated event claim with `value.terminating_parties: [{name: "Everding, Lena"}]`, 1 closure_intent with `close_mode: "close_overlapping_and_future"`, target_predicates: ["kaltmiete", "tenant_active"], target_subject: "unit:1.OG", close_at: "2026-06-30", match: { tenant_identity: "Everding, Lena" }, match_strictness: "required".
18. Result: BOTH base AND future Mieterhöhung kaltmiete claims closed (valid_to = 2026-06-30); tenant_active claim closed; 3 claim_closures rows.

**Scenario 6 — Multi-tenant partial Kündigung (blocker):**
19. Setup: insert two tenant_active claims for the same unit (synthetic Mietgemeinschaft), one with `value.tenants = [{name: "Müller, Max"}]` and one with `[{name: "Schmidt, Anna"}]`.
20. Apply Kündigung EmissionResult with `terminating_parties: [{name: "Max Müller"}]` (only one tenant terminating).
21. Result: lease_terminated event claim inserted; `blocked_closure_intents` contains entry with `reason: "multi_tenant_partial"`, detail mentions "Schmidt, Anna"; no claim_closures rows.

**Scenario 7 — Eigentümerwechsel safeguard (Hofmann):**
22. Setup: insert base kaltmiete + tenant_active claims for unit:EG.
23. Apply synthetic Eigentümerwechsel EmissionResult with a malicious closure_intent: `target_predicates: ["tenant_active", "kaltmiete"]`, `close_mode: "close_overlapping_and_supersede_future"`.
24. Result: `blocked_closure_intents` contains entry with `reason: "vacant_possession_warning"`; tenant_active claim NOT closed; kaltmiete NOT closed. (The owner closure itself would have been applied if the intent targeted "owner"; in this test we deliberately try to close tenant-claims to verify the safeguard.)

**Scenario 8 — Human adjudication path:**
25. Apply an EmissionResult with `source_type: "human_adjudication"`, `human_actor_id: <user uuid>`, `source_extraction_run_id: null`. Context has `extraction_run_id: null`, `emitter_version: null`.
26. Result: claim inserted with correct source_type and human_actor_id. No idempotency check skipping (because source_extraction_run_id is null). DerivationRecord has `input_extraction_run_ids: []`, `emitter_version: null`.

**Scenario 9 — Already-superseded claim is not re-closed:**
27. Setup: insert and close a kaltmiete claim (manually set superseded_by_claim_id via test helper that uses service_role bypass).
28. Apply a new Mieterhöhung intent that targets the same claim.
29. Result: applier finds the claim via SELECT (no superseded_by filter on close-candidates initially — but the safety check inside the apply loop filters it out). No new closure for the already-superseded row.

Plus tests for the fuzzy-tenant-match function in `src/tests/claim-store/fuzzy-tenant-match.test.ts`:

**Fuzzy match tests:**
30. `fuzzyTenantMatch("Max Müller", "Müller, Max")` → `"exact_match"`
31. `fuzzyTenantMatch("Müller, Max", "Max Heinrich Müller")` → `"exact_match"` (Max + Müller subset of Max + Heinrich + Müller)
32. `fuzzyTenantMatch("Bauer", "Baumer")` → `"no_match"`
33. `fuzzyTenantMatch("Herr Dr. Max Müller", "Max Müller")` → `"exact_match"` (Anrede stripped)
34. `fuzzyTenantMatch("Frau Anna Schmidt", "Schmidt, Anna")` → `"exact_match"`
35. `fuzzyTenantMatch("Max Müller", "Anna Müller")` → `"partial_match"` (Müller overlaps; Max ≠ Anna)
36. `fuzzyTenantMatch("Müller", "Mueller")` → `"no_match"` (umlauts preserved)
37. `fuzzyTenantMatch("", "Max Müller")` → `"no_match"` (empty)
38. `fuzzyTenantMatch("Max Müller", "")` → `"no_match"`
39. `fuzzyTenantMatch("max müller", "Max Müller")` → `"exact_match"` (case-insensitive)
40. `fuzzyTenantMatch("Schmidt, Anna", "Schmitt, Anna")` → `"partial_match"` (Anna matches, Schmidt ≠ Schmitt — token-subset says one common token = partial)
41. `fuzzyTenantMatch("Dr. Prof. Max Müller", "Max Müller")` → `"exact_match"` (multiple Anrede stripped)

**Total: ≥30 assertions in applier.test.ts, ≥12 in fuzzy-tenant-match.test.ts.**

### Test setup details

`src/tests/claim-store/applier.test.ts` imports:

```typescript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { applyEmission } from "@/lib/claim-store/applier";
import type { EmissionResult, Claim, ClaimClosure } from "@/lib/emitters/types";
import type { ApplyContext } from "@/lib/claim-store/types";
```

Helper to build test EmissionResults inline. Helper to insert a "seed" claim (used as `INSERT INTO warehouse.claims (...)` directly from the test). Helper to assert claim state in the DB.

A dedicated `TEST_ORG_ID` and `TEST_PROPERTY_ID` are read from env (`.env.test` or fall back to `.env.local`). Test bootstrap verifies these rows exist in the DB before running.

---

## Step 5 — ARCHITECTURE_STATE.md update

Append:

```markdown
## Claim-store transaction applier (Task 1.8+)

Single writer to `warehouse.claims`, `warehouse.claim_closures`, and
`warehouse.derivation_records` in normal pipeline operation. Architecture §5.5.

**Shipped:**
- `src/lib/claim-store/applier.ts` (Task 1.8, 2026-05-22) — `applyEmission`
  function. All three close_modes implemented. Three claim-aware blocker
  checks (multi-tenant partial, vacant-possession safeguard, Staffelmiete
  conflict). Fuzzy tenant matching for closure verification. DerivationRecord
  per insert and per closure. Transaction-wrapped; rollback on any safety
  failure. Idempotent via SELECT-before-INSERT on `(source_extraction_run_id,
  subject, predicate, source_field_path)`.
- `src/lib/claim-store/fuzzy-tenant-match.ts` — pure token-subset matcher,
  Anrede-stripped, no Levenshtein. ≥12 unit tests.

**Pending (separate tasks):**
- Closing-matrix predicate-pair allowlist enforcement (TODO in applier.ts) —
  blocks on the second emitter type landing
- Optional-match confidence downgrade (TODO in applier.ts)
- Test-environment trigger bypass for cleanup — currently tests use
  transaction rollback via passed-in `tx`; production pipeline call (Task 1.9)
  opens its own transaction

**Wire-up:** Task 1.9 calls `applyEmission` from the Edge Function after
Step 8b writes the v2 envelope and the appropriate emitter produces an
EmissionResult.
```

---

## Step 6 — Verify

```bash
cd ~/repos/property-management-saas
npx tsc --noEmit | cat
npx tsx -r dotenv/config src/tests/claim-store/fuzzy-tenant-match.test.ts | cat
npx tsx -r dotenv/config src/tests/claim-store/applier.test.ts | cat
```

Both test files should report assertion counts and OK. tsc must be clean.

Then run the full existing suite:

```bash
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && npx tsx -r dotenv/config "$f" | tail -3 || break
done
```

All existing tests still green, 2 new ones added.

---

## Step 7 — PR

```bash
git checkout -b feature/task-1.8-claim-store-applier
git add src/lib/claim-store/applier.ts \
        src/lib/claim-store/fuzzy-tenant-match.ts \
        src/lib/claim-store/types.ts \
        src/tests/claim-store/applier.test.ts \
        src/tests/claim-store/fuzzy-tenant-match.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "feat(claim-store): add transaction applier with closure handling (Task 1.8)

- src/lib/claim-store/applier.ts: applyEmission function, single Postgres
  transaction, three close_modes, three claim-aware blocker checks, fuzzy
  tenant matching for closure verification, DerivationRecord per output,
  idempotent via SELECT-before-INSERT
- src/lib/claim-store/fuzzy-tenant-match.ts: pure token-subset matcher,
  Anrede-stripped, no Levenshtein
- src/lib/claim-store/types.ts: ApplyContext, ApplyResult, BlockerReason
- src/tests/claim-store/applier.test.ts: 9 scenarios, ≥30 assertions
- src/tests/claim-store/fuzzy-tenant-match.test.ts: ≥12 German-name fixtures

Architecture §5.5. Not yet wired into the pipeline — Task 1.9 does that."
git push -u origin feature/task-1.8-claim-store-applier
gh pr create --fill | cat
```

Wait for CI. All checks green → merge.

---

## Definition of done

- [ ] Branch pushed, PR opened
- [ ] CI green (existing + 2 new test files + tenant-isolation gate + migration-drift gate + ARCHITECTURE_STATE gate)
- [ ] `npx tsc --noEmit` silent
- [ ] `applier.test.ts` reports ≥30 assertions across 9 scenarios, all OK
- [ ] `fuzzy-tenant-match.test.ts` reports ≥12 assertions, all OK
- [ ] ARCHITECTURE_STATE.md section added
- [ ] Single descriptive commit, PR merged into main
- [ ] No production-table residue from test runs (rollback-via-tx pattern verified)

---

## Notes for reviewer

**Idempotency is applier-side, not DB-side.** I deliberately did not add a unique constraint to `warehouse.claims`. The `(source_extraction_run_id, subject, predicate, source_field_path)` tuple is a natural key for document-extraction claims, but human_adjudication claims have null `source_extraction_run_id` and the constraint would have to be partial. A SELECT-before-INSERT is more explicit, debuggable, and doesn't require a new migration. The trade-off is a small race window if two appliers ever run concurrently for the same extraction — but the pipeline doesn't do that today, and Task 1.9's wire-up is single-threaded per document.

**Blocker dispatch keys on the triggering event claim's `predicate`.** The architecture's §5.5.5 wording ("for Kündigung-triggered closures") doesn't specify a mechanism. I chose to require exactly-one `claim_kind: "event"` claim in `claims_to_insert` when `closure_intents` is non-empty, and dispatch on that claim's `predicate`. This avoids adding a `trigger_predicate` field to `ClaimClosure` (which would have required reopening Task 1.7's types). If a future emitter needs multiple event claims per closure batch, the dispatch logic generalizes by carrying `trigger_event_predicate` on each closure_intent.

**The Eigentümerwechsel safeguard is enforced both ways.** Architecture §5.5.2 says `ownership_transferred` rejects EmissionResults that close tenant claims, AND §5.5.5 says vacant-possession language emits a warning but still applies the owner closure. I implemented the safeguard via `checkVacantPossessionWarning` returning a `BlockedClosureIntent` only when the intent targets tenant-related predicates. The owner closure (target_predicate: "owner") proceeds normally; the safeguard fires only on the misuse case. The "occupancy_conflict warning event" mentioned in §5.5.5 is a future event-claim type — for Task 1.8, the warning surfaces via `blocked_closure_intents` instead of being its own claim. Acceptable for Phase 1; revisit when the Eigentümerwechsel emitter lands.

**Test cleanup uses passed-in `tx` for rollback.** Because `warehouse.claims` blocks DELETE via trigger (GoBD), tests can't cleanup with DELETE. The applier accepts an optional `tx` parameter so tests can wrap calls in their own transaction and throw to rollback. Production callers (Task 1.9) call with no `tx` and the applier opens its own. This is a small contract addition to `applyEmission` for testability; it does not change the production code path.

**Closing-matrix predicate-pair allowlist is a TODO.** §5.5.4 specifies "a closure's `target_predicate` must be in an allowlist for the triggering event predicate." That allowlist comes from domain knowledge front-matter, which isn't a consumer-contract gate yet. For Task 1.8, the applier accepts any predicate pair; the safety rule is implemented as a TODO with reference to the future closing-matrix consumer task. The Eigentümerwechsel→tenant-claims rejection is the most important case and is hardcoded in `checkVacantPossessionWarning` rather than waiting for the allowlist generator.

**Mietvertrag emits zero closures.** Most of the closure code in this task is exercised only by synthetic EmissionResult fixtures, not by the live Mietvertrag emitter. This is intentional: Task 1.8 builds the closure infrastructure so that Tasks 2.x (Mieterhöhung, Kündigung, Übergabeprotokoll emitters) can light it up without further applier changes. The synthetic fixtures cover all three close_modes, all three blocker types, and the Hofmann safeguard.
