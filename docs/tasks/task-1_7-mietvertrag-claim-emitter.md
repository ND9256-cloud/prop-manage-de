# Task 1.7 — Mietvertrag claim emitter (pure function)

**Task type:** t2 M (logic + tests, requires review before deploy)

**Branch:** `feature/task-1.7-mietvertrag-claim-emitter`

**Reference:**
- Architecture §4.4 (emitter contract) — emitters are pure, return `EmissionResult { claims_to_insert, closure_intents }`, do no I/O
- Architecture §4.5 (claim_kind taxonomy) — Mietvertrag is `assertion` kind
- `schemas/mietvertrag/schema.yaml` — 8 fields, schema_version `2026-05-21-v1`
- `domain_knowledge/mietvertrag.md` — `closes: []` (Mietvertrag itself emits no closures)
- Phase 0 migration: `warehouse.claims`, `warehouse.claim_closures`, `warehouse.derivation_records`

**Phase 1 success criterion this task moves toward:** `rent_for_unit("KO132","1.OG")` returns €650 via the v2 pipeline (Task 1.8 wires the applier; this task produces the claims to apply).

---

## Scope

A pure function `emitMietvertragClaims(envelope, context) → EmissionResult` that reads a v2 mietvertrag extraction envelope and returns the claims to insert. **No DB imports. No fetch. No I/O of any kind.**

For Lena's Mietvertrag (KO132 1.OG, €650, mietbeginn 2025-04-01), it should produce:
- One `kaltmiete` assertion claim (€65,000 cents, subject `unit:1.OG`, valid_from `2025-04-01`, valid_to null)
- One `tenant_active` assertion claim (subject `unit:1.OG`, valid_from `2025-04-01`, valid_to null, tenant_identity stored on value)
- Optional: `kaution` claim if present and absence_state=present
- `closure_intents: []` (Mietvertrag closes nothing)

If `document_status="draft"` (no signature) OR `kaltmiete.absence_state != "present"` → return `{ claims_to_insert: [], closure_intents: [] }`. The pipeline records the envelope but the claim store stays untouched.

---

## Out of scope

- Writing claims to DB — Task 1.8 (applier)
- Closure logic — Mietvertrag emits none
- Mieterhöhung emitter — separate doc type, future task
- Resolver implementation — separate task
- Human-override path — covered by Task 1.8's applier supporting `source_type: human_adjudication`
- Mietvertragsnachtrag schema — deferred
- Multi-tenant fanout (one claim per tenant in array) — for v2 launch emit one `tenant_active` claim with the tenant wrapped in an array on `value.tenants` (currently length 1; Phase 2 may push N tenants without schema change); per-tenant fanout deferred

---

## Files touched

- `src/lib/emitters/mietvertrag.ts` — new, the pure emitter function
- `src/lib/emitters/types.ts` — new, shared types `Claim`, `ClaimClosure`, `EmissionResult`, `EmitterContext` (used by future emitters too)
- `src/tests/emitter-mietvertrag.test.ts` — new, ≥15 assertions
- `src/tests/emitter-purity.test.ts` — new, CI gate asserting no DB/fetch imports in `src/lib/emitters/`
- `ARCHITECTURE_STATE.md` — append a section for emitters

**NOT touched:**
- Edge Function — the emitter is not yet wired into the pipeline (Task 1.8 wires it)
- Prisma schema — no DB changes
- Any existing prompts or schemas

---

## Repo conventions (recap)

- npm (not pnpm)
- Tests run via `npx tsx -r dotenv/config src/tests/<file>.ts`
- Branch protection on `main` — feature branch + PR, never push to main
- Pipe potentially-paged commands through `| cat`
- Single descriptive commit per PR
- tsc clean, lint clean

---

## Step 1 — Shared emitter types

Create `src/lib/emitters/types.ts`:

