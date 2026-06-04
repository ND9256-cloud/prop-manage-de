# Task 3.4 — Legacy brain shadow mode

**Task type:** t2 M (parallel-run safety net; nightly comparison job; closes the loop for retiring legacy brain post-launch)

**Branch:** `feature/task-3.4-shadow-mode`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 3.4 acceptance criteria (line 667)
- Architecture §5.4.9 (migration kill-switch / shadow mode)
- 3.3's three discovered divergences (top stats 100% vs composer 33%; DG legacy knew Saniye Kuru vs composer phantom vacancy; EG same class) — **these aren't bugs, they're exactly the signal this task formalizes.** The comparison must capture them, not hide them.
- **Precedents:** the legacy brain at `scripts/generate-brain.js` (current scheduled writer to `document_intelligence`/`property_intelligence`), the composer entry `src/lib/composer/property-snapshot.ts`, the rent-roll module's RentRollSnapshot shape, the Discord typed-notifications already used by synthetic monitoring (Tier B Playwright deadman) — reuse that webhook helper rather than building new

**What this delivers:** the safety net that lets you retire the legacy brain with evidence. A nightly job runs composer + legacy brain in parallel for each property, diffs the rent-roll values, writes divergences to `brain_shadow_comparison`, and alerts Discord when divergence count exceeds threshold. After 30 days of stable, explainable comparison, you can delete the legacy brain with confidence rather than hope. Customer-facing surfaces continue to read composer only — the legacy is *running* in the background, *not displayed*.

---

## The mental model — what "stable" means

Shadow mode isn't "wait until composer and legacy produce identical output." They WILL diverge — and we already know three ways:

1. **Composer says vacant where legacy says occupied** (KO132 EG, DG): the v2 claims pipeline hasn't ingested those leases. Composer is *more correct* (it tells the operator to upload the document); legacy hallucinated occupancy from a stale snapshot.
2. **Composer math vs legacy aggregate disagree** (33% vs 100% Vermietungsquote): composer denominator includes unclaimed units. Legacy didn't have the inventory-as-truth distinction.
3. **Composer rejects bad data legacy accepted** (e.g. PLZ verifier rejecting 36270 hallucinations): composer is stricter.

"Stable" means: every divergence has an **explained class** (one of the categories above, or a new one we triage and decide on). Not zero divergences — that would only happen if composer and legacy were doing the same thing, which would defeat the point of v2.

The comparison schema and Discord alert text must reflect this: classify divergences by *type*, surface unfamiliar classes as alerts (true unknowns), suppress known-class divergences as informational (the system working).

---

## Step 0 — Verify shipped contracts BEFORE writing code

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-3.4-shadow-mode

# 1. The legacy brain script — schedule, output table, output shape per property
echo "=== legacy brain script ==="
ls scripts/
cat scripts/generate-brain.js 2>/dev/null | head -80
grep -rn "document_intelligence\|property_intelligence\|generate-brain\|brain.*schedule" supabase scripts cron 2>/dev/null | head -10

# 2. Composer entry + RentRollSnapshot shape (for the comparison side)
echo "=== composer entry + rent-roll shape ==="
grep -n "composePropertySnapshot\|RentRollSnapshot\|RentRollRow" src/lib/composer/property-snapshot.ts src/lib/composer/modules/rent-roll.ts | head -20

# 3. The Discord webhook helper used by synthetic monitoring (reuse, don't rebuild)
echo "=== Discord webhook ==="
grep -rn "DISCORD_WEBHOOK\|discord.*notif\|notifyDiscord\|postToDiscord" src/lib scripts | head -10
ls -la scripts/ | grep -i "monitor\|notif\|discord"

# 4. Existing migration pattern (we'll add a brain_shadow_comparison table)
echo "=== migration discipline ==="
ls supabase/migrations/ | tail -10
grep -rn "supabase db push\|supabase migration new" docs/ 2>/dev/null | head -5

