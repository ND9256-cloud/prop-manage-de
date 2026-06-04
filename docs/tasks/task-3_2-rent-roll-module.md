# Task 3.2 — `RentRollSnapshot` module

**Task type:** t2 M (the first real composer module; produces the rent roll the dashboard will render; requires review)

**Branch:** `feature/task-3.2-rent-roll-module`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 3.2 acceptance criteria (line 629)
- Architecture §5.4.3 (composer modules, lazy), §5.4.4 (ResolvedFact), §5.4.2 (three-component split)
- **Precedents to mirror:** `src/lib/composer/property-snapshot.ts` (Task 3.1 — the registry this plugs into, the `ModuleResult`/`ModuleContext` types), `src/lib/resolvers/rent-for-unit.ts` + `resolvers/types.ts` (Task 1.10 — the resolver this calls, the shipped `ResolvedFact<Money>` shape), `src/tests/composer/property-snapshot.test.ts` (test harness pattern)
- This session's findings: Unit identifier column is **`unitNumber`** (camelCase, public schema), NOT `unit_ref`. Claim subjects are `unit:<unitNumber>`. KO132 = {EG, 1.OG, DG}, HHS55 = {1.OG, DG}. KO132 EG has no rent claim → resolves to vacancy.

**What this delivers:** the rent_roll module that turns the composer from a frame into a working rent roll. It enumerates every unit from the authoritative Unit inventory (Task 3.1b), resolves each via `rentForUnit`, and returns a `RentRollSnapshot` — one row per unit, occupied or vacant. This is the data behind the dashboard (3.3) and the first surface where Lena's €650 flows through the full chain to a renderable result.

---

## The vacancy distinction (a design requirement, not a nice-to-have)

A unit row's rent resolves to one of:
- **occupied** — `rentForUnit` returns `single_active_claim` with a Money value
- **vacant (real)** — a tenancy ended and no successor: resolver returns `no_claim_for_date` (a closed claim exists in history, but none active today)
- **vacant (phantom / no data)** — the unit exists in inventory but NO claim was ever emitted for it: resolver returns `no_active_claim` (or equivalent "never had a claim" status)

These must be **distinguishable in the output**, because they demand different operator actions: a real vacancy is lost revenue to fill; a phantom vacancy means "go upload the missing lease." The module computes an `occupancy_status` per row capturing this, derived from the resolver's status vocabulary. (This is the KO132 EG case — it has no rent claim, so it's a phantom vacancy: "no lease document on file.")

---

## Step 0 — Verify shipped contracts BEFORE writing code

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-3.2-rent-roll-module

# 1. The composer's module contract (ModuleResult, ModuleContext, registry mechanism)
echo "=== composer module types + registry ==="
grep -n "ModuleResult\|ModuleContext\|ModuleComposer\|MODULE_REGISTRY\|registry\|register" src/lib/composer/property-snapshot.ts src/lib/composer/types.ts

# 2. The SHIPPED ResolvedFact + the resolver's exact status values
echo "=== resolver types + statuses ==="
cat src/lib/resolvers/types.ts
echo "=== rentForUnit signature + every status it returns ==="
grep -n "export\|status:\|ResolutionStatus\|single_active_claim\|no_active_claim\|no_claim_for_date\|conflict" src/lib/resolvers/rent-for-unit.ts

# 3. Does a tenant resolver exist? (acceptance criteria mentions tenant_active: ResolvedFact<Tenant>)
echo "=== tenant resolver? ==="
ls src/lib/resolvers/
grep -rn "tenantForUnit\|tenant_active\|ResolvedFact<Tenant>\|resolveTenant" src/lib/resolvers/ | head

# 4. How 3.1 registered the rent_roll STUB (this task replaces it)
echo "=== current rent_roll stub ==="
grep -n "rent_roll\|rentRoll" src/lib/composer/property-snapshot.ts

# 5. Unit enumeration: confirm column name + how to read units per property
echo "=== Unit columns ==="
grep -n "model Unit" -A 12 prisma/schema.prisma

