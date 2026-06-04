# Task 1.10 — `rent_for_unit` resolver

**Task type:** t2 M (logic + DB reads + 1 DB write per call + tests, requires review before merge)

**Branch:** `feature/task-1.10-rent-for-unit-resolver`

**Reference:**
- Architecture §5.1 (resolvers in general, `ResolvedFact` shape)
- Architecture §5.2 (rent_for_unit algorithm, walkthrough of all 5 KO132/HHS55 cases, edge cases)
- Architecture §5.3 (resolver-as-dumping-ground discipline + CI purity gate)
- Architecture §4.6 (DerivationRecord write per resolution call)
- `extraction-v2-implementation-plan.md` → Task 1.10 acceptance criteria
- Existing patterns: `src/lib/claim-store/applier.ts` (raw SQL via Prisma in `warehouse.*`, tenant-isolation annotations), `src/tests/emitter-purity.test.ts` (CI purity gate template)

**Phase 1 success criterion this task delivers:** `rentForUnit({ property_id: KO132, unit_ref: "1.OG" })` returns `value = { amount: 65000, currency: "EUR" }`, `confidence = "high"`, `status = "single_active_claim"`. The claim is already live in `warehouse.claims` for KO132/1.OG/Lena Everding (Task 1.9 verified end-to-end). This task lights up the read path.

---

## Scope

A pure function `rentForUnit({ property_id, unit_ref, as_of_date?, org_id }) → Promise<ResolvedFact<Money>>` that:

1. Queries `warehouse.claims` for active kaltmiete claims matching the input.
2. Applies the resolution algorithm exactly per architecture §5.2.
3. Writes a `DerivationRecord` for this resolution call (output_type: `"resolved_fact"`).
4. Returns a `ResolvedFact<Money>` with full provenance.
5. Is **pure with respect to extraction concerns**: it MUST NOT import any LLM client, prompt module, emitter module, or extraction module. CI test enforces this.

