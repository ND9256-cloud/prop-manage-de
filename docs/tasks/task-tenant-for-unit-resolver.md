# Task — tenantForUnit resolver returning ResolvedFact<Tenant>

## Why
Phase 4 (chat) needs to answer "who is the tenant of unit X". The presenter can name rent but not tenants. Tenant identity already lives in the claim store as tenant_active claims (everding confirms "Everding, Lena"). Build this now as the Phase 4 prerequisite, mirroring rent_for_unit exactly so provenance/supersession/conflict semantics are identical — and so it inherits the dedup fix just shipped.

## Source of truth (decision — do not deviate)
Resolve from warehouse.claims tenant_active claims, NOT from relational leases.mainTenant. The relational lease data is structural/onboarding truth (like Unit inventory); the current asserted fact "active tenant of unit X" comes from claims, exactly as rent does. Keeps the presenter purity boundary intact and reuses rent_for_unit conflict handling.

## Step 0 — verify before writing (do NOT guess)
1. Open the rent_for_unit resolver. Record: file path, the ResolvedFact<T> type + its location, exact status enum values, exact field names (value, status, confidence, source_claim_ids, conflicts, resolver.name), and the function signature (takes tx/prisma? property_id vs short_code? unit_ref format?). Mirror ALL of it.
2. Confirm tenant_active claim shape: the subject key (expected unit:<unitNumber> — confirm unit-scoped, not tenant-scoped), the predicate, and exactly what the value jsonb carries (name; and whether move-in date / tenant id are present). Return a Tenant built ONLY from fields the claim actually carries — invent nothing.
3. Confirm whether a Tenant type exists. If not, define a minimal one matching the claim value fields. Non-async types go in a sibling .types.ts, never a 'use server' file.
4. Confirm rent_for_unit's active-claim predicate (expected valid_to IS NULL AND superseded_by_claim_id IS NULL) and reuse it identically.
5. Check how everding-end-to-end.test.ts sets up and tears down (commit vs rollback, fresh ids). Mirror its safe pattern.

## Scope (do exactly this)
- Implement tenantForUnit in the same module/pattern as rent_for_unit, returning ResolvedFact<Tenant>. resolver.name = "tenant_for_unit".
- Query active tenant_active claims for the unit. Statuses mirror rent_for_unit exactly:
  - exactly one active claim -> single_active_claim (rent_for_unit's exact equivalent), value = Tenant from claim, source_claim_ids length 1, conflicts empty, confidence per claim.
  - zero active claims -> the same no-claim/vacant status rent_for_unit uses (phantom vacancy), value null, no error.
  - more than one active claim -> the same conflict status rent_for_unit uses; do NOT pick one; populate conflicts.
- Reuse rent_for_unit helpers/types; do not fork its logic.

## Out of scope (separate tasks — do NOT do here)
- Wiring into the composer rent-roll module or dashboard (next thin task; adds tenant name next to rent with full data-flow claim -> resolver -> module -> server action -> component).
- Any presenter or chat (Phase 4) change.
- Reading leases.mainTenant relationally.
- Migrations.

## Test (DoD includes this passing — run it, don't report it)
New src/tests/integration/tenant-for-unit.test.ts, modelled on everding-end-to-end, real Lena fixture, safe pattern (rollback transaction + fresh source_document_id if it writes claims):
- Positive: tenantForUnit(KO132, 1.OG) -> value name "Everding, Lena", status single_active_claim (rent_for_unit's exact value), source_claim_ids length 1, conflicts empty, resolver.name "tenant_for_unit".
- No-claim: a unit with no tenant_active claim (e.g. KO132 EG phantom vacancy) -> the no-claim/vacant status, value null, no throw.
- If feasible without contrivance, conflict: two active tenant_active claims for one unit -> conflict status, conflicts populated, no single value chosen.
- Load env via the same invocation everding uses.

## Definition of done
- Step 0 facts recorded in PR description (rent_for_unit signature/status enum mirrored; tenant_active subject + value fields; active-claim predicate).
- tsc clean, lint clean. Test passes when run.
- everding-end-to-end still green (no regression to shared resolver scaffolding).
- Single descriptive commit. Branch feature/tenant-for-unit-resolver off main after git pull.
- ARCHITECTURE_STATE.md updated (touches resolver layer).
- PR opened and verified on GitHub. CI green.

## Notes
Mirror rent_for_unit; this is a parallel resolver, not new infrastructure. The five real cases are the truth — if everding regresses, stop.