# 6. How the composer passes tx + org scoping to modules
echo "=== ModuleContext fields + tx ==="
grep -n "ModuleContext\|tx\|org_id\|property_id" src/lib/composer/property-snapshot.ts | head -15
```

**Reconcile before coding. Critical decisions:**

- **Tenant resolver may not exist.** The acceptance criteria list `tenant_active: ResolvedFact<Tenant>` per row, but Task 1.10 only built `rentForUnit`. Check Step 0 #3. **If no tenant resolver exists:** scope this task to `current_kaltmiete` only (the rent roll's core), and include `tenant_active` as a field typed but populated with a `status: "unsupported"`/`unavailable` ResolvedFact, with a `warnings` note that the tenant resolver is a follow-up. Do NOT build a tenant resolver inside this task — that's a separate resolver task with its own claim-query logic and tests. Flag it clearly. (If a tenant resolver DOES exist, use it.)

- **The exact resolver status → occupancy_status mapping.** Confirm the real status strings from Step 0 #2 (this session saw `single_active_claim`, `no_active_claim`, `no_claim_for_date`, `conflict`). Map them:
  - `single_active_claim` → `occupied`
  - `no_claim_for_date` → `vacant` + reason `tenancy_ended` (a closed claim exists in history)
  - `no_active_claim` → `vacant` + reason `no_data` (no claim ever; phantom vacancy — upload the lease)
  - `conflict` (or multi-claim) → `occupied` but flag `needs_review` (rent ambiguous)
  - Adjust to the ACTUAL status enum; the mapping logic is the point, not these exact names.

- **Registry plug-in mechanism** — how 3.1 set up registration. Replace the stub cleanly (either mutate the registry entry or add `composer/modules/rent-roll.ts` and wire it where 3.1 designed for it). Use whatever 3.1 intended so the core file's logic isn't disturbed.

---

## Scope

`src/lib/composer/modules/rent-roll.ts`:

1. A `composeRentRoll(ctx: ModuleContext) => Promise<ModuleResult>` that:
   - Enumerates units for the property from the Unit table (`unitNumber` per `propertyId`, org-scoped)
   - For each unit, calls `rentForUnit({ property_id, unit_ref: unitNumber, org_id }, { tx })`
   - Builds one `RentRollRow` per unit with `current_kaltmiete: ResolvedFact<Money>`, `occupancy_status`, structural fields (`sizeSqm`, `floor`, `rooms` from the Unit row), and (if tenant resolver exists) `tenant_active`
   - Aggregates: total units, occupied count, vacant count, sum of resolved kaltmiete, Vermietungsquote (occupied / total)
   - Returns a `ModuleResult` with `completeness`, `data: RentRollSnapshot`, `resolver_versions`, `input_claim_ids` (union of all rows' source claim ids), `warnings`
2. Register it in the composer (replacing the 3.1 stub).
3. The `RentRollSnapshot` + `RentRollRow` types (in `composer/modules/rent-roll.ts` or `composer/types.ts`).

---

## Out of scope

- **Building a tenant resolver** — if absent, `tenant_active` is a typed-but-unavailable field + a warning + a follow-up note. Separate task.
- **Dashboard rendering** — Task 3.3.
- **ownership / insurance / costs / handover modules** — later.
- **deposit (kaution) / nebenkosten columns** — the rent roll core is kaltmiete + occupancy; other per-unit facts are additive later (and need their own resolvers).
- **targetColdRent vs actual comparison** — the Unit table has a `targetColdRent` column (currently null); surfacing target-vs-actual is a later analytics feature. Include `targetColdRent` passthrough if trivial, but no comparison logic.
- **Caching** — composer caching is separate; this module just resolves on call.
- **Resolver changes** — `rentForUnit` is consumed as-is; do not modify it.

---

## Files touched

- `src/lib/composer/modules/rent-roll.ts` — new
- `src/lib/composer/property-snapshot.ts` — replace the rent_roll stub registration with the real module (minimal change)
- `src/lib/composer/types.ts` — add RentRollSnapshot/RentRollRow if kept central (or keep in the module file)
- `src/tests/composer/rent-roll.test.ts` — new
- `ARCHITECTURE_STATE.md` — append section

**NOT touched:** resolvers, claim-store, Unit table/schema, Edge Function, dashboard.

---

## Step 1 — Types

```typescript
import type { ResolvedFact, Money } from "../../resolvers/types.ts"; // use SHIPPED shapes

