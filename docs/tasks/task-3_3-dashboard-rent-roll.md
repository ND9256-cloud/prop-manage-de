# Task 3.3 — Dashboard rent roll renders from the composer

**Task type:** t1 (visual) + t2 (logic) — frontend + server-action wiring. **The first customer-facing surface that renders from resolved facts.** Requires review.

**Branch:** `feature/task-3.3-dashboard-rent-roll`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 3.3 acceptance criteria (line 647)
- Architecture §5.4.2 (three-component split — the dashboard consumes composer output, never raw claims/OCR), §5.4.7 (structurally debuggable — provenance click-through)
- **frontend-design skill** — READ IT before writing any component. This project's first real frontend task; commit to a deliberate aesthetic, avoid generic AI-dashboard look.
- **Precedents:** `src/lib/composer/property-snapshot.ts` + `modules/rent-roll.ts` (3.1/3.2 — the data source), `src/lib/dashboard-actions.ts` (the existing server action that currently reads document_intelligence), the existing dashboard at `/dashboard/warehouse` and rent-roll components
- This session's three product decisions (below) are settled — implement them, don't relitigate.

**What this delivers:** the dashboard rent roll rendering from `composePropertySnapshot(...)` instead of the legacy `document_intelligence` brain. Lena Everding's €650 appears as a clean row with a click-through provenance modal showing the source Mietvertrag. The architecture calls this "a significant moment" — the resolved-facts pipeline becomes something a customer sees.

---

## The three settled product decisions

**1. Composer-first, legacy fallback, "Legacy" tag.** The dashboard reads the composer as the primary source. If a cell has no composer-resolved value (composer gap during transition), fall back to the legacy `document_intelligence` value and tag that cell "Legacy". This is dark-launch / graceful-degradation: new path forward, old path as labeled fallback, removed once 3.4 (shadow mode) proves parity. The "Legacy" tag is an honesty signal showing where the composer still has gaps. NOT a full replace — full replace would pre-empt the 3.4 safety net.

**2. All units shown; vacancy reason inline AND actionable.** Every unit renders as a row, occupied or vacant (the inventory-as-truth decision). Vacancy reason is legible without a click:
- **Phantom vacancy** (`vacancy_reason: "no_data"`) → reads as a *task*, not a dead cell: "Kein Mietvertrag hinterlegt" with a subtle upload affordance / "Dokument hochladen" call-to-action on the row. This is the KO132 EG case.
- **Real vacancy** (`vacancy_reason: "tenancy_ended"`) → reads as a re-letting prompt: "Leerstand" (optionally "seit [date]" if available).
The principle: surface the next action at the point of the information — the rent roll becomes a worklist, not just a report. **Scope seam:** the row DISPLAYS the actionable phantom-vacancy CTA and links toward the existing upload flow; wiring a new upload action is OUT OF SCOPE (a small follow-up). The CTA points at the existing upload route if one exists, otherwise renders as a styled affordance with a `data-action="upload-lease"` hook for the follow-up to wire. Looks and reads right now; full wiring later.

**3. Vermietungsquote present but understated.** Show occupancy % as a small, quiet header stat — NOT a hero number. At 5 units a single vacancy swings it 20 points, so it must not carry visual weight disproportionate to its current signal. Present for when the portfolio grows; unobtrusive while the ratio is noisy.

---

## CRITICAL INVARIANT — do not break monitoring

The synthetic monitoring (Tier B Playwright, every 15min) asserts `data-testid="warehouse-properties-loaded"` on `/dashboard/warehouse`. **This attribute is INVARIANT — any refactor of the dashboard MUST preserve it** on the same element semantics (it signals "properties data has loaded"). If the rent roll moves or the load sequence changes, the testid must still fire when the data is ready. Breaking it silently breaks the deadman monitor. Verify it's present and functioning after the refactor.

---

## Step 0 — Read the existing surface BEFORE touching it

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-3.3-dashboard-rent-roll