```typescript
// Shared types for emitters. Mirrors warehouse.claims / warehouse.claim_closures schema.
// Emitters return plain objects; applier (Task 1.8) maps them to DB rows.

export type ClaimKind = "assertion" | "snapshot" | "event" | "reference";

export type SourceType = "document_extraction" | "human_adjudication" | "system_derivation";

export type Confidence = "high" | "medium" | "low";

/**
 * A claim to be inserted by the applier.
 *
 * Note: id, created_at, superseded_at, superseded_by_claim_id are
 * applier-assigned. Emitters never set them.
 */
export interface Claim {
  property_id: string;
  subject: string;              // e.g., "unit:1.OG", "property"
  predicate: string;            // e.g., "kaltmiete", "tenant_active", "kaution"
  value: Record<string, unknown>; // jsonb payload
  claim_kind: ClaimKind;
  valid_from: string;           // ISO date
  valid_to: string | null;
  source_document_id: string;
  source_extraction_run_id: string;
  source_field_path: string;    // e.g., "fields.kaltmiete"
  confidence: Confidence;
  evidence_id: string | null;
  source_type: SourceType;
  human_actor_id: string | null;
}

/**
 * Closure intent — emitted by Mieterhöhung, Kündigung, Übergabeprotokoll
 * (not by Mietvertrag). Included here for shared type surface.
 */
export interface ClaimClosure {
  target_subject: string;
  target_predicates: string[];
  close_at: string;             // ISO date driving valid_to
  close_mode: "close_overlapping_only" | "close_overlapping_and_future" | "close_overlapping_and_supersede_future";
  match: {
    tenant_identity?: string;
    policy_id?: string;
    lease_id?: string;
  };
  match_strictness: "required" | "optional" | "absent";
  blocker_status: "none" | "requires_review";
}

export interface EmissionResult {
  claims_to_insert: Claim[];
  closure_intents: ClaimClosure[];
}

/**
 * Context the emitter needs that isn't on the envelope itself.
 *
 * property_id and source_document_id come from warehouse.documents (the
 * pipeline that calls the emitter already has these). source_extraction_run_id
 * comes from the extraction run record. evidence_id is set if evidence rows
 * exist (envelope evidence anchors map to warehouse.evidence rows, which
 * Phase 0 ships).
 *
 * Emitter does not query for any of these — the caller provides them.
 */
export interface EmitterContext {
  property_id: string;
  source_document_id: string;
  source_extraction_run_id: string;
  evidence_id_for_field: (field_path: string) => string | null;
}
```

---

## Step 2 — The emitter

Create `src/lib/emitters/mietvertrag.ts`:

```typescript
// Mietvertrag claim emitter.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
// Input → output. Tested in isolation. CI enforces (see emitter-purity.test.ts).
//
// Architecture refs:
//   §4.4 — emitter contract
//   §4.5 — claim_kind = "assertion" for Mietvertrag
//   schemas/mietvertrag/schema.yaml — 8 fields, schema_version 2026-05-21-v1
//   domain_knowledge/mietvertrag.md — closes: [] (Mietvertrag emits no closures)

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
```

---

## Step 3 — Tests (write FIRST against architecture spec, then patch emitter)

**The PR #24 lesson.** Write `emitter-mietvertrag.test.ts` BEFORE running the emitter. Each test asserts behavior from the architecture / schema spec. If the test fails, the emitter is wrong — not the other way around.

Create `src/tests/emitter-mietvertrag.test.ts` with at least these assertions (≥15 total):

**Happy path (Lena fixture):**
1. Returns 2 claims (kaltmiete + tenant_active) for Lena's envelope (no kaution extracted)
2. kaltmiete claim has `predicate: "kaltmiete"`, `subject: "unit:1.OG"`, `value.amount: 65000`, `value.currency: "EUR"`
3. kaltmiete claim has `valid_from: "2025-04-01"`, `valid_to: null`
4. kaltmiete claim has `claim_kind: "assertion"`, `source_type: "document_extraction"`
5. tenant_active claim has `value.tenants[0].name: "Everding, Lena"` (production envelope uses "Last, First" format)
6. Both claims have correct `property_id`, `source_document_id`, `source_extraction_run_id` from context
7. `closure_intents` is empty array
8. `source_field_path` matches the field key for each claim

**Kaution emission (Paul-like fixture with kaution present):**
9. Returns 3 claims when kaution.absence_state="present"
10. kaution claim has `value.amount`, `subject: "unit:EG"`, `predicate: "kaution"`