The function takes `org_id` as an explicit parameter and uses it to scope the DerivationRecord write. The `warehouse.claims` read query joins through `Property` to enforce org isolation (same pattern as Task 1.8's applier).

---

## Out of scope

- Other resolvers (`owner_of_property`, `active_insurance_for_property`, etc.) — separate tasks per the architecture's template-then-replicate pattern
- Wiring the resolver into UI or any API endpoint — Task 1.11 and beyond
- Mieterhöhung handling — the test suite covers it with synthetic multi-claim fixtures, but the live Mieterhöhung emitter is a Phase 2 task. The resolver MUST correctly handle the multi-claim case today regardless
- Caching, memoization, or any performance optimization — the DR write per call is fine for Phase 1; revisit when query volume forces it
- Conflict resolution UI surfacing — the resolver returns conflicts in the result, but rendering them is a UI task

---

## Files touched

- `src/lib/resolvers/types.ts` — new, shared resolver types (`ResolvedFact`, `Money`, `Conflict`, `ResolutionStatus`, `RESOLVER_VERSION` constant)
- `src/lib/resolvers/rent-for-unit.ts` — new, the resolver
- `src/tests/resolvers/rent-for-unit.test.ts` — new, ≥25 assertions across 6 scenarios (Lena single-claim + Paul/Kuru/Weber Mieterhöhung pattern + Hofmann + zero-claim + multi-claim conflict)
- `src/tests/resolvers/resolver-purity.test.ts` — new, CI purity gate (no LLM/prompt/extraction imports)
- `tenant-isolation-exceptions.md` — auto-regenerated to include resolver annotations
- `ARCHITECTURE_STATE.md` — append a section for the resolver layer

**NOT touched:**
- Existing emitter files
- Existing applier files
- DB schema — no migrations
- Edge Function — resolver is Node-only, no Deno bridge

---

## Repo conventions (recap)

- npm (not pnpm), tsc clean, lint clean
- Tests run via `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>` (Task 1.8 lesson)
- Branch protection on main, feature branch + PR
- Single descriptive commit per PR
- Pipe potentially-paged commands through `| cat`
- `warehouse.*` queries use raw SQL via Prisma with `@tenant-isolation-disable-next-line` annotations (auto-regenerated into `tenant-isolation-exceptions.md`)

---

## Step 1 — Shared resolver types

Create `src/lib/resolvers/types.ts`:

```typescript
// Shared types for resolvers. Architecture §5.1.
//
// A resolver is a pure function that answers exactly one question by querying
// the claim store. It returns a ResolvedFact with full provenance so the
// caller (UI, agent, downstream resolver) can trust or audit the answer.

export type ResolverConfidence = "high" | "medium" | "low";

/**
 * Status of a resolution call. Maps directly to the resolution_rule_applied
 * field from architecture §5.2.
 *
 * - single_active_claim: exactly one claim matched the query (the simple case)
 * - latest_active_claim_with_conflicts: multiple claims matched; we picked the
 *   latest by (valid_from desc, created_at desc); others are in `conflicts`
 * - no_active_claim: zero claims matched; value is null
 * - no_claim_for_date: zero claims matched because as_of_date was before any
 *   claim's valid_from (distinct from no_active_claim for diagnostic clarity)
 */
export type ResolutionStatus =
  | "single_active_claim"
  | "latest_active_claim_with_conflicts"
  | "no_active_claim"
  | "no_claim_for_date";

export interface Money {
  amount: number; // minor units (cents for EUR)
  currency: string; // ISO 4217, e.g. "EUR"
}

export interface Conflict {
  claim_id: string;
  reason: "superseded_by_later_claim";
  value: unknown;
  valid_from: string; // ISO date
}

/**
 * The return shape of every resolver. Architecture §5.1.
 *
 * Generic over the value type so different resolvers return typed values
 * (Money for rent, string for tenant name, etc.).
 *
 * - query: the inputs that produced this result, for caching and audit
 * - value: the resolved value, or null if no claim matched
 * - confidence: derived from the winning claim's confidence, downgraded one
 *   step if any conflicts were present
 * - status: see ResolutionStatus
 * - source_claim_ids: the claim(s) that contributed to this result. For
 *   single_active_claim, exactly one id. For conflicts case, the winner first.
 * - source_document_ids: the documents those claims came from
 * - conflicts: empty array unless status = latest_active_claim_with_conflicts
 * - derivation_record_id: the DR row this call wrote, for audit linking
 * - resolver: name + version of the resolver that produced this fact
 * - generated_at: timestamp at end of resolution
 */
export interface ResolvedFact<TValue> {
  query: Record<string, unknown>;
  value: TValue | null;
  confidence: ResolverConfidence;
  status: ResolutionStatus;
  source_claim_ids: string[];
  source_document_ids: string[];
  conflicts: Conflict[];
  derivation_record_id: string | null;
  resolver: { name: string; version: string };
  generated_at: string;
}

/**
 * Downgrade confidence by one step. high → medium → low → low (floor).
 * Used when conflicts are present per §5.2 step 5.
 */
export function downgradeConfidence(c: ResolverConfidence): ResolverConfidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}
```

---

## Step 2 — The resolver

Create `src/lib/resolvers/rent-for-unit.ts`.

Key design decisions:

1. **Raw SQL via Prisma `$queryRaw`** — same pattern as Task 1.8 applier. `warehouse.claims` is not in Prisma schema (intentional, append-only). Two queries: claims, then DR insert. The DR insert is best-effort — if it fails (e.g., transient DB blip), we log and still return the resolved value with `derivation_record_id: null`. Resolution must not be blocked by audit-trail write failures.
2. **Org isolation via JOIN to Property** — `warehouse.claims.property_id` references `Property.id`. The query joins `Property` and filters by `organizationId = $org_id`. This prevents cross-tenant reads even if `property_id` is leaked or spoofed by the caller.
3. **Subject string construction** — claim rows have `subject = "unit:1.OG"`. Resolver takes `unit_ref = "1.OG"` and constructs the subject by prefixing `"unit:"`. If `unit_ref` already starts with `"unit:"`, do NOT double-prefix (defensive — should never happen given the input contract, but cheap to guard).
4. **`as_of_date` default** — today, in UTC, as a date string (YYYY-MM-DD). Pass it as a `Date` and serialize at query time. Default is `new Date()`.
5. **Sort tiebreak** — §5.2 says `(valid_from DESC, created_at DESC)`. Implemented in SQL ORDER BY for stability.
6. **Confidence in conflict case** — winner's confidence downgraded by `downgradeConfidence()` per §5.2 step 5.
7. **DR write** — `output_type = "resolved_fact"`, `output_id = <freshly-generated uuid>` (the resolved fact isn't persisted, but it gets a UUID so the DR row has something to reference), `input_claim_ids = [winner_id, ...conflict_ids]`, `input_extraction_run_ids = []` (resolvers don't read envelopes), `rule_refs = ["§5.2"]`, `resolver_version = RESOLVER_VERSION`.

```typescript
// src/lib/resolvers/rent-for-unit.ts
//
// rent_for_unit resolver. Architecture §5.1 + §5.2.
//
// Pure with respect to extraction: no LLM client, no prompt module, no emitter,
// no extraction module imports. CI gate (resolver-purity.test.ts) enforces this.
//
// Pure with respect to state: reads warehouse.claims (filtered by org_id),
// optionally writes one warehouse.derivation_records row for audit. No other
// side effects.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type {
  ResolvedFact,
  ResolverConfidence,
  Conflict,
  Money,
  ResolutionStatus,
} from "./types";
import { downgradeConfidence } from "./types";

export const RESOLVER_NAME = "rent_for_unit";
export const RESOLVER_VERSION = "1.0.0";

export interface RentForUnitArgs {
  property_id: string;
  unit_ref: string;
  as_of_date?: Date;
  org_id: string;
}

export async function rentForUnit(
  args: RentForUnitArgs
): Promise<ResolvedFact<Money>> {
  const as_of_date = args.as_of_date ?? new Date();
  const as_of_iso = as_of_date.toISOString().slice(0, 10); // YYYY-MM-DD
  const subject = args.unit_ref.startsWith("unit:")
    ? args.unit_ref
    : `unit:${args.unit_ref}`;

  const query = {
    property_id: args.property_id,
    unit_ref: args.unit_ref,
    as_of_date: as_of_iso,
  };

  // --- Read active claims ----------------------------------------------------
  // @tenant-isolation-disable-next-line -- reason: resolver enforces org isolation via JOIN to Property and explicit org_id parameter; warehouse.claims is org-scoped through this join
  const rows = await prisma.$queryRaw<
    {
      id: string;
      value: any;
      confidence: ResolverConfidence | null;
      source_document_id: string;
      valid_from: Date;
      created_at: Date;
    }[]
  >`
    SELECT c.id, c.value, c.confidence, c.source_document_id, c.valid_from, c.created_at
    FROM warehouse.claims c
    JOIN "Property" p ON p.id = c.property_id
    WHERE c.property_id = ${args.property_id}::uuid
      AND p."organizationId" = ${args.org_id}::uuid
      AND c.subject = ${subject}
      AND c.predicate = 'kaltmiete'
      AND c.claim_kind = 'assertion'
      AND c.valid_from <= ${as_of_iso}::date
      AND (c.valid_to IS NULL OR c.valid_to > ${as_of_iso}::date)
      AND c.superseded_by_claim_id IS NULL
    ORDER BY c.valid_from DESC, c.created_at DESC
  `;

  const generated_at = new Date().toISOString();

  // --- Zero claims: distinguish "no_active_claim" vs "no_claim_for_date" ----
  if (rows.length === 0) {
    // Check if there's any claim for this subject+predicate at all — if so, the
    // user asked about a date before any claim existed.
    // @tenant-isolation-disable-next-line -- reason: diagnostic count query, same org scope as primary query above
    const existsAtAll = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM warehouse.claims c
      JOIN "Property" p ON p.id = c.property_id
      WHERE c.property_id = ${args.property_id}::uuid
        AND p."organizationId" = ${args.org_id}::uuid
        AND c.subject = ${subject}
        AND c.predicate = 'kaltmiete'
        AND c.claim_kind = 'assertion'
    `;
    const anyClaims = Number(existsAtAll[0]?.count ?? 0n) > 0;
    const status: ResolutionStatus = anyClaims
      ? "no_claim_for_date"
      : "no_active_claim";

    const drId = await writeDerivationRecord({
      property_id: args.property_id,
      input_claim_ids: [],
    });

    return {
      query,
      value: null,
      confidence: "low",
      status,
      source_claim_ids: [],
      source_document_ids: [],
      conflicts: [],
      derivation_record_id: drId,
      resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
      generated_at,
    };
  }

  // --- One claim: simple case (§5.2 step 3) --------------------------------
  if (rows.length === 1) {
    const c = rows[0];
    const drId = await writeDerivationRecord({
      property_id: args.property_id,
      input_claim_ids: [c.id],
    });
    return {
      query,
      value: extractMoney(c.value),
      confidence: c.confidence ?? "low",
      status: "single_active_claim",
      source_claim_ids: [c.id],
      source_document_ids: [c.source_document_id],
      conflicts: [],
      derivation_record_id: drId,
      resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
      generated_at,
    };
  }

  // --- Multiple claims: latest wins, others become conflicts (§5.2 step 4) -
  const winner = rows[0];
  const losers = rows.slice(1);

  const conflicts: Conflict[] = losers.map((l) => ({
    claim_id: l.id,
    reason: "superseded_by_later_claim",
    value: extractMoney(l.value),
    valid_from: l.valid_from.toISOString().slice(0, 10),
  }));

  const drId = await writeDerivationRecord({
    property_id: args.property_id,
    input_claim_ids: [winner.id, ...losers.map((l) => l.id)],
  });

  return {
    query,
    value: extractMoney(winner.value),
    confidence: downgradeConfidence(winner.confidence ?? "low"), // §5.2 step 5
    status: "latest_active_claim_with_conflicts",
    source_claim_ids: [winner.id, ...losers.map((l) => l.id)],
    source_document_ids: Array.from(
      new Set([winner.source_document_id, ...losers.map((l) => l.source_document_id)])
    ),
    conflicts,
    derivation_record_id: drId,
    resolver: { name: RESOLVER_NAME, version: RESOLVER_VERSION },
    generated_at,
  };
}