# 1. The frontend skill (MANDATORY first read)
cat /mnt/skills/public/frontend-design/SKILL.md

# 2. The existing dashboard server action (currently reads document_intelligence)
echo "=== dashboard-actions.ts ==="
cat src/lib/dashboard-actions.ts

# 3. The existing dashboard page + rent-roll components (structure, the testid)
echo "=== dashboard pages/components ==="
find src/app src/components -path "*dashboard*" -name "*.tsx" | head -30
grep -rn "warehouse-properties-loaded\|data-testid\|document_intelligence\|rent" src/app/*dashboard* src/components/dashboard 2>/dev/null | head -25

# 4. The composer's public entry + RentRollSnapshot shape (the new data source)
echo "=== composer entry + rent-roll types ==="
grep -n "export.*composePropertySnapshot\|RentRollSnapshot\|RentRollRow\|occupancy_status\|vacancy_reason" src/lib/composer/property-snapshot.ts src/lib/composer/modules/rent-roll.ts

# 5. Design system: shadcn components available, Tailwind tokens, existing fonts
echo "=== design system ==="
ls src/components/ui/ 2>/dev/null | head -30
grep -n "fontFamily\|--font\|theme\|colors" tailwind.config.* app/globals.css src/app/globals.css 2>/dev/null | head -20

# 6. How server components/actions call into lib (is composer callable from a server action? it reads the DB)
echo "=== server action pattern ==="
grep -rn "\"use server\"\|use server\|async function" src/lib/dashboard-actions.ts | head
```

**Reconcile before building:**
- The composer reads the DB — confirm it can be called from the dashboard's server action / server component context (it should; resolvers do). The dashboard calls `composePropertySnapshot({ property_id, org_id, modules: ["rent_roll"] })` server-side, passes the resulting `RentRollSnapshot` to the client component.
- Find the EXACT element carrying `warehouse-properties-loaded` and preserve it.
- Inventory the existing shadcn/ui components (new-york, neutral per the stack) and the current fonts/tokens — build WITHIN the existing design system; this is a refactor of a real product surface, not a greenfield artifact. Apply the frontend-design skill's *restraint* guidance (this is a refined data-dense operator tool, not a maximalist landing page — precision, careful spacing/typography, subtle motion; NOT decorative chaos).

---

## Scope

1. **Server action**: refactor `src/lib/dashboard-actions.ts` (or add a new action) so the rent-roll data comes from `composePropertySnapshot(...)`. For each cell, if the composer returns a resolved value, use it; if not, fall back to the legacy `document_intelligence` read and mark the cell `source: "legacy"`.
2. **Rent-roll component**: render one row per unit from the `RentRollSnapshot`:
   - Occupied → kaltmiete value, tenant (if available; tenant_active is currently "unavailable" per 3.2 — render gracefully, e.g. "—" or "Mieter: n/a", no fake data), confidence indicator if not high
   - Phantom vacancy → "Kein Mietvertrag hinterlegt" + upload CTA affordance (`data-action="upload-lease"`, links to existing upload route if present)
   - Real vacancy → "Leerstand" (+ since-date if available)
   - "Legacy" tag on any cell sourced from fallback
   - Click-through **provenance modal**: clicking a resolved value opens a modal showing the source document(s) and the resolved fact's provenance (claim ids → document → quotes). Lena's €650 → modal shows the source Mietvertrag.
3. **Header stat**: understated Vermietungsquote (small, secondary).
4. **Loading state** while the composer runs.
5. Preserve `data-testid="warehouse-properties-loaded"`.

---

## Out of scope

- **Wiring a NEW upload action** — the phantom-vacancy CTA displays + links to the existing upload route or carries the `data-action` hook; building new upload plumbing is a follow-up.
- **tenant_active resolution** — the tenant column shows gracefully-absent until the tenant resolver ships (3.2 follow-up). Don't fake it.
- **ownership / insurance / costs modules on the dashboard** — rent_roll only.
- **Removing the legacy `document_intelligence` read** — that happens after 3.4 shadow mode proves parity. 3.3 keeps it as fallback.
- **Provenance modal deep features** (PDF preview, bbox highlighting) — modal shows source document name/link + quotes/claim ids; rich preview is later polish.
- **Editing/correcting values from the dashboard** — read-only render this task.
- **Mobile-specific layout** — desktop operator tool first; don't break mobile, but don't over-invest.

---

## Files touched

- `src/lib/dashboard-actions.ts` — composer-first data, legacy fallback
- `src/app/(dashboard)/.../rent-roll` page/component(s) — render from RentRollSnapshot (exact paths from Step 0)
- `src/components/dashboard/...` — rent-roll row component, provenance modal component (new)
- Possibly `src/components/ui/...` — only if a needed primitive (e.g. dialog) isn't already present
- UI tests — existing pass + new test for Lena's €650 + provenance modal
- `ARCHITECTURE_STATE.md` — append section

**NOT touched:** composer, resolvers, claim-store, Edge Function, Unit/schema, the monitoring config (only preserve its testid).

---

## Step 1-N — Build (apply frontend-design skill)

Aesthetic direction: this is a **refined, data-dense operator instrument** — a Hausverwaltung professional runs their portfolio from it. Think Linear/Stripe-dashboard restraint, not a marketing page. Precision typography, clear hierarchy, calm color with sharp accents for state (occupied/vacant/needs-review/legacy), subtle motion on load and modal open. The "one memorable thing": the provenance click-through — every number is traceable to its source document in one click, which is the product's whole trust proposition (evidence chains as legal shields). Make that interaction feel solid and instant.

Build within the existing shadcn/ui + Tailwind v4 design system and the existing fonts (don't introduce a clashing display font into a live product surface; refine within the established system). Row states should be instantly legible:
- occupied: value prominent, calm
- phantom vacancy: muted + an actionable accent (upload CTA)
- real vacancy: muted, "Leerstand"
- needs_review: a subtle warning accent (shouldn't appear for Lena now that dupes are cleaned, but the state must render correctly if it occurs)
- legacy-sourced cell: small "Legacy" chip

Provenance modal: opens on value click, shows the fact (e.g. "Kaltmiete €650, gültig ab 01.04.2025"), confidence, and the source — document name/type linking to the document, plus the supporting quote/claim id(s) from the ResolvedFact's provenance. Keep it clean and fast.

German UI strings (the product is German-market; the existing surface's language convention from Step 0 governs — match it; i18n is a later task per the deferred list).

---

## Step N+1 — Tests + verify

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
# existing UI tests must pass
<the repo's UI/component test command from Step 0> 2>&1 | tail -20
# new test: KO132 dashboard shows Lena €650 + provenance modal shows source Mietvertrag
# (Playwright or component test, matching the repo's existing harness)

# regression on composer (unchanged, but confirm nothing imported broke)
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/composer/rent-roll.test.ts | tail -5
npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

Manually (or via Playwright) confirm on `/dashboard/warehouse` (or the property rent-roll route):
- KO132: 1.OG shows €650 (clean, no review flag — dupes were cleaned), EG shows phantom-vacancy with upload CTA, DG shows its value
- Clicking €650 opens the provenance modal naming the source Mietvertrag
- `data-testid="warehouse-properties-loaded"` still fires
- Vermietungsquote shows understated in the header

---

## Step N+2 — PR

```bash
git add src/lib/dashboard-actions.ts src/app src/components src/tests ARCHITECTURE_STATE.md
git commit -m "feat(dashboard): rent roll renders from composer with provenance (Task 3.3)

The first customer-facing surface rendering from resolved facts instead of the
legacy document_intelligence brain.

- dashboard-actions: composer-first (composePropertySnapshot rent_roll module),
  legacy document_intelligence as fallback with a 'Legacy' cell tag during the
  3.4 shadow-mode transition (dark-launch pattern; legacy read removed after
  parity is proven)
- rent roll renders one row per unit (inventory-as-truth): occupied shows
  kaltmiete; phantom vacancy (no_data) reads as an actionable 'Kein Mietvertrag
  hinterlegt' + upload CTA; real vacancy (tenancy_ended) reads as 'Leerstand'
- click-through provenance modal: clicking a value shows the source document(s)
  and supporting evidence — Lena Everding €650 → source Mietvertrag
- understated Vermietungsquote header stat
- preserves data-testid=warehouse-properties-loaded (synthetic monitoring invariant)
- tenant column renders gracefully-absent (tenant resolver is a 3.2 follow-up)

Upload action wiring is a follow-up; row displays the CTA + hook.

Unblocks 3.4 (shadow mode)."
git push -u origin feature/task-3.3-dashboard-rent-roll
```

PR: `https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-3.3-dashboard-rent-roll`

---

## Definition of done

- [ ] frontend-design skill read; aesthetic is refined operator-tool restraint within the existing design system
- [ ] Step 0: existing dashboard structure, server action, composer entry, the testid, design tokens all confirmed
- [ ] rent roll renders from composePropertySnapshot rent_roll module
- [ ] composer-first with legacy fallback + "Legacy" cell tag
- [ ] all units shown; phantom vacancy actionable (upload CTA + hook), real vacancy as Leerstand
- [ ] provenance modal: Lena €650 → source Mietvertrag, with claim/document provenance
- [ ] Vermietungsquote understated header stat
- [ ] loading state present
- [ ] `data-testid="warehouse-properties-loaded"` preserved + verified
- [ ] tenant column gracefully-absent (no faked data)
- [ ] tsc clean, existing UI tests pass, new Lena-provenance test passes, composer regression + tenant-isolation clean
- [ ] PR merged → 3.4 unblocked

---

## Notes for reviewer

**This is the trust-proposition surface.** The product's moat is evidence chains as legal shields. The provenance click-through is where that becomes tangible to a user: every number traces to its source document in one click. If one interaction gets disproportionate polish, it's this one — it must feel instant and solid, because it's the visible embodiment of "correctness over speed."

**Composer-first, not composer-only, is deliberate.** The legacy fallback + "Legacy" tag is the dark-launch safety net, not indecision. It lets 3.4 run shadow-mode comparison with the customer already seeing the composer where it's confident, and the labeled fallback where it isn't — which doubles as a live map of composer gaps. The legacy read gets deleted after 3.4 proves parity, not before. A full replace now would bet the customer surface on unproven parity.

**The phantom vacancy as worklist item is the product-defining choice.** A lesser rent roll shows "vacant" and stops. This one shows "no lease on file → upload" — turning a data gap into a one-click action at the point of information. That's the difference between a report a Hausverwalter checks and a tool they run the business from. The upload wiring is a follow-up, but the row must *read* as actionable now, or the design intent is lost.

**Don't fake the tenant column.** tenant_active is "unavailable" until its resolver ships (3.2 follow-up). Render an honest absence ("—" / "n/a"), never a tenant name pulled through a side channel. An honest gap beats invented data — same principle as the 3.2 tenant-column discipline.

**Preserve the monitoring testid or you blind the deadman.** `warehouse-properties-loaded` is asserted every 15 minutes by Tier B synthetic monitoring. A refactor that drops or moves it silently breaks the monitor — you'd lose the canary without knowing. Verify it fires after the refactor.

**Restraint is the right aesthetic.** The frontend-design skill pushes bold direction — here "bold" means disciplined precision, not decoration. This is a dense operator instrument handling someone's livelihood; legibility, calm hierarchy, and one solid signature interaction (provenance) beat visual flourish. Match and refine the existing design system rather than introducing a clashing new look into a live product.