# 5. The scheduling mechanism (Vercel cron, GitHub Actions schedule, Supabase scheduled functions?)
echo "=== existing scheduled jobs ==="
ls .github/workflows/ 2>/dev/null | grep -i "cron\|schedule\|nightly\|monitor"
find . -name "vercel.json" -not -path "*/node_modules/*" -exec cat {} \;
```

**Reconcile before coding. Critical confirmations:**
- **Legacy brain's actual output table + per-property shape.** The brief mentions `document_intelligence` and `property_intelligence` (both exist in code). Confirm which the legacy brain currently writes to and what its rent-roll equivalent looks like — the comparison needs to read it. The dashboard fallback (`getRentRollSnapshots` in dashboard-actions.ts) already extracts a legacy-rent-roll-per-unit shape (`extractLegacyTenants`) — **reuse that extractor** rather than rewriting it.
- **The schedule mechanism.** "Nightly" must run somewhere. GitHub Actions cron is the cleanest if no other scheduler exists (you already use it for CI). Vercel cron is another option. Supabase scheduled functions a third. Pick what's already wired; don't introduce a new infra component for this.
- **Discord webhook helper.** Memory says "typed Discord notifications" already exist from the synthetic monitoring work — confirm the helper's signature and reuse it. New webhook code = new failure mode.
- **Migration discipline.** `brain_shadow_comparison` is a new table → migration via `supabase migration new ... && supabase db push`, `git pull` first.

---

## Scope

1. **Migration** for `warehouse.brain_shadow_comparison` (or `public.` — match the existing convention from Step 0):
   - `id` (uuid PK), `run_at` (timestamptz default now()), `property_id` (uuid), `org_id` (uuid), `unit_ref` (text nullable — for per-unit diffs; null for property-aggregate diffs like Vermietungsquote), `divergent_field` (text — e.g. `kaltmiete`, `occupancy_status`, `vermietungsquote`), `composer_value` (jsonb), `legacy_value` (jsonb), `divergence_class` (text — see classifications below), `notes` (text nullable). Indexed on `run_at` and `property_id`.

2. **`scripts/brain-shadow-comparison.ts`** — the comparison job:
   - For each property in the org's inventory, call `composePropertySnapshot({ property_id, org_id, modules: ['rent_roll'] })` (per Step 0's existing pattern in dashboard-actions.ts)
   - Read the legacy brain's per-unit rent roll from `property_intelligence` (or wherever Step 0 confirms)
   - For each unit_ref in the property, diff the values per field: `kaltmiete`, `occupancy_status`, `tenant_name` (if legacy has it)
   - Per-property: diff aggregate `vermietungsquote`, `total_kaltmiete`
   - Classify each divergence (see "Divergence classification" below)
   - Insert one row per divergence into `brain_shadow_comparison`
   - At end: total divergences by class; if **`unknown` class count > 0** OR total exceeds a TBD threshold (start with 10 unknowns/run), post a Discord alert with a summary + a link to the comparison table for that run

3. **Divergence classification function** — pure, testable:
   - `composer_vacant_legacy_occupied` — composer says no_data/tenancy_ended, legacy shows an occupied tenant. Known class: ingestion gap. Informational.
   - `composer_occupied_legacy_vacant` — opposite. Known class: legacy stale. Informational.
   - `kaltmiete_amount_mismatch` — both occupied, different amounts. **Investigate** — usually means a Mieterhöhung hit one side but not the other.
   - `vermietungsquote_mismatch` — known math difference. Informational.
   - `total_kaltmiete_mismatch` — derives from the per-unit diffs; usually redundant but recorded.
   - `unknown` — anything not matching the classes above. **This is the alert trigger.**

4. **Discord alert** (only when `unknown` count > 0 or total > threshold) — short, scannable, with the run timestamp and counts per class, and an instruction to look at the `brain_shadow_comparison` table. Reuse the existing Discord helper.

5. **Schedule the job nightly** — GitHub Actions cron (most likely from Step 0). Use a workflow file like `.github/workflows/brain-shadow-comparison.yml` triggered on a `schedule:` cron expression (e.g. `0 2 * * *` — 02:00 UTC daily).

6. **A test fixture + unit test** for the classification function — assert each of the three known divergences we've already seen (KO132 EG, KO132 DG, top-stats math) classifies into a known (informational) class, not `unknown`.

---

## Out of scope

- **Deleting the legacy brain** — explicitly future. The plan says "After 30 days of stable comparison, the legacy brain can be deleted (separate task, post-launch)." Not this task.
- **Migrating top stats to the composer** — that's a 3.3 follow-up. The shadow comparison records the math divergence as informational; doesn't fix it.
- **Wiring the upload action** that the phantom-vacancy CTA needs — separate small task.
- **Customer-facing changes** — surfaces continue to read composer only. The legacy brain runs silently in the background.
- **Auto-resolution of divergences** — humans triage; the job classifies and surfaces. No auto-fixing.
- **Fancy Discord alert formatting** — short, scannable, link-to-table. Not a dashboard.

---

## Files touched

- `supabase/migrations/<timestamp>_brain_shadow_comparison.sql`
- `prisma/schema.prisma` — add the table model
- `scripts/brain-shadow-comparison.ts` — the job
- `scripts/lib/brain-shadow-classify.ts` — pure classification function (testable)
- `src/tests/scripts/brain-shadow-classify.test.ts` — classification unit tests + the three known-divergence fixtures
- `.github/workflows/brain-shadow-comparison.yml` — the nightly schedule
- `ARCHITECTURE_STATE.md` — append section

**NOT touched:** composer (unchanged), dashboard (still composer-first), legacy brain script (still runs unchanged), production code paths.

---

## Divergence classification — detail

The classifier takes a per-unit pair `(composerRow | null, legacyRow | null)` and returns `{ class, divergent_field, composer_value, legacy_value }[]` (an empty array means agreement). Per-property aggregates (vermietungsquote, total) classify similarly.

Rules:
- Composer has row, legacy doesn't → unit exists in inventory but legacy never knew → `legacy_missing_unit` (known class — legacy was stale or unit was added; informational)
- Composer doesn't have row, legacy does → composer's Unit table is missing a unit legacy knew about → `composer_missing_unit` (known but **investigate** — inventory gap)
- Both have rows:
  - Composer `occupancy_status === "vacant"` (any reason) AND legacy shows tenant name → `composer_vacant_legacy_occupied` (the KO132 EG/DG case)
  - Composer `occupancy_status === "occupied"` AND legacy shows no tenant / empty → `composer_occupied_legacy_vacant`
  - Both occupied, different kaltmiete amount (tolerance: exact match required) → `kaltmiete_amount_mismatch` (the highest-priority divergence — alerts)
  - Both occupied, same kaltmiete → agreement; no record written
- Property aggregates: `vermietungsquote_mismatch`, `total_kaltmiete_mismatch` — informational

The known classes are informational. `kaltmiete_amount_mismatch` and `composer_missing_unit` alert. `unknown` (anything not matching above) always alerts.

---

## Step 1 — Migration

```bash
supabase migration new brain_shadow_comparison
# Edit the SQL: CREATE TABLE warehouse.brain_shadow_comparison (
#   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
#   run_at timestamptz NOT NULL DEFAULT now(),
#   org_id uuid NOT NULL,
#   property_id uuid NOT NULL REFERENCES public."Property"(id),
#   unit_ref text,
#   divergent_field text NOT NULL,
#   composer_value jsonb,
#   legacy_value jsonb,
#   divergence_class text NOT NULL,
#   notes text
# );
# CREATE INDEX ON warehouse.brain_shadow_comparison (run_at DESC);
# CREATE INDEX ON warehouse.brain_shadow_comparison (property_id, run_at DESC);
# CREATE INDEX ON warehouse.brain_shadow_comparison (divergence_class);
git pull   # the May 25 stale-deploy rule applies to migrations too
supabase db push
```

Add the matching model to `prisma/schema.prisma`, `npx prisma generate`.

---

## Step 2 — Classifier (pure)

```typescript
// scripts/lib/brain-shadow-classify.ts
//
// Pure classification of composer-vs-legacy divergences. No I/O. The whole
// point: a known-class divergence is INFORMATIONAL (the system working as
// designed — legacy and composer have different correctness properties).
// Only "unknown" class divergences alert; kaltmiete_amount_mismatch and
// composer_missing_unit alert because they suggest real ingestion or
// pipeline issues.