export type OccupancyStatus = "occupied" | "vacant" | "needs_review";
export type VacancyReason = "tenancy_ended" | "no_data" | null;

export interface RentRollRow {
  unit_ref: string;                       // = Unit.unitNumber
  occupancy_status: OccupancyStatus;
  vacancy_reason: VacancyReason;          // null when occupied
  current_kaltmiete: ResolvedFact<Money>; // straight from rentForUnit
  tenant_active?: ResolvedFact<unknown>;  // populated only if a tenant resolver exists
  // structural passthrough from Unit
  size_sqm: number | null;
  floor: number | string | null;
  rooms: number | null;
  target_cold_rent: number | null;        // passthrough, no comparison logic
}

export interface RentRollSnapshot {
  rows: RentRollRow[];
  summary: {
    total_units: number;
    occupied_units: number;
    vacant_units: number;
    needs_review_units: number;
    resolved_kaltmiete_total: Money | null;   // sum of occupied rows' kaltmiete
    vermietungsquote: number;                  // occupied / total, 0..1
  };
}
```

(Adjust ResolvedFact/Money imports to the SHIPPED names.)

---

## Step 2 — The module

```typescript
export async function composeRentRoll(ctx: ModuleContext): Promise<ModuleResult> {
  // 1. Enumerate units for this property (org-scoped), ordered by floor for stable display.
  const units = await ctx.tx /* or db */ .$queryRaw`
    SELECT "unitNumber", "floor", "sizeSqm", "rooms", "targetColdRent"
    FROM "Unit"
    WHERE "propertyId" = ${ctx.property_id}::uuid
    ORDER BY "floor" NULLS LAST, "unitNumber"
  `;
  // NOTE: org scoping — Unit has no org_id column directly; it is reached via
  // Property. Confirm the org-isolation approach in Step 0 (the composer core
  // already validates org access for the property; if so, unit enumeration
  // inherits that guarantee — annotate raw SQL accordingly).

  const rows: RentRollRow[] = [];
  const allClaimIds = new Set<string>();
  const resolverVersions: Record<string, string> = {};
  const warnings: Warning[] = [];

  for (const u of units) {
    const rent = await rentForUnit(
      { property_id: ctx.property_id, unit_ref: u.unitNumber, org_id: ctx.org_id },
      { tx: ctx.tx }
    );
    resolverVersions[rent.resolver.name] = rent.resolver.version;
    (rent.source_claim_ids ?? []).forEach((id: string) => allClaimIds.add(id));

    const { occupancy_status, vacancy_reason } = mapOccupancy(rent.status);

    rows.push({
      unit_ref: u.unitNumber,
      occupancy_status,
      vacancy_reason,
      current_kaltmiete: rent,
      size_sqm: u.sizeSqm ?? null,
      floor: u.floor ?? null,
      rooms: u.rooms ?? null,
      target_cold_rent: u.targetColdRent ?? null,
    });
  }

  const snapshot = buildSnapshot(rows); // computes summary + vermietungsquote

  // completeness: complete if every unit resolved without error; partial if any
  // needs_review; (tenant unavailable → still complete for the kaltmiete roll,
  // but add a warning).
  const completeness = rows.some(r => r.occupancy_status === "needs_review") ? "partial" : "complete";

  return {
    completeness,
    data: snapshot,
    resolver_versions: resolverVersions,
    input_claim_ids: [...allClaimIds],
    warnings,
  };
}