**Kaution absence:**
11. Returns 2 claims (no kaution) when kaution.absence_state="absent"
12. Returns 2 claims (no kaution) when kaution.absence_state="inferred" (do not emit inferred values — only present)
13. Returns 2 claims (no kaution) when kaution.absence_state="requires_human_review"

**Draft / unsigned guard:**
14. Returns `{ claims_to_insert: [], closure_intents: [] }` when `lifecycle.document_status === "draft"`

**Load-bearing-field guards:**
15. Returns empty when kaltmiete.absence_state="ambiguous"
16. Returns empty when unit_ref is missing entirely
17. Returns empty when mietbeginn.absence_state="illegible"
18. Returns empty when tenant_identity.normalized_value is missing the `name` field

**Mietende handling:**
19. valid_to is null when mietende.absence_state="not_applicable" (unbefristet)
20. valid_to is the ISO date when mietende.absence_state="present" (befristet)

**Determinism:**
21. Calling the emitter twice with identical inputs returns deeply equal results

Fixtures: build inline as `MietvertragEnvelope` literals — no file reads, no fetches. Lena fixture mirrors the live envelope for `f7c3e663-11bf-4b91-947c-9136df9eefae` but with stable test IDs.

`property_id`, `source_document_id`, `source_extraction_run_id` in test context are stable UUIDs like `00000000-0000-0000-0000-000000000001`.