export type DivergenceClass =
  | "composer_vacant_legacy_occupied"
  | "composer_occupied_legacy_vacant"
  | "kaltmiete_amount_mismatch"
  | "legacy_missing_unit"
  | "composer_missing_unit"
  | "vermietungsquote_mismatch"
  | "total_kaltmiete_mismatch"
  | "unknown";

export interface Divergence {
  divergent_field: string;
  composer_value: unknown;
  legacy_value: unknown;
  divergence_class: DivergenceClass;
  unit_ref: string | null;
  alert: boolean;  // true → counts toward Discord alert; false → informational
}

export function classifyUnitPair(
  unit_ref: string,
  composer: { occupancy_status: string; kaltmiete_amount: number | null; tenant_name: string | null } | null,
  legacy: { tenant_name: string | null; kaltmiete_amount: number | null } | null
): Divergence[] {
  // ... rules per the section above
}

export function classifyAggregate(
  composer: { vermietungsquote: number; total_kaltmiete: number },
  legacy: { vermietungsquote: number | null; total_kaltmiete: number | null }
): Divergence[] {
  // ...
}

const ALERT_CLASSES = new Set<DivergenceClass>([
  "kaltmiete_amount_mismatch",
  "composer_missing_unit",
  "unknown",
]);
```

The exported `ALERT_CLASSES` set is the single source of truth for "what triggers Discord."

---

## Step 3 — The job

```typescript
// scripts/brain-shadow-comparison.ts
// Run via:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/brain-shadow-comparison.ts
// Scheduled nightly via .github/workflows/brain-shadow-comparison.yml.

