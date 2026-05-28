# Task 3.1b — Seed the authoritative Unit inventory

**Task type:** t2 S (data-model + seed; unblocks 3.2; may include a small migration)

**Branch:** `feature/task-3.1b-unit-inventory`

**Reference:**
- Architecture decision (this session): **Unit existence is structural truth, owned by the Unit table; unit facts (rent, tenant, deposit) are temporal truth, owned by claims.** The rent_roll module (3.2) enumerates ALL units from the Unit table and calls `rentForUnit` per unit. Units where the resolver returns no active claim ARE vacancies — a first-class signal that only an authoritative inventory can surface. Claim-derived enumeration (Option A) was rejected because vacant units produce no claims and would be invisible, making Vermietungsquote/vacancy-detection structurally impossible.
- Task 3.1 (just merged) — `composePropertySnapshot` builds `CorePropertySnapshot` by reading the Unit table; it currently reports `unit_count: 0` because the table is empty. This task fills it.
- Migration discipline (project rule): Supabase CLI, `supabase db push` is the sole approved method; 26 migrations synced. Any schema change here follows that discipline.

**What this delivers:** the 5-unit authoritative inventory (KO132: EG, 1.OG, DG; HHS55: 1.OG, DG) in the Unit table, with structural fields (size_sqm, floor, rooms). After this, `composePropertySnapshot(KO132)` reports 3 units and `(HHS55)` reports 2 — and 3.2 can enumerate them.

---

## CRITICAL JOIN INVARIANT

The Unit table's `unit_ref` (or equivalent identifier column) **must exactly match the claim-subject convention** used everywhere else: `EG`, `1.OG`, `DG` (not "Erdgeschoss", not "1OG", not "DG-Wohnung"). Claim subjects are `unit:1.OG`, `unit:DG`, `unit:EG`. If the Unit identifier diverges by even formatting, 3.2's `rentForUnit(unit_ref)` join silently returns nothing for that unit and it renders as a false vacancy. This is the single most important correctness property of this task.

---

## Step 0 — Read the Unit model BEFORE deciding migration vs seed-only

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-3.1b-unit-inventory

# 1. The Unit model — what columns exist today?
echo "=== Unit model ==="
grep -n "model Unit" -A 30 prisma/schema.prisma

# 2. Property→Unit relation + how CorePropertySnapshot reads units (3.1)
echo "=== composer reads Unit how? ==="
grep -n "Unit\|unit_ref\|unit_count\|unitRefs\|prisma.unit\|from.*Unit" src/lib/composer/property-snapshot.ts

# 3. The exact 3.1 test assertions that will FLIP once units exist
echo "=== 3.1 composer test unit assertions ==="
grep -n "unit_count\|unit_refs\|no Unit rows" src/tests/composer/property-snapshot.test.ts