// ---------------------------------------------------------------------------

/**
 * Extract the Money value from a claim's value JSONB.
 * Claim value shape (per Task 1.7 emitter): { amount: number, currency: string, raw_value?: string }.
 * Returns the canonical Money shape (amount + currency only).
 */
function extractMoney(value: any): Money {
  if (
    value &&
    typeof value === "object" &&
    typeof value.amount === "number" &&
    typeof value.currency === "string"
  ) {
    return { amount: value.amount, currency: value.currency };
  }
  // Defensive fallback: should never happen if upstream contracts hold
  throw new Error(
    `rent_for_unit: claim value missing required Money fields: ${JSON.stringify(value)}`
  );
}

/**
 * Write a DerivationRecord for this resolution call.
 * Best-effort: failures are logged but do not block the resolution result.
 * Returns the new DR id, or null if the write failed.
 */
async function writeDerivationRecord(args: {
  property_id: string;
  input_claim_ids: string[];
}): Promise<string | null> {
  try {
    const output_id = randomUUID();
    // @tenant-isolation-disable-next-line -- reason: derivation_records insert for resolver audit trail; property_id is already verified as belonging to org_id by the read-path JOIN; output_id is freshly generated UUID
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO warehouse.derivation_records (
        property_id, output_type, output_id,
        input_claim_ids, input_extraction_run_ids, rule_refs,
        resolver_version
      ) VALUES (
        ${args.property_id}::uuid, 'resolved_fact', ${output_id}::uuid,
        ${args.input_claim_ids}::uuid[], '{}'::uuid[], ${["§5.2"]}::text[],
        ${RESOLVER_VERSION}
      ) RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn("[rent_for_unit] derivation_record write failed", err);
    return null;
  }
}
```

---

## Step 3 — Tests

Create `src/tests/resolvers/rent-for-unit.test.ts`. Same `tx` rollback pattern as Task 1.8 (insert claims, run resolver, assert, rollback).

**Wait — resolver isn't tx-aware.** The applier accepts an optional `tx` for testability; the resolver doesn't. Two options:

- **Option A:** add an optional `tx` to `rentForUnit({ ..., tx? })`. Mirrors the applier pattern. Small contract addition.
- **Option B:** tests insert claims via raw SQL into the real DB (test org), assert via resolver call, and leave residue. Same trade as Task 1.8's test approach but without the rollback escape valve.

Choose **Option A**. It's the same lesson as Task 1.8: tx-aware resolvers are testable; non-tx-aware resolvers force either residue or schema gymnastics. Refactor the resolver to accept `opts?: { tx?: PrismaTransactionClient }` and use `const db = opts?.tx ?? prisma;` throughout.

Adjusted signature in Step 2:

```typescript
export async function rentForUnit(
  args: RentForUnitArgs,
  opts?: { tx?: PrismaTransactionClient }
): Promise<ResolvedFact<Money>>
```

Tests then do:

```typescript
await prisma.$transaction(async (tx) => {
  // seed claims via tx
  await tx.$executeRaw`INSERT INTO warehouse.claims (...) VALUES (...)`;
  // call resolver with tx
  const fact = await rentForUnit({ property_id, unit_ref, org_id, as_of_date }, { tx });
  // assertions
  // ...
  throw new Error("rollback");
}).catch((e) => { if (e.message !== "rollback") throw e; });
```

### Test scenarios

**Scenario 1 — Lena Everding (single_active_claim, the Phase 1 case):**
1. Seed: one kaltmiete claim, subject=`unit:1.OG`, value={amount:65000, currency:"EUR"}, valid_from=2025-04-01, valid_to=null, confidence=high
2. Call: `rentForUnit({ property_id, unit_ref: "1.OG", org_id })`
3. Assert: `value.amount === 65000`, `value.currency === "EUR"`
4. Assert: `confidence === "high"` (no downgrade)
5. Assert: `status === "single_active_claim"`
6. Assert: `source_claim_ids.length === 1`
7. Assert: `conflicts.length === 0`
8. Assert: `resolver.name === "rent_for_unit"`, `resolver.version === "1.0.0"`
9. Assert: `derivation_record_id !== null`

**Scenario 2 — Paul/Kuru-style Mieterhöhung (single winner after closure):**
10. Seed: claim A (€525, valid_from=2022-06-01, valid_to=2023-12-31, superseded_by_claim_id=B.id), claim B (€575, valid_from=2024-01-01, valid_to=null)
11. Call with `as_of_date = 2025-01-01`
12. Assert: only B is returned (A is closed); `status === "single_active_claim"`; `value.amount === 57500`

**Scenario 3 — Hofmann (single claim, no superseding events):**
13. Seed: claim A (€900, valid_from=2010-06-01, valid_to=null)
14. Call with `as_of_date = today`
15. Assert: `value.amount === 90000`, `status === "single_active_claim"`

**Scenario 4 — Conflict case (multi-claim, no closure applied — data error):**
16. Seed: TWO assertion claims for the same subject+predicate with overlapping intervals, neither superseded (e.g., two competing Mietverträge accidentally both processed): A (€600, valid_from=2024-01-01), B (€650, valid_from=2024-06-01), both valid_to=null
17. Call with `as_of_date = today`
18. Assert: `status === "latest_active_claim_with_conflicts"`
19. Assert: winner is B (`value.amount === 65000`)
20. Assert: `conflicts.length === 1`, `conflicts[0].claim_id === A.id`, `conflicts[0].reason === "superseded_by_later_claim"`
21. Assert: confidence downgraded — if both seeded as "high", winner confidence === "medium"
22. Assert: `source_claim_ids.length === 2`, with winner id first

**Scenario 5 — No active claim (no kaltmiete ever for this unit):**
23. Seed: no claims for the subject
24. Call: `rentForUnit({ property_id, unit_ref: "1.OG", org_id })`
25. Assert: `value === null`, `status === "no_active_claim"`, `confidence === "low"`
26. Assert: `derivation_record_id !== null` (still wrote DR for audit)

**Scenario 6 — Claim exists but as_of_date is before any valid_from:**
27. Seed: one claim, valid_from=2025-04-01
28. Call: `rentForUnit({ property_id, unit_ref: "1.OG", as_of_date: new Date("2020-01-01"), org_id })`
29. Assert: `value === null`, `status === "no_claim_for_date"` (distinct from no_active_claim)

**Scenario 7 — Org isolation:**
30. Seed: claim in OTHER_ORG_ID (use a different test property in different org)
31. Call with TEST_ORG_ID but with OTHER_ORG's property_id
32. Assert: `value === null`, `status === "no_active_claim"` (claim is filtered out by the JOIN)

**Scenario 8 — `unit:` prefix idempotency:**
33. Seed: one kaltmiete claim with subject=`unit:1.OG`
34. Call once with `unit_ref: "1.OG"`, once with `unit_ref: "unit:1.OG"`; both must return the same value (defensive guard, should never happen in practice but cheap to verify)

**Total: ≥30 assertions across 8 scenarios.**

### Purity gate test

Create `src/tests/resolvers/resolver-purity.test.ts`. Mirrors `src/tests/emitter-purity.test.ts` from Task 1.7. Reads `src/lib/resolvers/rent-for-unit.ts` and `src/lib/resolvers/types.ts` as source text, asserts no import of:

- `@anthropic-ai/*`
- `openai`
- Anything under `src/lib/emitters/*` (resolver should not import emitter code)
- Anything under `supabase/functions/process-document/*` (no Edge Function modules)
- Anything matching `*prompt*` or `*extract*` paths

Plus assert: the file does NOT contain string literals matching `fetch(` or `https://` (defense in depth against accidental HTTP calls from a resolver).

---

## Step 4 — ARCHITECTURE_STATE.md update

Append:

```markdown
## Resolver layer (Task 1.10+)

Resolvers are pure functions that answer one question by querying the claim
store and returning a `ResolvedFact` with full provenance. Architecture §5.1–5.3.

**Shipped:**
- `src/lib/resolvers/types.ts` — `ResolvedFact<TValue>`, `ResolutionStatus`,
  `Money`, `Conflict`, `downgradeConfidence`
- `src/lib/resolvers/rent-for-unit.ts` (Task 1.10) — `rentForUnit({ property_id,
  unit_ref, as_of_date?, org_id }, { tx? }) → Promise<ResolvedFact<Money>>`.
  Implements §5.2 algorithm: zero/one/multi-claim handling, sort by (valid_from
  DESC, created_at DESC), confidence downgrade on conflicts. Writes a
  DerivationRecord per call (output_type="resolved_fact"); DR write is
  best-effort and does not block resolution. Org isolation via JOIN to Property
  with explicit org_id parameter.
- `src/tests/resolvers/rent-for-unit.test.ts` — 8 scenarios, ≥30 assertions,
  covers Lena single-claim, Paul/Kuru-style Mieterhöhung, Hofmann, multi-claim
  conflict, zero-claim, before-any-claim date, org isolation, prefix
  idempotency
- `src/tests/resolvers/resolver-purity.test.ts` — CI gate: resolver source
  contains no LLM/prompt/emitter/extraction imports and no `fetch(` or
  `https://` literals

**Pending (separate tasks):**
- Other resolvers (`owner_of_property`, `active_insurance_for_property`,
  `last_meter_reading_for_unit`) — follow the same template
- UI surfacing of conflicts (`status === "latest_active_claim_with_conflicts"`
  should drive a triage banner)
- Caching/memoization for hot resolvers (not needed pre-customer)
```

---

## Step 5 — Verify

```bash
cd ~/repos/property-management-saas
git pull
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/resolvers/resolver-purity.test.ts | tail -10
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/resolvers/rent-for-unit.test.ts | tail -40
npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

All tests pass, tenant-isolation gate clean, tsc silent. Run the full existing suite to confirm no regression:

```bash
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" | tail -3 || break
done
```

---

## Step 6 — PR

```bash
git checkout -b feature/task-1.10-rent-for-unit-resolver
git add src/lib/resolvers/ \
        src/tests/resolvers/ \
        tenant-isolation-exceptions.md \
        ARCHITECTURE_STATE.md
git commit -m "feat(resolvers): add rent_for_unit resolver per architecture §5.2 (Task 1.10)

- src/lib/resolvers/types.ts: ResolvedFact<T>, ResolutionStatus, Money,
  Conflict, downgradeConfidence helper
- src/lib/resolvers/rent-for-unit.ts: rentForUnit query → claim store, applies
  §5.2 algorithm (zero/one/multi-claim handling, sort, confidence downgrade
  on conflicts). Org isolation via JOIN to Property. Writes DerivationRecord
  per call (best-effort). Accepts optional tx for testability.
- src/tests/resolvers/rent-for-unit.test.ts: 8 scenarios, ≥30 assertions
- src/tests/resolvers/resolver-purity.test.ts: CI gate enforcing no LLM,
  prompt, emitter, extraction, or HTTP imports in resolver source
- tenant-isolation-exceptions.md: auto-regenerated for resolver annotations
- ARCHITECTURE_STATE.md: resolver layer section"
git push -u origin feature/task-1.10-rent-for-unit-resolver
```

PR via GitHub web:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-1.10-rent-for-unit-resolver
```

CI green → merge.

---

## Definition of done

- [ ] Branch pushed, PR opened
- [ ] CI green (existing tests + new resolver tests + purity gate + tenant-isolation + tsc + ARCHITECTURE_STATE gate)
- [ ] `npx tsc --noEmit` silent
- [ ] `rent-for-unit.test.ts` reports ≥30 assertions across 8 scenarios, all OK
- [ ] `resolver-purity.test.ts` passes
- [ ] ARCHITECTURE_STATE.md section added
- [ ] Single descriptive commit, PR merged into main
- [ ] **Live verification:** after merge, run this from the Mac Mini:
  ```bash
  DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config -e "
  import('./src/lib/resolvers/rent-for-unit.ts').then(async ({ rentForUnit }) => {
    const f = await rentForUnit({
      property_id: 'f37448e4-11ae-453c-ac3c-850385039c0b',  // KO132
      unit_ref: '1.OG',
      org_id: '310131df-d6ed-4007-83c2-ac69a7e9df42',
    });
    console.log(JSON.stringify(f, null, 2));
  });
  "
  ```
  Expected: `value.amount === 65000`, `value.currency === "EUR"`, `status === "single_active_claim"`, `confidence === "high"`. **This is the Phase 1 success criterion.**

---

## Notes for reviewer

**The resolver writes a DerivationRecord per call.** This is the architecture's explicit requirement (§4.6, §5.1 implied via provenance). Every resolution is auditable: "which claims contributed to this answer at this moment." If volume grows enough that the DR write becomes a hot-path cost, the future hardening is per-resolver flags to disable DR for ephemeral or repeated lookups — but for Phase 1, audit-trail completeness beats microseconds.

**The DR write is best-effort.** If the insert fails (transient DB blip, network), we log and return the resolved value with `derivation_record_id: null`. The argument: reads must not be blocked by audit-trail failures. The counterargument: silent audit gaps. I chose "log + return value" because the resolver is a query path, and breaking queries on audit failures would make the system feel broken for cosmetic reasons. The log is the signal that the audit chain has a gap.

**Org isolation via JOIN, not via wrapper.** The Task 1.8 applier uses `warehouseDb(orgId)` wrappers internally. The resolver instead JOINs `warehouse.claims` to `Property` and filters by `organizationId = $org_id`. Reason: resolvers should be self-contained pure functions readable in isolation. Mixing in wrapper indirection makes the resolver harder to reason about and harder to test. The cost is one extra JOIN in the query plan, which Postgres handles with an index on `Property.id` (the primary key) anyway.

**`tx` is optional for testability.** Same lesson as Task 1.8. Without it, tests either pollute the production DB or require schema gymnastics. With it, tests wrap calls in their own transaction and rollback. Production callers (UI, agents) call without `tx` and the resolver uses the default `prisma` client.

**Distinguishing `no_active_claim` from `no_claim_for_date`.** The architecture §5.2 mentions both as distinct edge cases. I implemented this with a second diagnostic count query when zero claims match the primary query. The cost is one extra round trip in the empty case only. Justification: the diagnostic signal matters for triage (UI can show "this date is before any rent record" vs "this unit has no rent record at all"), and the empty case is by definition not hot-path.

**`extractMoney` defensive throw.** If a claim's value JSONB doesn't have the expected `{amount, currency}` shape, the resolver throws. This is intentional: the upstream contract (emitter writes valid Money to `value`) is invariant. A violation indicates a real bug, and silent fallback to `null` would hide it. The exception path is clearly attributable to a specific claim id via the error message.

**Purity gate is mechanical, not semantic.** The CI gate greps for imports and string literals; it doesn't analyze data flow. A determined contributor could route an LLM call through an indirection layer and bypass the check. The gate catches accidental drift (the common failure mode), not motivated attack. This is consistent with the architecture §5.3 stance: discipline + mechanical enforcement, not bulletproofing.

**No HTTP literals in the resolver file.** The purity gate asserts the resolver source does not contain `fetch(` or `https://`. Reason: a resolver that makes HTTP calls is not a resolver, it's an integration. If a future resolver needs an external API (e.g., a Bundesbank-Index API for Indexmiete), the integration belongs in a separate adapter that emits a claim, not in the resolver itself. This is §5.3's "no extraction logic in resolvers" extended to "no I/O beyond the claim store."