// Flow:
//  1. Enumerate all properties across all orgs (or one org if env var set — useful for local runs)
//  2. For each property: composePropertySnapshot + legacy brain extract (reuse extractLegacyTenants from dashboard-actions if exported, or inline-copy)
//  3. Classify per-unit and aggregate
//  4. Bulk insert divergences into warehouse.brain_shadow_comparison with this run's timestamp
//  5. Count alerts (divergences where alert: true); if > 0, post Discord
```

Reuse the existing Discord helper from synthetic monitoring (whatever Step 0 found). Alert format (short):

```
🔍 Shadow comparison — 2026-05-29 02:00 UTC
Properties scanned: <n>
Divergences total: <n>  (alert: <m>)
By class:
  composer_vacant_legacy_occupied: <n>  (informational)
  kaltmiete_amount_mismatch: <n>  ← needs attention
  composer_missing_unit: <n>  ← needs attention
  ...
SQL: SELECT * FROM warehouse.brain_shadow_comparison WHERE run_at = '<ts>';
```

---

## Step 4 — Tests

`src/tests/scripts/brain-shadow-classify.test.ts`, ≥12 assertions covering:

1. **The KO132 EG case** — composer `{occupancy_status: "vacant", kaltmiete_amount: null}`, legacy `{tenant_name: "Julija Paul", kaltmiete_amount: 57500}` → exactly one divergence with class `composer_vacant_legacy_occupied`, `alert: false`.
2. **The KO132 DG case** — composer vacant, legacy `{tenant_name: "Saniye Kuru", kaltmiete_amount: 47000}` → same class, alert: false.
3. **A genuine kaltmiete mismatch** — both occupied but different amounts → `kaltmiete_amount_mismatch`, **alert: true**.
4. **Agreement** — both occupied, same tenant, same amount → empty divergence array.
5. **Vermietungsquote mismatch** (the 33% vs 100% case) → `vermietungsquote_mismatch`, alert: false.
6. **Unit missing from composer** but in legacy → `composer_missing_unit`, alert: true.
7. **Unknown class** — a structurally weird input → `unknown`, alert: true.

The test asserts the three real divergences we already saw classify as known/informational, not unknown — proves the classifier handles current reality without alerting.

---

## Step 5 — Schedule

`.github/workflows/brain-shadow-comparison.yml`:

```yaml
name: Brain Shadow Comparison
on:
  schedule:
    - cron: '0 2 * * *'    # 02:00 UTC daily
  workflow_dispatch:       # also manually triggerable