function mapOccupancy(status: string): { occupancy_status: OccupancyStatus; vacancy_reason: VacancyReason } {
  switch (status) {
    case "single_active_claim": return { occupancy_status: "occupied", vacancy_reason: null };
    case "no_claim_for_date":   return { occupancy_status: "vacant",   vacancy_reason: "tenancy_ended" };
    case "no_active_claim":     return { occupancy_status: "vacant",   vacancy_reason: "no_data" };
    case "conflict":            return { occupancy_status: "needs_review", vacancy_reason: null };
    default:                    return { occupancy_status: "needs_review", vacancy_reason: null };
  }
}
```

Map to the ACTUAL status strings from Step 0.

---

## Step 3 — Tests

`src/tests/composer/rent-roll.test.ts`. DB-backed (rollback tx where claims are seeded; or read live demo data if stable). ≥20 assertions.

**Scenario 1 — KO132 full rent roll (3 rows):**
- `composePropertySnapshot({ property_id: KO132, org_id: TEST_ORG, modules: ["rent_roll"] })`
- Assert: rent_roll.completeness, data.rows.length === 3
- Assert: 1.OG row → occupied, current_kaltmiete.value.amount === 65000 (Lena €650), status single_active_claim, source_claim_ids non-empty, source_document_ids present (provenance for the 3.3 modal)
- Assert: DG row → occupied (Kuru, whatever the live amount is — assert it resolves with a value)
- Assert: **EG row → vacant, vacancy_reason === "no_data"** (the phantom vacancy — no claim ever emitted)
- Assert: summary.total_units === 3, occupied_units === 2, vacant_units === 1, vermietungsquote ≈ 0.667

**Scenario 2 — HHS55 rent roll (2 rows):**
- Assert: data.rows.length === 2, both resolve, summary.total_units === 2

**Scenario 3 — provenance present on occupied rows:**
- Assert: Lena's row carries source_claim_ids AND source_document_ids (3.3 needs these for the click-through modal). If the resolver returns document ids, assert they're there; if only claim ids, assert those and note the modal will resolve documents from claims.

**Scenario 4 — real vacancy vs phantom vacancy distinguished:**
- If a unit with a closed-but-no-successor claim exists (seed one in a rollback tx if needed), assert it maps to vacant + tenancy_ended, distinct from EG's no_data. (If seeding is heavy, at minimum assert the mapping function directly with each status string.)

**Scenario 5 — mapOccupancy unit-level:**
- Pure-call `mapOccupancy` with each status string → assert the right occupancy_status + vacancy_reason. (Guards the mapping even if live data lacks a case.)

**Scenario 6 — summary math:**
- Assert resolved_kaltmiete_total === sum of occupied rows; vermietungsquote === occupied/total.

---

## Step 4 — ARCHITECTURE_STATE.md + PR

```markdown
## RentRollSnapshot module shipped (Task 3.2, 2026-05-28)

The first real composer module. Enumerates every unit from the authoritative
Unit inventory (3.1b) and resolves each via rentForUnit. One row per unit,
occupied or vacant — vacancy is now a first-class, visible signal.

- src/lib/composer/modules/rent-roll.ts: composeRentRoll(ctx) => ModuleResult
- RentRollRow: unit_ref, occupancy_status, vacancy_reason, current_kaltmiete
  (ResolvedFact<Money> straight from rentForUnit), structural passthrough
  (size_sqm, floor, rooms, target_cold_rent)
- Vacancy distinction: occupied (single_active_claim) | vacant+tenancy_ended
  (no_claim_for_date, a closed claim in history) | vacant+no_data
  (no_active_claim, phantom vacancy — upload the lease). Different operator
  actions, so distinguished in output.
- Summary: total/occupied/vacant counts, resolved kaltmiete total, Vermietungsquote
- Replaces the 3.1 rent_roll stub in the composer registry.
- KO132 → 3 rows (1.OG €650 occupied, DG occupied, EG vacant/no_data);
  HHS55 → 2 rows.
- [tenant_active: tenant resolver {exists & used | does NOT exist yet → field
  typed but unavailable, follow-up flagged}]

