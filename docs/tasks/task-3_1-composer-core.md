# Task 3.1 — Composer core: `PropertySnapshot` shape

**Task type:** t2 M (new layer — the deterministic brain replacement foundation; pure TypeScript; requires review before merge)

**Branch:** `feature/task-3.1-composer-core`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 3.1 acceptance criteria
- **Architecture §5.4.3 (the composer) + §5.4.4 (ResolvedFact) — authoritative.** §5.4.2 (three-component split), §5.4.7 (structurally debuggable), §5.4.8 (Blackstone compatibility — NOT this task), §5.4.9 (migration kill-switch — Task 3.4)
- Architecture §6.x / line ~332 — `DerivationRecord` shape (output_type now includes `"property_snapshot"`)
- **Precedents to mirror:** `src/lib/resolvers/rent-for-unit.ts` + `src/lib/resolvers/types.ts` (Task 1.10 — the resolver this composer calls and whose `ResolvedFact`/status vocabulary it must consume), `src/lib/claim-store/applier.ts` (how DerivationRecords are written — output_type, input_claim_ids, versions), `src/tests/resolvers/resolver-purity.test.ts` (the purity-gate pattern this task's CI test mirrors)

**What this delivers:** the keystone of Phase 3 — the deterministic composer that assembles a `PropertySnapshot` from resolver outputs, with no LLM. Tasks 3.2 (rent_roll module), 3.3 (dashboard), 3.4 (shadow mode), 3.5 (presenter) all build on this. This task builds the **framework + core + metadata + DerivationRecord + module-dispatch registry**, not the rent_roll module itself (that's 3.2). The deliverable is independently testable: `CorePropertySnapshot` from real Property/Unit data, the metadata machinery, and a module registry that returns `"unavailable"` for any module without a registered handler yet.

---

## Step 0 — Verify shipped contracts BEFORE writing code

The architecture (§5.4.4) describes an *idealized* `ResolvedFact` with status `resolved|conflicted|missing|stale|unsupported`. The SHIPPED resolver (Task 1.10) returns a different status vocabulary (`single_active_claim|no_active_claim|no_claim_for_date|conflict|...`). **The composer must consume the shipped shape, not the idealized one.** Reconcile this first.

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-3.1-composer-core

# 1. The SHIPPED ResolvedFact<T> + ResolutionStatus the resolver returns
echo "=== resolvers/types.ts ==="
cat src/lib/resolvers/types.ts

# 2. The resolver's return shape + signature (what composePropertySnapshot will call in 3.2)
echo "=== rent-for-unit.ts signature + return ==="
grep -n "export function\|export async\|ResolvedFact\|return {" src/lib/resolvers/rent-for-unit.ts | head -30

# 3. How DerivationRecords are written today (mirror this exactly)
echo "=== DerivationRecord writes in applier ==="
grep -n "derivation_record\|output_type\|input_claim_ids\|composer_version\|resolver_version" src/lib/claim-store/applier.ts | head -20
echo "=== DerivationRecord table columns ==="
grep -rn "derivation_records\|output_type\|composer_version" supabase/migrations/ | head -15

# 4. Property + Unit table structure (CorePropertySnapshot reads these)
echo "=== Property / Unit schema ==="
grep -n "model Property\|model Unit\|short_code\|shortCode\|total_sqm\|organizationId" prisma/schema.prisma | head -30

# 5. The purity-gate test pattern to mirror
echo "=== resolver-purity test ==="
cat src/tests/resolvers/resolver-purity.test.ts

# 6. DB client + how resolvers receive a tx (composer needs the same)
echo "=== db client + tx pattern ==="
grep -n "import.*db\|PrismaTransactionClient\|{ tx }" src/lib/resolvers/rent-for-unit.ts | head
```

**Reconcile before coding. Critical confirmations:**
- **`ResolvedFact<T>` exact shape** — the composer wraps/passes resolver output. Use the SHIPPED type (fields, status enum, provenance shape, `resolver: {name, version}`). Do NOT invent the §5.4.4 idealized version. If the shipped `ResolvedFact` lacks a field the architecture wants (e.g. `explanation`), note it but do not block — the composer passes through what the resolver produces.
- **DerivationRecord write path** — confirm `output_type` accepts `"property_snapshot"` (architecture §332 says it should; verify the DB CHECK constraint and the TS enum both allow it — if the CHECK rejects it, that's a migration, which is OUT OF SCOPE here → flag and use a follow-up, or confirm it's already allowed).
- **Property/Unit tables** — how units are enumerated for a property (for `claim_snapshot_version` and later rent_roll), the `organizationId`/`org_id` column, `short_code`, `total_sqm`. CorePropertySnapshot is built from these.
- **Whether the composer takes a `tx` or opens its own connection** — mirror the resolver's pattern for testability (the resolver tests pass `{ tx }`).

---

## Scope

`src/lib/composer/property-snapshot.ts` implementing §5.4.3:

1. **Types:** `PropertySnapshot { core, modules, metadata }`, `CorePropertySnapshot`, the `modules` container (optional `rent_roll`, `ownership`, `insurance`, `costs`, `handover`), and `SnapshotMetadata`.
2. **`composePropertySnapshot({ property_id, modules, org_id }, { tx? }) => Promise<PropertySnapshot>`** — pure TypeScript, no LLM.
3. **CorePropertySnapshot** — always composed, from Property/Unit tables (short_code, address, total_sqm, unit count, org_id).
4. **Module dispatch registry** — for each requested module name, look up a registered handler and call it; modules with no handler return `completeness: "unavailable"`. (rent_roll's handler is registered but minimal/stub here; 3.2 implements it fully.)
5. **Metadata** — `composed_at`, `claim_snapshot_version` (hash over the relevant claim IDs for the property), `resolver_versions` (collected from the ResolvedFacts the modules produced), `completeness` per requested module, `warnings`.
6. **DerivationRecord** — write one with `output_type: "property_snapshot"`, `input_claim_ids` (the claims that fed the snapshot), `composer_version`, `resolver_version`(s).
7. **CI purity test** — assert the composer file imports no LLM client / prompt module / Anthropic SDK.

---

## Out of scope

- **The rent_roll module's real implementation** — Task 3.2 (`src/lib/composer/modules/rent-roll.ts`). 3.1 registers it as a handler that may return `"unavailable"` or a minimal placeholder; 3.2 fills it in.
- **ownership / insurance / costs / handover modules** — later tasks. Defined in the type as optional, dispatch returns `"unavailable"`.
- **Dashboard wiring** — Task 3.3.
- **Blackstone-compatible projection (§5.4.8)** — explicitly deferred; canonical output is `PropertySnapshot`. Do not build the Blackstone shim here.
- **Presenter / any LLM** — Task 3.5. The composer is pure; the CI test enforces it.
- **Shadow comparison vs legacy brain** — Task 3.4.
- **DB migrations** — if `output_type` CHECK doesn't allow `"property_snapshot"`, flag it; do not add a migration in this task (migrations are their own discipline).
- **Caching/invalidation** — `claim_snapshot_version` is COMPUTED here (the hash), but the cache store/lookup that uses it is later.

---

## Files touched

- `src/lib/composer/property-snapshot.ts` — new (types + composePropertySnapshot + module registry)
- `src/lib/composer/types.ts` — new, if cleaner to separate the type definitions
- `src/tests/composer/property-snapshot.test.ts` — new
- `src/tests/composer/composer-purity.test.ts` — new (or extend an existing purity gate)
- `ARCHITECTURE_STATE.md` — append Task 3.1 section

**NOT touched:** resolvers, claim-store, applier, schemas, Edge Function, DB schema, dashboard.

---

## Repo conventions (recap)

- npm, tsc clean, lint clean
- Tests: `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- Integration-style tests that touch the DB use per-test rollback tx (mirror resolver tests); pure-type tests need no DB
- Composer is PURE re: LLM — no Anthropic SDK, no prompt module, no fetch to model APIs. It DOES read the DB (via Prisma/tx) — that's allowed (resolvers do too). The purity gate forbids LLM/prompt imports, not DB access.
- TEST_ORG_ID `310131df-d6ed-4007-83c2-ac69a7e9df42`; KO132 `f37448e4-11ae-453c-ac3c-850385039c0b`; HHS55 `d2e8e9c7-957a-4e0f-8150-452c21bcae56`

---

## Step 1 — Types (§5.4.3 + §5.4.4)

Define in `property-snapshot.ts` (or `composer/types.ts`). Use the SHIPPED `ResolvedFact<T>` from `resolvers/types.ts` — import it, don't redefine.

```typescript
import type { ResolvedFact } from "../resolvers/types.ts";

export interface CorePropertySnapshot {
  property_id: string;
  org_id: string;
  short_code: string | null;
  address: string | null;
  total_sqm: number | null;
  unit_count: number;
  unit_refs: string[];           // enumerated from Unit table
}

// Module snapshot shapes — only the container is defined here.
// Concrete module shapes (RentRollSnapshot etc.) are owned by their module
// files (3.2+). Here they are referenced as opaque module results.
export interface ModuleResult {
  completeness: "complete" | "partial" | "unavailable";
  data: unknown;                 // the module's own snapshot shape
  resolver_versions: Record<string, string>;
  input_claim_ids: string[];
  warnings: Warning[];
}

export interface Warning {
  module: string | null;
  code: string;
  message: string;
}

export interface SnapshotMetadata {
  composed_at: string;                          // ISO timestamp
  claim_snapshot_version: string;               // hash over relevant claim IDs
  resolver_versions: Record<string, string>;
  completeness: Record<string, "complete" | "partial" | "unavailable">;
  warnings: Warning[];
}

export interface PropertySnapshot {
  core: CorePropertySnapshot;
  modules: {
    rent_roll?: ModuleResult;
    ownership?: ModuleResult;
    insurance?: ModuleResult;
    costs?: ModuleResult;
    handover?: ModuleResult;
    [key: string]: ModuleResult | undefined;
  };
  metadata: SnapshotMetadata;
}

export interface ComposeRequest {
  property_id: string;
  org_id: string;
  modules: string[];             // e.g. ["rent_roll"]
}
```

(Adjust `CorePropertySnapshot` fields to the actual Property/Unit columns from Step 0.)

---

## Step 2 — The module registry

A `ModuleComposer` is a function `(ctx) => Promise<ModuleResult>`. The composer holds a registry keyed by module name. 3.1 registers handlers that may return `"unavailable"`; 3.2 replaces the rent_roll entry with a real implementation.

```typescript
type ModuleComposer = (ctx: ModuleContext) => Promise<ModuleResult>;

interface ModuleContext {
  property_id: string;
  org_id: string;
  core: CorePropertySnapshot;
  tx?: PrismaTransactionClient;
}

const MODULE_REGISTRY: Record<string, ModuleComposer> = {
  // 3.2 replaces this with the real rent-roll module.
  rent_roll: async () => ({
    completeness: "unavailable",
    data: null,
    resolver_versions: {},
    input_claim_ids: [],
    warnings: [{ module: "rent_roll", code: "not_implemented", message: "rent_roll module not yet registered (Task 3.2)" }],
  }),
  // ownership / insurance / costs / handover: later tasks
};
```

When 3.2 ships, it imports its module and registers it (either by mutating this registry or — cleaner — by the composer importing module composers from `composer/modules/*` and 3.2 adding `rent-roll.ts` there). **Decide the registration mechanism in Step 0 based on what's cleanest; document it so 3.2 slots in without touching this file's core logic.**

---

## Step 3 — `composePropertySnapshot`

```typescript
export async function composePropertySnapshot(
  req: ComposeRequest,
  opts: { tx?: PrismaTransactionClient } = {}
): Promise<PropertySnapshot> {
  // 1. Build CorePropertySnapshot from Property + Unit tables (always).
  const core = await buildCore(req.property_id, req.org_id, opts.tx);

  // 2. For each requested module, dispatch to its registered handler.
  const modules: PropertySnapshot["modules"] = {};
  const completeness: SnapshotMetadata["completeness"] = {};
  const resolver_versions: Record<string, string> = {};
  const warnings: Warning[] = [];
  const allInputClaimIds = new Set<string>();

  for (const name of req.modules) {
    const handler = MODULE_REGISTRY[name];
    if (!handler) {
      modules[name] = { completeness: "unavailable", data: null, resolver_versions: {}, input_claim_ids: [], warnings: [{ module: name, code: "unknown_module", message: `No composer registered for module '${name}'` }] };
      completeness[name] = "unavailable";
      warnings.push(...modules[name]!.warnings);
      continue;
    }
    const result = await handler({ property_id: req.property_id, org_id: req.org_id, core, tx: opts.tx });
    modules[name] = result;
    completeness[name] = result.completeness;
    Object.assign(resolver_versions, result.resolver_versions);
    result.input_claim_ids.forEach((id) => allInputClaimIds.add(id));
    warnings.push(...result.warnings);
  }

  // 3. claim_snapshot_version: hash over the relevant claim IDs (sorted, stable).
  const claim_snapshot_version = hashClaimIds([...allInputClaimIds]);

  const metadata: SnapshotMetadata = {
    composed_at: new Date().toISOString(),
    claim_snapshot_version,
    resolver_versions,
    completeness,
    warnings,
  };

  // 4. Write a DerivationRecord (output_type: "property_snapshot").
  await writeSnapshotDerivationRecord({
    property_id: req.property_id,
    org_id: req.org_id,
    input_claim_ids: [...allInputClaimIds],
    resolver_versions,
    tx: opts.tx,
  });

  return { core, modules, metadata };
}
```

`hashClaimIds`: deterministic hash (e.g. SHA-256 of sorted IDs joined) using Node's `crypto`. Stable ordering is mandatory — sort the IDs before hashing so the same claim set always yields the same version.

`writeSnapshotDerivationRecord`: INSERT into `warehouse.derivation_records` with `output_type='property_snapshot'`, `output_id` = a generated uuid for this snapshot, `input_claim_ids`, `composer_version` = `COMPOSER_VERSION` const, `resolver_version` = null (per-module versions live in resolver_versions metadata) or the joined module resolver versions if the column expects a single value (confirm in Step 0). Mirror the applier's write exactly.

**`COMPOSER_VERSION = "1.0.0"`** exported const.

---

## Step 4 — Tests

`src/tests/composer/property-snapshot.test.ts`. Mix of pure + DB (rollback tx). ≥18 assertions.

**Scenario 1 — CorePropertySnapshot from real data (KO132):**
- `composePropertySnapshot({ property_id: KO132, org_id: TEST_ORG, modules: [] })`
- Assert: core.short_code === "KO132", core.unit_count matches the Property's units, core.org_id === TEST_ORG, core.total_sqm present
- Assert: metadata.composed_at parseable, metadata.completeness === {} (no modules requested), metadata.warnings === []

**Scenario 2 — Unknown module → unavailable:**
- `modules: ["nonexistent_module"]`
- Assert: modules.nonexistent_module.completeness === "unavailable", a warning with code "unknown_module", metadata.completeness.nonexistent_module === "unavailable"

**Scenario 3 — rent_roll stub returns unavailable (until 3.2):**
- `modules: ["rent_roll"]`
- Assert: modules.rent_roll.completeness === "unavailable" with the not_implemented warning (this assertion FLIPS to "complete" when 3.2 lands — note that in the test comment)

**Scenario 4 — claim_snapshot_version is deterministic + stable:**
- Compose twice with the same inputs → identical claim_snapshot_version
- Assert: hash is a non-empty string, stable across calls

**Scenario 5 — DerivationRecord written:**
- Inside a rollback tx, compose, then query `warehouse.derivation_records WHERE output_type='property_snapshot'`
- Assert: 1 row, composer_version === "1.0.0", input_claim_ids present (may be empty array when no modules resolve claims — that's fine for 3.1)

**Scenario 6 — HHS55 core:**
- Assert core.short_code === "HHS55", unit_count matches

`src/tests/composer/composer-purity.test.ts` — mirror `resolver-purity.test.ts`:
- Assert `src/lib/composer/property-snapshot.ts` (and any composer/*.ts) imports no Anthropic SDK, no `@/lib/.../prompt`, no LLM client. DB imports are allowed.

---

## Step 5 — ARCHITECTURE_STATE.md

```markdown
## Composer core shipped (Task 3.1, 2026-05-28) — Phase 3 begins

The deterministic brain-replacement foundation. `src/lib/composer/property-snapshot.ts`
assembles a PropertySnapshot { core, modules, metadata } by dispatching to a
module registry. Pure TypeScript — no LLM (CI purity gate enforces). Reads the
Property/Unit tables for CorePropertySnapshot and (via module handlers) the
resolvers for module data.

- composePropertySnapshot({ property_id, org_id, modules }, { tx? }): Promise<PropertySnapshot>
- CorePropertySnapshot: short_code, address, total_sqm, unit_count, unit_refs, org_id
- Module registry: rent_roll/ownership/insurance/costs/handover dispatch; modules
  without a registered handler return completeness "unavailable". rent_roll is
  registered as a stub here — Task 3.2 implements it.
- Metadata: composed_at, claim_snapshot_version (stable SHA-256 over sorted
  relevant claim IDs), resolver_versions, completeness per module, warnings
- Writes a DerivationRecord (output_type "property_snapshot", composer_version 1.0.0)
- Consumes the SHIPPED ResolvedFact shape from resolvers/types.ts (NOT the
  idealized §5.4.4 status enum — reconciled in implementation)

**Pending Phase 3:** 3.2 (rent_roll module — replaces the stub), 3.3 (dashboard
renders from composer), 3.4 (legacy brain shadow mode), 3.5 (presenter, LLM
render-only). Blackstone-compatible projection (§5.4.8) deferred until a surface
needs it.

[NOTE if applicable] DerivationRecord output_type CHECK: confirmed
'property_snapshot' is [allowed | NEEDS a migration — flagged as follow-up].
```

---

## Step 6 — Verify

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/composer/property-snapshot.test.ts | tail -30
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/composer/composer-purity.test.ts | tail -10

# regression (composer is new; confirm nothing else broke)
for f in src/tests/resolvers/*.test.ts src/tests/integration/*.test.ts; do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -2
done

npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

tsc silent, all green. Note: the composer reads Property/Unit + derivation_records under an org — make sure tenant-isolation lint passes (use the same org-scoping the resolvers use; annotate raw SQL if needed with the established `@tenant-isolation-disable-next-line` + reason pattern).

---

## Step 7 — PR

```bash
git add src/lib/composer/ src/tests/composer/ ARCHITECTURE_STATE.md
git commit -m "feat(composer): composer core + PropertySnapshot (Task 3.1)

The deterministic brain-replacement foundation (architecture §5.4.3). Pure
TypeScript, no LLM — assembles a PropertySnapshot from a module-dispatch
registry that calls resolvers on demand.

- composePropertySnapshot({ property_id, org_id, modules }, { tx? })
- CorePropertySnapshot from Property/Unit tables (always composed)
- Module registry: modules without a handler return completeness 'unavailable';
  rent_roll registered as a stub (Task 3.2 implements it)
- Metadata: composed_at, claim_snapshot_version (stable hash over sorted claim
  IDs), resolver_versions, completeness per module, warnings
- Writes a DerivationRecord (output_type 'property_snapshot', composer_version 1.0.0)
- Consumes the shipped ResolvedFact from resolvers/types.ts
- CI purity gate: composer imports no LLM client / prompt module

Phase 3 foundation; 3.2-3.5 build on this.

- src/lib/composer/property-snapshot.ts (+ types)
- src/tests/composer/property-snapshot.test.ts (18+ assertions)
- src/tests/composer/composer-purity.test.ts
- ARCHITECTURE_STATE.md: Task 3.1 section"
git push -u origin feature/task-3.1-composer-core
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-3.1-composer-core
```

---

## Definition of done

- [ ] Step 0 contracts verified; composer consumes the SHIPPED ResolvedFact, DerivationRecord output_type 'property_snapshot' confirmed allowed (or migration flagged)
- [ ] composer/property-snapshot.ts created, pure (no LLM), module registry in place
- [ ] CorePropertySnapshot built from real Property/Unit data (KO132/HHS55 verified)
- [ ] claim_snapshot_version stable + deterministic
- [ ] DerivationRecord written with output_type 'property_snapshot'
- [ ] ≥18 assertions across 6 scenarios pass
- [ ] composer-purity gate passes
- [ ] tsc clean, resolver + integration regression passes, tenant-isolation clean
- [ ] PR merged

---

## Notes for reviewer

**This task builds the frame, not the picture.** The rent_roll module (3.2) is the first real picture. 3.1's job is the frame: the PropertySnapshot type, the compose function, the metadata/DerivationRecord machinery, and a registry that 3.2-3.5 slot into without touching the core. Keeping rent_roll a stub here makes 3.1 independently testable and merges cleanly ahead of 3.2.

**Consume the shipped ResolvedFact, not the architecture's idealized one.** §5.4.4 sketches `status: resolved|conflicted|missing|stale|unsupported`. The actual resolver (Task 1.10) returns `single_active_claim|no_active_claim|no_claim_for_date|conflict|...`. The composer passes resolver output through; it does NOT remap statuses. If a future task wants to normalize the two vocabularies, that's a deliberate decision with its own task — not something to smuggle in here. The architecture is the intent; the shipped resolver is the contract.

**The composer reads the DB but calls no LLM — that distinction is the whole point (§5.4.1).** The v1 brain was an LLM that read raw extractions and inferred facts. The v2 composer reads already-resolved facts (via resolvers) and assembles them deterministically. DB access is fine (resolvers do it). The forbidden thing is reasoning — no LLM, no prompt, no inference. The purity gate enforces exactly this boundary.

**claim_snapshot_version must be stable.** Sort claim IDs before hashing. This hash is the cache-invalidation key (§5.4 / line 353): a new claim for the property changes the set → changes the hash → invalidates the cached snapshot. If the hash is unstable (unsorted input), caching later silently breaks. Determinism is a correctness property, not a nicety.

**Module dispatch is on-demand by design (§5.4.3).** The composer must NOT call every resolver blindly. Surfaces request `modules: ["rent_roll"]`; the composer satisfies only those. This prevents the snapshot becoming "a gravity well where every future resolver gets dumped into a single mega-object." The registry + per-request module list enforces this.

**output_type 'property_snapshot' may need a CHECK migration.** Architecture §332 lists it as a valid output_type, but the shipped DB CHECK constraint (from the Phase 0 claim-store migration) may predate it. Step 0 must confirm. If the CHECK rejects 'property_snapshot', do NOT add the migration inside this task — flag it as a one-line follow-up migration (migrations are their own discipline with their own review). A blocked DerivationRecord write should fail loudly in the test, surfacing the need.

**DB access means tenant-isolation applies.** The composer reads Property/Unit and writes derivation_records, all org-scoped. Use the same org-scoping the resolvers use, and annotate any raw SQL with the established disable-comment + reason. The tenant-isolation gate runs on every PR.