jobs:
  compare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx tsx -r dotenv/config scripts/brain-shadow-comparison.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DIRECT_URL: ${{ secrets.DIRECT_URL }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          # ... whatever the existing monitoring workflow uses
```

Copy the secret/env list from the synthetic monitoring workflow rather than guessing — that workflow already runs against the same backend.

---

## Step 6 — ARCHITECTURE_STATE.md + PR

```markdown
## Brain shadow mode shipped (Task 3.4, 2026-05-28)

Parallel-run safety net. A nightly GitHub Actions job runs the composer and
legacy brain side-by-side per property, classifies divergences, writes them
to warehouse.brain_shadow_comparison, and posts a Discord alert when any
divergence falls into the alert classes (kaltmiete_amount_mismatch,
composer_missing_unit, unknown).

The framing: shadow mode is NOT "wait for identical output." Composer and
legacy SHOULD diverge in known ways (composer is more honest about ingestion
gaps; composer rejects bad data legacy accepted). Stable = every divergence
falls into a known class. Unknown classes alert.

Known informational classes:
- composer_vacant_legacy_occupied (ingestion gap — composer correctly says
  "no lease on file"; legacy hallucinates occupancy from stale data)
- composer_occupied_legacy_vacant (legacy stale)
- legacy_missing_unit (legacy didn't know about a unit in the inventory)
- vermietungsquote_mismatch, total_kaltmiete_mismatch (aggregate math
  consequences of the per-unit differences)

Alert classes:
- kaltmiete_amount_mismatch (both sides occupied, different rent)
- composer_missing_unit (composer's Unit table lacks a unit legacy knew)
- unknown (genuinely unclassified)

The three already-known divergences from 3.3 (KO132 EG, KO132 DG, top-stats
math) classify as known/informational; comparison runs without alerts in the
current state. Cleanup of the latent applier dedup bug (same-document
reprocessing → duplicate active claims) is the most likely source of future
kaltmiete_amount_mismatch alerts; should be fixed pre-customer.

After ~30 days of stable comparison, the legacy brain can be retired
(separate task, post-launch).

**Unblocks Task 3.5** (presenter, LLM render-only).
```

```bash
git add supabase/migrations/ prisma/schema.prisma \
        scripts/brain-shadow-comparison.ts scripts/lib/brain-shadow-classify.ts \
        src/tests/scripts/brain-shadow-classify.test.ts \
        .github/workflows/brain-shadow-comparison.yml \
        ARCHITECTURE_STATE.md
git commit -m "feat(shadow-mode): nightly composer-vs-legacy comparison + Discord alerts (Task 3.4)

Parallel-run safety net. Nightly GitHub Actions job runs composer + legacy
brain per property, classifies divergences, writes to
warehouse.brain_shadow_comparison, alerts Discord on alert-class divergences.

Shadow mode is NOT wait-for-identical-output. Composer and legacy SHOULD
diverge in known ways:
- composer_vacant_legacy_occupied: composer correctly surfaces ingestion gaps
  (no claim on file); legacy hallucinated occupancy from stale data
- composer_occupied_legacy_vacant: legacy stale
- vermietungsquote_mismatch: aggregate math difference

These are informational. Alerts fire for:
- kaltmiete_amount_mismatch: both occupied, different rent (real bug signal)
- composer_missing_unit: Unit inventory gap
- unknown: genuinely unclassified

The three divergences already known from 3.3 (KO132 EG/DG phantom vacancies,
top-stats 100%-vs-33%) classify as informational — no alert in current state.

After ~30 days stable, legacy brain can be retired (separate post-launch task).

Unblocks 3.5 (presenter)."
git push -u origin feature/task-3.4-shadow-mode
```

PR: `https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-3.4-shadow-mode`

---

## Definition of done

- [ ] Step 0: legacy brain output table + shape, schedule mechanism, Discord helper, migration discipline all confirmed
- [ ] `brain_shadow_comparison` table migration applied via `supabase db push`
- [ ] Classifier is pure, returns the right class for the three known divergences (KO132 EG, DG, top-stats)
- [ ] Comparison job runs end-to-end against real data, writes rows, posts Discord on alert
- [ ] Classifier tests ≥12 assertions pass; three known cases verified non-alerting
- [ ] GitHub Actions nightly schedule live (workflow file in `.github/workflows/`)
- [ ] tsc clean, regression passes, tenant-isolation clean
- [ ] PR merged

---

## Notes for reviewer

**The framing is the whole task.** A naive shadow mode would be "alert on every divergence" — which would alert constantly (the system is *correctly* surfacing legacy's stale data and the composer's honest ingestion gaps). Classifying divergences by *type* and alerting only on unexplained classes is what makes shadow mode a useful signal instead of noise. The three known divergences from 3.3 are the proof: they classify as informational because we already understand them; new classes alert because we don't.

**Reuse, don't rebuild.** The dashboard-actions.ts already extracts a legacy-rent-roll-per-unit shape via `extractLegacyTenants`. The synthetic monitoring already uses a typed Discord webhook. The composer is callable from anywhere. This task should add the comparison job + classifier + table + workflow — not reimplement legacy parsing or Discord plumbing.

**Migration discipline applies.** `supabase migration new` + edit + `supabase db push`, with `git pull` first. This is the established pattern; same risk class as the May 25 stale-deploy trap.

**The DG and top-stats discoveries inform thresholds, not alerts.** Both are recorded as informational in the first run; if KO132 DG suddenly *stops* showing the divergence (because Saniye Kuru's lease got ingested), the row simply stops appearing — no alert needed for "things got better." Conversely, if a new property comes online and shows divergences in an unknown class, that's the alert that tells you to investigate. The signal direction is asymmetric on purpose.

**Stable ≠ silent.** "30 days of stable comparison → retire legacy" means 30 days where every divergence falls into a known class. Not zero divergences. The retirement task is post-launch and explicit (this task doesn't try to do it).

**Future kaltmiete_amount_mismatch alerts will most likely surface the dedup bug.** When the latent applier dedup bug (same-document reprocessing → duplicate active claims → conflict status → resolver returns ambiguous amount) hits real data, the divergence will be a kaltmiete_amount_mismatch — and the alert will correctly say "investigate." Worth being aware: the alert system will catch its first real symptom before the fix lands.