# 4. org scoping on Property/Unit + the two property UUIDs
echo "=== Property rows ==="
# (read-only Supabase MCP or a quick query) confirm KO132 + HHS55 ids and org_id
```

**Decide the branch:**
- **Branch SEED-ONLY** — if the Unit model already has columns for the identifier (`unit_ref` or similar), `size_sqm`, `floor`, `rooms`, and the org/property FKs. Then this task is purely a seed (no schema change).
- **Branch MIGRATE+SEED** — if the Unit model lacks `size_sqm` / `floor` / `rooms` (or uses a different identifier column name). Then add the columns via a Supabase migration (`supabase migration new add_unit_structural_fields`, edit SQL, `supabase db push`), THEN seed. Follow the migration discipline exactly — this is the only approved path.

**Confirm the identifier column name.** If the Unit table's unit identifier is named something other than `unit_ref` (e.g. `label`, `ref`, `name`), the seed + the 3.2 join must use that name, and it must hold the canonical values (`EG`/`1.OG`/`DG`). If the column semantics don't fit the claim-subject convention, STOP and flag — this is the join invariant and it's not negotiable.

---

## Scope

1. (If Branch MIGRATE+SEED) A migration adding `size_sqm` (numeric, nullable), `floor` (text or int), `rooms` (numeric, nullable) to the Unit table — only the columns not already present.
2. A seed that inserts the 5 units with the confirmed unit_refs, correct property_id + org_id, derived floor, and the structural values Nils provides (see the seed data block — Nils fills m²/rooms before running).
3. Update the 3.1 composer test assertions that hardcoded `unit_count === 0` / empty `unit_refs` to the new truth (KO132 → 3, HHS55 → 2).
4. A seed-verification check: after seeding, `composePropertySnapshot(KO132)` → `unit_count === 3`, `unit_refs` === `["EG","1.OG","DG"]` (order-insensitive); `(HHS55)` → 2, `["1.OG","DG"]`.

---

## Out of scope

- The rent_roll module (3.2) — this only provides the inventory it enumerates.
- Per-unit rent/tenant data — that's claims, already handled by the resolver.
- Vacancy UI / Vermietungsquote rendering — later (3.3+); this task makes vacancy *computable* by establishing the denominator.
- Backfilling structural data for units beyond the known values — seed what's known, leave the rest nullable for Nils to complete later.
- Any other property's units (only KO132 + HHS55 exist as demo data).

---

## Files touched

- (Branch MIGRATE+SEED only) `supabase/migrations/<timestamp>_add_unit_structural_fields.sql`
- (Branch MIGRATE+SEED only) `prisma/schema.prisma` — add the columns to the Unit model, regenerate Prisma client
- A seed: either `prisma/seed-units.ts` (a standalone tsx seed script) or a SQL seed under `supabase/seed/` — match whatever seed convention the repo already uses (check in Step 0)
- `src/tests/composer/property-snapshot.test.ts` — update the unit_count/unit_refs assertions
- `ARCHITECTURE_STATE.md` — append section documenting the structural-vs-temporal-truth decision + the inventory

**NOT touched:** composer core logic (only its test assertions), resolvers, claim-store, Edge Function.

---

## Seed data block — Nils fills the m²/rooms before running

The unit_refs, property mapping, and floor are confirmed/derivable. **Nils provides `size_sqm` and `rooms` for the four units where they're not yet known** (one is known from Lena's lease). Do NOT fabricate these — leave as NULL if Nils hasn't provided them by run time; nullable columns allow it and they can be filled later without a migration.

| property | unit_ref | floor (derived) | size_sqm | rooms | source |
|----------|----------|-----------------|----------|-------|--------|
| KO132 | EG | ground (0) | _Nils_ | _Nils_ | — |
| KO132 | 1.OG | 1 | 100 | 3.5 | Everding Mietvertrag (known) |
| KO132 | DG | attic | _Nils_ | _Nils_ | — |
| HHS55 | 1.OG | 1 | _Nils_ | _Nils_ | — |
| HHS55 | DG | attic | _Nils_ | _Nils_ | — |

Constants:
- KO132 property_id: `f37448e4-11ae-453c-ac3c-850385039c0b`
- HHS55 property_id: `d2e8e9c7-957a-4e0f-8150-452c21bcae56`
- org_id (TEST_ORG_ID): `310131df-d6ed-4007-83c2-ac69a7e9df42`

Floor derivation from unit_ref (deterministic, not a guess — it's the literal meaning): `EG`→ground, `1.OG`→1, `2.OG`→2, `DG`→attic, `Keller`→basement, `Souterrain`→souterrain. Store whatever shape the `floor` column takes (label or int); be consistent.

KO132 total is ~280m²; if EG + DG split isn't known, leave them NULL rather than back-computing 280−100=180 split arbitrarily.

---

## Step 1 — (If needed) migration

```bash
supabase migration new add_unit_structural_fields
# edit the generated SQL: ALTER TABLE ... ADD COLUMN IF NOT EXISTS size_sqm numeric,
#   ADD COLUMN IF NOT EXISTS floor text, ADD COLUMN IF NOT EXISTS rooms numeric;
#   (only columns not already present; match the actual schema/quoting from Step 0)
git pull   # migration-discipline: ensure local main current before push
supabase db push
```

Add the same columns to `prisma/schema.prisma` Unit model, then `npx prisma generate`.

---

## Step 2 — Seed

Idempotent upsert (so re-running doesn't duplicate). Match the repo's seed convention. Example shape (adapt to schema + identifier column name from Step 0):

```typescript
// prisma/seed-units.ts (run: DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config prisma/seed-units.ts)
const UNITS = [
  { property_id: KO132, org_id: ORG, unit_ref: "EG",   floor: "ground", size_sqm: null, rooms: null },
  { property_id: KO132, org_id: ORG, unit_ref: "1.OG", floor: "1",      size_sqm: 100,  rooms: 3.5  },
  { property_id: KO132, org_id: ORG, unit_ref: "DG",   floor: "attic",  size_sqm: null, rooms: null },
  { property_id: HHS55, org_id: ORG, unit_ref: "1.OG", floor: "1",      size_sqm: null, rooms: null },
  { property_id: HHS55, org_id: ORG, unit_ref: "DG",   floor: "attic",  size_sqm: null, rooms: null },
];
// upsert each on (property_id, unit_ref)
```

Use upsert keyed on (property_id, unit_ref) so the seed is safe to re-run and Nils can update m²/rooms by editing values and re-running.

---

## Step 3 — Update the 3.1 composer test + verify

The 3.1 test hardcoded `unit_count === 0`. Flip those to the new truth:
- KO132: `unit_count === 3`, `unit_refs` contains exactly EG, 1.OG, DG
- HHS55: `unit_count === 2`, `unit_refs` contains exactly 1.OG, DG

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config prisma/seed-units.ts
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/composer/property-snapshot.test.ts | tail -25

# regression
for f in src/tests/composer/*.test.ts src/tests/resolvers/*.test.ts; do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -2
done
npx tsx tools/tenant-isolation-lint/index.ts | tail -5

# confirm the inventory landed (read-only)
echo "Verify: KO132 should show 3 units, HHS55 2 units"
```