`evidence_id_for_field` in test context returns `null` for all fields (evidence wiring is Task 1.8's problem).

---

## Step 4 — Purity gate

Create `src/tests/emitter-purity.test.ts`:

```typescript
// CI gate: emitter modules must not import DB, fetch, or other I/O.
//
// Why: emitters are pure functions per architecture §4.4. The applier
// (Task 1.8) does the I/O. If an emitter starts querying Prisma or
// calling fetch, the architectural invariant is broken and tests
// downstream get harder to write.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const FORBIDDEN_IMPORTS = [
  /from\s+["']@?\/?(lib\/)?prisma["']/,
  /from\s+["']@prisma\/client["']/,
  /from\s+["']@?\/?(lib\/)?db["']/,
  /from\s+["']@?\/?(lib\/)?supabase/,
  /from\s+["']pg["']/,
  /from\s+["']node-fetch["']/,
  /require\s*\(\s*["']pg["']\)/,
];

// Built-in fetch is also forbidden in emitter modules.
const FETCH_USAGE = /\bfetch\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const emitterFiles = walk("src/lib/emitters")
  .filter(f => !f.endsWith(".test.ts") && !f.endsWith("/types.ts"));

let assertions = 0;

for (const file of emitterFiles) {
  const src = readFileSync(file, "utf8");

  for (const pattern of FORBIDDEN_IMPORTS) {
    assert.ok(
      !pattern.test(src),
      `Emitter ${file} contains forbidden import matching ${pattern}. Emitters must be pure (architecture §4.4).`
    );
    assertions++;
  }

  assert.ok(
    !FETCH_USAGE.test(src),
    `Emitter ${file} uses fetch(). Emitters must be pure (architecture §4.4). Move I/O to the applier.`
  );
  assertions++;
}

console.log(`emitter-purity: ${assertions} assertions across ${emitterFiles.length} file(s) — OK`);
```

This test fires on every PR via the existing CI workflow that runs the test suite.

---

## Step 5 — ARCHITECTURE_STATE.md update

Append a new section to `ARCHITECTURE_STATE.md`:

```markdown
## Emitters (Task 1.7+)

Pure functions in `src/lib/emitters/<doc_type>.ts` that read v2 envelopes
and return `EmissionResult { claims_to_insert, closure_intents }`. Architecture
§4.4 contract.

**Shipped:**
- `mietvertrag.ts` (Task 1.7, 2026-05-21) — emits kaltmiete + tenant_active
  assertion claims, optionally kaution. No closures. Returns empty result
  for drafts or missing load-bearing fields.

**Pending:**
- `mieterhoehung.ts` — produces kaltmiete claim + close_overlapping_only closure
- `wohnungsuebergabeprotokoll.ts` — dispatches on uebergabe_typ
- `kuendigung.ts` — produces lease_terminated event + close_overlapping_and_future
  closures, conditional on signature/widerspruch/multi_tenant_partial blockers

**Purity gate:** `src/tests/emitter-purity.test.ts` rejects any DB/fetch
import in `src/lib/emitters/`. CI-enforced on every PR.

**Applier wiring:** see Task 1.8 (claim-store transaction applier). Emitters
are not yet called from the Edge Function — the envelope is produced and
stored, but no claims are persisted until 1.8 ships.
```

---

## Step 6 — Verify

```bash
cd ~/repos/property-management-saas
npm run gen:schemas:check | cat   # should still pass
npx tsc --noEmit | cat            # should be silent
npx tsx -r dotenv/config src/tests/emitter-mietvertrag.test.ts | cat
npx tsx -r dotenv/config src/tests/emitter-purity.test.ts | cat
```

All three test runs should report assertion counts and OK. tsc must be clean.

Then run the full existing suite to make sure nothing regressed:

```bash
for f in src/tests/*.test.ts; do
  echo "=== $f ===" && npx tsx -r dotenv/config "$f" | tail -3 || break
done
```

All 11 existing test files plus the 2 new ones (13 total) green.

---

## Step 7 — PR

```bash
git checkout -b feature/task-1.7-mietvertrag-claim-emitter
git add src/lib/emitters/types.ts src/lib/emitters/mietvertrag.ts \
        src/tests/emitter-mietvertrag.test.ts src/tests/emitter-purity.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "feat(emitters): add pure Mietvertrag claim emitter (Task 1.7)

- src/lib/emitters/types.ts: shared Claim/ClaimClosure/EmissionResult/EmitterContext types
- src/lib/emitters/mietvertrag.ts: pure function, emits kaltmiete + tenant_active (+ optional kaution) assertion claims, no closures (per domain_knowledge/mietvertrag.md)
- src/tests/emitter-mietvertrag.test.ts: 21 assertions covering happy path, kaution presence/absence, draft guard, load-bearing-field guards, mietende handling, determinism
- src/tests/emitter-purity.test.ts: CI gate rejecting DB/fetch imports in src/lib/emitters/

Not yet wired into the pipeline — Task 1.8 (applier) does that."
git push -u origin feature/task-1.7-mietvertrag-claim-emitter
gh pr create --fill | cat
```

Wait for CI. All checks green → merge.

---

## Definition of done

- [ ] Branch pushed, PR opened
- [ ] CI green (existing + 2 new test files + tenant-isolation + migration-drift + ARCHITECTURE_STATE gate)
- [ ] `npx tsc --noEmit` silent
- [ ] `emitter-mietvertrag.test.ts` reports ≥21 assertions, all OK
- [ ] `emitter-purity.test.ts` reports OK across all emitter files
- [ ] ARCHITECTURE_STATE.md section added
- [ ] Single descriptive commit, PR merged into main

---

## Notes for the reviewer

The `tenant_active` claim wraps `tenant_identity.normalized_value` (a single object in the v2026-05-21-v1 envelope) into an array on the claim's `value.tenants`. Per-tenant fanout (one claim per tenant) is a future refinement once we know how the multi-tenant resolver queries work — keeping it as a single claim with an array-valued payload now means Task 1.8's applier and the resolver in a later phase both have one row to deal with, not N. The array wrap preserves jsonb shape stability: when extraction starts returning multiple tenants for Mietgemeinschaft cases (Phase 2), the value shape doesn't change.

The kaution emission deliberately only triggers on `absence_state="present"`, not on `"inferred"`. Inferred kaution (computed as 3× Kaltmiete from a "drei Monatsmieten" clause) is captured in the envelope but not promoted to a claim. Rationale: claims represent what the document states. Inference belongs in the verifier or human review path, not in the claim store.

The Sonnet-misses-kaution issue (6 attempts on Lena + Paul all returning absent) is unrelated to this task — when extraction returns kaution absent, the emitter correctly omits the claim. The missed-content verifier (deferred until after Task 1.8) is what eventually catches false absences.

Mietvertrag closes nothing because the original Mietvertrag is the foundational claim chain origin. Mieterhöhungen, Übergabeprotokolle (Auszug), and Kündigungen close claims that this emitter created. That's correct per `domain_knowledge/mietvertrag.md` (`closes: []`) and is the architectural reason Lena/Paul rent_for_unit will work cleanly once Task 1.8 ships the applier.