**Unblocks Task 3.3** (dashboard renders this with click-through provenance).
[Follow-up if applicable: tenant resolver (tenantForUnit) for the tenant_active column.]
```

```bash
git add src/lib/composer/ src/tests/composer/rent-roll.test.ts ARCHITECTURE_STATE.md
git commit -m "feat(composer): RentRollSnapshot module (Task 3.2)

The first real composer module. Enumerates every unit from the authoritative
Unit inventory (3.1b) and resolves each via rentForUnit, producing one row per
unit — occupied or vacant.

- composeRentRoll(ctx): enumerates Unit.unitNumber per property, calls
  rentForUnit, builds RentRollRow with current_kaltmiete (ResolvedFact<Money>),
  occupancy_status, vacancy_reason, structural passthrough
- Vacancy distinction: occupied | vacant+tenancy_ended (closed claim in
  history) | vacant+no_data (phantom vacancy, no claim ever — upload the lease)
- Summary: counts, resolved kaltmiete total, Vermietungsquote
- Replaces the 3.1 rent_roll stub in the composer registry
- KO132 → 3 rows (1.OG Lena €650, DG, EG vacant); HHS55 → 2 rows

[tenant_active column: tenant resolver status per Step 0]

Unblocks 3.3 (dashboard)."
git push -u origin feature/task-3.2-rent-roll-module
```

PR: `https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-3.2-rent-roll-module`

---

## Definition of done

- [ ] Step 0 verified: ResolvedFact shape, exact resolver statuses, tenant-resolver presence, registry mechanism, `unitNumber` column
- [ ] composeRentRoll enumerates units, resolves each via rentForUnit
- [ ] occupancy_status mapping covers every resolver status; phantom vs real vacancy distinguished
- [ ] summary math correct (counts, total, Vermietungsquote)
- [ ] registered, replacing the 3.1 stub
- [ ] KO132 → 3 rows (1.OG €650, EG vacant/no_data), HHS55 → 2 rows; ≥20 assertions pass
- [ ] tenant_active handled per Step 0 (used if resolver exists; typed-unavailable + flagged if not)
- [ ] tsc clean, composer + resolver regression passes, tenant-isolation clean
- [ ] PR merged → 3.3 unblocked

---

## Notes for reviewer

**This is the first time the full chain produces a customer-facing number.** OCR → extraction → claim → applier → resolver → composer → rent roll row. Lena's €650 has been verified at the resolver level since Phase 1; this is where it becomes a row in a structure the dashboard renders. The assertion that KO132 1.OG returns 65000 with provenance is the end-to-end proof.

**The phantom vacancy is a feature, surfaced precisely.** KO132 EG resolves to `no_active_claim` → vacant/no_data. That's not a bug to hide — it's the system saying "this unit exists but I have no lease document for it." The `vacancy_reason` field makes the dashboard able to show "no lease on file" (actionable: upload it) vs "tenancy ended [date]" (actionable: re-let). Conflating the two would lose exactly the operator signal that justifies the inventory-as-source-of-truth decision.

**Pass the ResolvedFact through untouched.** The row's `current_kaltmiete` IS the resolver's output — value, confidence, status, provenance, resolver version. Don't repackage or drop fields; 3.3's provenance modal needs the claim/document ids intact. The module's job is enumeration + occupancy classification + aggregation, not reshaping the resolved fact.

**Tenant column honesty.** If no tenant resolver exists, do NOT fake it by reading tenant claims ad hoc inside this module — that would duplicate resolver logic outside the resolver layer, the exact anti-pattern the architecture forbids. Type the field, mark it unavailable, warn, and flag the follow-up resolver task. A rent roll with accurate rent + occupancy and an honestly-absent tenant column is far better than one with tenant data resolved through a back channel.

**Vermietungsquote falls out for free.** total/occupied is computable only because the inventory is authoritative (3.1b). This is the roadmap's "vacancy detection / Vermietungsquote" feature landing as a side effect of correct architecture — worth noting it's already here at 3.2, ahead of schedule.

**Stable row ordering.** Order units by floor for display stability (so the dashboard rows don't reshuffle between loads). The resolver result doesn't depend on order, but the rendered roll should be deterministic.