---

## Step 4 — ARCHITECTURE_STATE.md + PR

```markdown
## Authoritative Unit inventory seeded (Task 3.1b, 2026-05-28)

Architecture decision: **unit existence is structural truth (Unit table); unit
facts are temporal truth (claims).** The rent_roll module (3.2) enumerates ALL
units from the Unit table and resolves each via rentForUnit; a unit with no
active claim is a VACANCY — a signal only an authoritative inventory can
surface. Claim-derived unit enumeration was rejected: vacant units produce no
claims and would be invisible, making Vermietungsquote/vacancy-detection
impossible.

- Unit table seeded: KO132 {EG, 1.OG, DG}, HHS55 {1.OG, DG} — 5 units
- Structural fields [added via migration if needed]: size_sqm, floor, rooms
  (nullable; seeded where known — KO132 1.OG = 100m²/3.5Zi from Everding lease;
  others NULL pending Nils)
- JOIN INVARIANT: unit_ref holds canonical values (EG/1.OG/DG) matching claim
  subjects (unit:<ref>). Divergence = silent false vacancy.
- composePropertySnapshot now reports KO132 unit_count 3, HHS55 2.

**Unblocks Task 3.2** (rent_roll module enumerates this inventory).
```

```bash
git add prisma/ supabase/ src/tests/composer/property-snapshot.test.ts ARCHITECTURE_STATE.md
git commit -m "feat(units): seed authoritative Unit inventory (Task 3.1b)

Establishes the Unit table as the authoritative unit inventory: KO132 {EG,
1.OG, DG}, HHS55 {1.OG, DG}. Unit existence is structural truth (Unit table);
unit facts stay temporal truth (claims). This unblocks the rent_roll module
(3.2), which enumerates ALL units and treats a unit with no active claim as a
vacancy — impossible to detect from claim-derived enumeration alone.

[if migration] Adds size_sqm/floor/rooms to the Unit model (nullable).
JOIN INVARIANT: unit_ref holds canonical values matching claim subjects.

composePropertySnapshot now reports KO132=3 units, HHS55=2 units; 3.1 test
assertions updated accordingly."
git push -u origin feature/task-3.1b-unit-inventory
```

---

## Definition of done

- [ ] Step 0: Unit model read; branch (seed-only vs migrate+seed) decided; identifier column + canonical-value invariant confirmed
- [ ] (if needed) migration via `supabase db push`, Prisma schema + client updated
- [ ] 5 units seeded, idempotent, correct property_id/org_id, canonical unit_refs
- [ ] floor derived; size_sqm/rooms seeded where known, NULL otherwise (no fabrication)
- [ ] 3.1 composer test assertions updated (KO132=3, HHS55=2) and passing
- [ ] tsc clean, composer + resolver regression passes, tenant-isolation clean
- [ ] PR merged → 3.2 unblocked

---

## Notes for reviewer

**The join invariant is the whole risk surface.** Everything else here is routine. The one way this task causes a silent bug is if the Unit identifier doesn't exactly match the claim-subject convention — then 3.2 resolves nothing for the mismatched unit and shows a real, occupied unit as vacant. Verify the seeded unit_refs are exactly `EG`/`1.OG`/`DG`/`1.OG`/`DG` and that 3.2 will join on the same string the claims use.

**No fabricated structural data.** Only KO132 1.OG (100m², 3.5 rooms) is known from a document. The other four units get NULL size_sqm/rooms until Nils provides them. Nullable columns make this clean; a follow-up edit + re-run of the idempotent seed fills them later. Inventing a 280−100 split across EG/DG would be exactly the kind of plausible-but-wrong data the PLZ verifier exists to catch — don't introduce it here.

**This makes vacancy computable, which is the real prize.** The reason Option B beats claim-derived enumeration isn't tidiness — it's that a Hausverwaltung's core job includes managing empty units, and you cannot manage what you cannot see. With the inventory authoritative, `rent_roll` iterates every unit and a `no_active_claim` resolver result becomes a visible vacancy row. That unlocks Vermietungsquote and vacancy-detection (both on the roadmap) for free in 3.2/3.3.

**Idempotent seed, not a one-shot insert.** Upsert on (property_id, unit_ref) so Nils can re-run it to fill in m²/rooms as he gathers them, and so it's safe in CI / fresh-DB setups. A plain INSERT would break on the second run and couldn't be used to update.
