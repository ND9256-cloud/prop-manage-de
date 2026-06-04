# Task 2.4 — Übergabeprotokoll emitter (dispatch on `uebergabe_typ`)

**Task type:** t2 M (new emitter; introduces multi-branch dispatch + the Hofmann safeguard in code; requires review before merge)

**Branch:** `feature/task-2.4-uebergabeprotokoll-emitter`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.4 acceptance criteria
- Architecture §4.5 (doc-type taxonomy + Übergabeprotokoll dispatch), §5.5.2 (closing matrix), §5.5.3 (close_modes), §5.5.4 (applier safety rules — Hofmann), §5.5.5 (claim-aware blockers)
- `domain_knowledge/wohnungsuebergabeprotokoll.md` (Task 1.4 — the `closes` array + Hofmann gotcha)
- `schemas/wohnungsuebergabeprotokoll/schema.yaml` (Task 2.3 — the field set this emitter reads)
- **Precedent to mirror exactly:** `src/lib/emitters/mieterhoehung.ts` (Task 2.1 — same EmissionResult/Claim/ClaimClosure types, same purity contract, same "event claim required when closure present" rule)

**What this delivers:** the third emitter, and the one where the **Hofmann safeguard becomes structural code**. The emitter dispatches on `uebergabe_typ` into four branches. Eigentümerwechsel must NEVER emit tenant-claim closures (BGB §566). The applier (Task 1.8) already has the backstop blocker (`vacant_possession_warning`, verified in its Scenario 7 test), so this is defense in depth: emitter doesn't generate the bad intent; applier rejects it if it ever appears.

---

## Step 0 — Verify shipped contracts BEFORE writing code

Task 2.2 taught us the plan spec predates the code. Confirm the exact shapes first:

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-2.4-uebergabeprotokoll-emitter

# 1. Claim + ClaimClosure + EmissionResult + EmitterContext types
echo "=== emitters/types.ts ==="
cat src/lib/emitters/types.ts

# 2. The Mieterhöhung emitter (the exact pattern to mirror)
echo "=== mieterhoehung.ts full ==="
cat src/lib/emitters/mieterhoehung.ts

# 3. How the applier dispatches blocker checks on the event claim predicate
echo "=== applier event-claim dispatch ==="
grep -n "predicate\|event\|trigger\|reason_claim" src/lib/claim-store/applier.ts | head -30

# 4. The closes array in domain knowledge (confirm predicate names)
echo "=== domain knowledge closes ==="
grep -A 40 "^closes:" domain_knowledge/wohnungsuebergabeprotokoll.md

# 5. Generated field labels for the schema (confirm field id names)
echo "=== generated field labels ==="
cat schemas/wohnungsuebergabeprotokoll/generated/field_labels.json
```

**Reconcile before coding.** If any of these differ from the assumptions below, the actual code wins — adjust the emitter to match. Specifically confirm:
- The exact `ClaimClosure` field names (`target_subject`, `target_predicates[]`, `close_at`, `close_mode`, `match`, `match_strictness`, `blocker_status`)
- Whether the applier truly requires exactly one event claim per closure (Mieterhöhung's comment says so)
- The schema field id for the handover date: Task 2.3 used `uebergabe_datum` (NOT `inspection_date`)
- Whether an `owner` predicate + owner resolver already exists, or this is the first owner claim

---

## Scope

`src/lib/emitters/wohnungsuebergabeprotokoll.ts` — a pure function dispatching on `uebergabe_typ`:

**Einzug** → emit one `tenant_active` event claim for `unit:<unit_ref>` (tenant = `mieter_in`); `valid_from = uebergabe_datum`. No closures.

**Auszug** → emit one `lease_terminated` event claim for `unit:<unit_ref>` PLUS closure intents (`close_overlapping_and_future`, `close_at = uebergabe_datum`) for these predicates on the unit: `kaltmiete`, `tenant_active`, `kaution`, `nebenkostenvorauszahlung`. Tenant match against `mieter_out` with required strictness.

**Eigentümerwechsel** → emit one `ownership_transferred` event claim PLUS one new `owner` assertion claim (owner = `kaeufer`, subject `property`, `valid_from = uebergabe_datum`) PLUS one closure intent for the previous `owner` claim (`close_overlapping_and_supersede_future`, `close_at = uebergabe_datum - 1 day`, match against `verkaeufer`). **NO tenant/kaltmiete/kaution closures — the Hofmann safeguard.**

**unklar** → emit nothing: `{ claims_to_insert: [], closure_intents: [] }`. The pipeline marks the extraction `requires_human_review` upstream; the emitter just returns empty.

---

## Out of scope

- **Hofmann fixture test** — Task 2.5 (the gate that proves this works end-to-end)
- **Applier changes** — the applier already protects tenant claims from ownership events (Scenario 7). No changes here.
- **owner resolver** (`owner_of_property`) — separate task; this emits owner claims but resolving them is later
- **occupancy_conflict warning event emission** — that's the applier's job when it sees vacant-possession language; the emitter just passes through `vacant_possession_language_present` if the applier reads it from the envelope (it does its own check)
- **meter_readings / damages claims** — evidence only, never emitted as claims (per domain knowledge gotcha)
- **Eigentümerwechsel via Kaufvertrag doc_type** — separate doc_type
- **nebenkostenvorauszahlung / kaution emission** — the Mietvertrag emitter may or may not emit these today; closing them is a harmless no-op if no such claims exist. This task closes them defensively without requiring they exist.

---

## Files touched

- `src/lib/emitters/wohnungsuebergabeprotokoll.ts` — new
- `src/lib/emitters/index.ts` — register `wohnungsuebergabeprotokoll`
- `src/lib/emitters/types.ts` — only if a new claim_kind or field is needed (likely not; verify)
- `src/tests/emitter-wohnungsuebergabeprotokoll.test.ts` — new, ≥28 assertions across 4 branches
- `src/tests/emitter-purity.test.ts` — add the new file to the purity gate's file list
- `ARCHITECTURE_STATE.md` — append Task 2.4 section

**NOT touched:**
- `src/lib/claim-store/applier.ts` — backstop already present
- `src/lib/resolvers/*` — owner resolver is later
- Schema YAML / domain knowledge — shipped in 2.3 / 1.4
- DB schema, Edge Function

---

## Repo conventions (recap)

- npm, tsc clean, lint clean
- Tests: `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- Emitter is PURE: no DB, no fetch, no fs, no env reads (CI purity gate enforces)
- Test files use relative imports (`../../lib/...`)
- Single descriptive commit, feature branch + PR

---

## Step 1 — The emitter

Mirror `mieterhoehung.ts` structure exactly (imports, envelope interface, field-reading helpers, the `isPresent` guard, the Claim/ClaimClosure construction). Key design points:

1. **Dispatch first.** Read `uebergabe_typ`. Switch into four branches. `unklar` and any unrecognized value → return empty result immediately.

2. **Required-field guards per branch.** Each branch needs `uebergabe_datum`. Einzug/Auszug need `unit_ref`. Einzug needs `mieter_in`; Auszug needs `mieter_out`; Eigentümerwechsel needs `kaeufer` + `verkaeufer`. If a branch's required field is absent, return empty result (do NOT throw — unlike Mieterhöhung's hard error, an incomplete Übergabeprotokoll should defer to triage, not crash the pipeline). Log the reason via a returned diagnostic if the EmissionResult type supports it; otherwise just return empty.

3. **Event claim is mandatory when closures are present** (applier contract). Auszug emits `lease_terminated`; Eigentümerwechsel emits `ownership_transferred`. These are the applier's trigger/reason claims.

4. **The Hofmann safeguard is the ABSENCE of code.** The Eigentümerwechsel branch simply never constructs tenant/kaltmiete/kaution closure intents. There is no flag to set — the safety is that the branch only ever closes `owner`. Add a prominent comment explaining this so a future contributor doesn't "helpfully" add tenant closures.

5. **close_mode per architecture §5.5.2 (architecture wins over domain knowledge):**
   - Auszug closures → `close_overlapping_and_future`
   - Eigentümerwechsel owner closure → `close_overlapping_and_supersede_future` (the domain knowledge file says `close_overlapping_only`; architecture §5.5.2 and §5.5.3 specify supersede_future for ownership transfer. Use the architecture value. This is the inconsistency flagged in Task 2.3's commit; resolve it here in the emitter's favor of the architecture.)

6. **close_at:**
   - Auszug: `close_at = uebergabe_datum` (the lease ends on the handover date)
   - Eigentümerwechsel: `close_at = uebergabe_datum - 1 day` (previous owner's authority ends the day before the new owner takes over; new owner `valid_from = uebergabe_datum`)

7. **Subjects:**
   - tenant_active / kaltmiete / kaution / nebenkostenvorauszahlung / lease_terminated → `unit:<unit_ref>`
   - owner / ownership_transferred → `property` (the literal string `property` per architecture §4.2 examples; owner claims are property-level, and `property_id` is already a separate column)

8. **Confidence:** `high` when all required fields for the branch are present. There's no signature-prerequisite gate like Mieterhöhung (handover documents are inherently the event record); confidence reflects extraction completeness.

Skeleton (adapt to the actual types from Step 0):

```typescript
// src/lib/emitters/wohnungsuebergabeprotokoll.ts
//
// Wohnungsübergabeprotokoll claim emitter. Dispatches on uebergabe_typ.
//
// PURITY CONTRACT: no DB imports, no fetch, no fs, no env reads.
//
// Architecture refs:
//   §4.5  -- doc-type taxonomy + Übergabeprotokoll dispatch
//   §5.5.2 -- closing matrix (tenant_moved_out, ownership_transferred)
//   §5.5.3 -- close_mode semantics
//   §5.5.4 -- applier safety rules (Hofmann safeguard backstop)
//   schemas/wohnungsuebergabeprotokoll/schema.yaml -- fields, schema_version 2026-05-27-v1
//   domain_knowledge/wohnungsuebergabeprotokoll.md -- closes rules + Hofmann gotcha
//
// THE HOFMANN SAFEGUARD (read before editing the Eigentümerwechsel branch):
//   An Eigentümerwechsel transfers OWNERSHIP, not TENANCY. Under BGB §566
//   ("Kauf bricht nicht Miete"), existing leases survive a change of owner.
//   The Eigentümerwechsel branch MUST NEVER emit a closure intent targeting
//   tenant_active, kaltmiete, kaution, or nebenkostenvorauszahlung. It closes
//   ONLY the previous owner claim. Do not add tenant closures here under any
//   circumstance. The applier (§5.5.4) is the backstop, but the first line of
//   defense is that this branch simply never constructs such an intent.

import type {
  Claim,
  ClaimClosure,
  Confidence,
  EmissionResult,
  EmitterContext,
} from "./types.ts";

export const EMITTER_NAME = "wohnungsuebergabeprotokoll";
export const EMITTER_VERSION = "1.0.0";

// ... envelope interface mirroring schema fields (uebergabe_typ, unit_ref,
//     uebergabe_datum, kaeufer, verkaeufer, mieter_in, mieter_out, ...) ...

export function emitWohnungsuebergabeprotokollClaims(
  envelope: UebergabeEnvelope,
  context: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};
  const uebergabe_typ = isPresent(f.uebergabe_typ) ? f.uebergabe_typ?.normalized_value ?? null : null;
  const uebergabe_datum = isPresent(f.uebergabe_datum) ? f.uebergabe_datum?.normalized_value ?? null : null;
  const unit_ref = isPresent(f.unit_ref) ? f.unit_ref?.normalized_value ?? null : null;

  // unklar or unrecognized → emit nothing.
  if (uebergabe_typ === null || uebergabe_typ === "unklar") {
    return { claims_to_insert: [], closure_intents: [] };
  }

  // All branches need the handover date.
  if (uebergabe_datum === null) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  switch (uebergabe_typ) {
    case "Einzug":
      return emitEinzug(f, context, { unit_ref, uebergabe_datum });
    case "Auszug":
      return emitAuszug(f, context, { unit_ref, uebergabe_datum });
    case "Eigentümerwechsel":
      return emitEigentuemerwechsel(f, context, { uebergabe_datum });
    default:
      return { claims_to_insert: [], closure_intents: [] };
  }
}

// emitEinzug:    1 tenant_active event claim (subject unit:<unit_ref>, tenant=mieter_in), no closures
// emitAuszug:    1 lease_terminated event claim + 4 closure intents
//                (kaltmiete, tenant_active, kaution, nebenkostenvorauszahlung),
//                close_overlapping_and_future, close_at = uebergabe_datum,
//                match against mieter_out (required strictness)
// emitEigentuemerwechsel: 1 ownership_transferred event claim + 1 new owner
//                assertion claim (subject "property", owner=kaeufer) + 1 closure
//                intent for previous owner (close_overlapping_and_supersede_future,
//                close_at = uebergabe_datum - 1 day, match against verkaeufer).
//                NO tenant closures — the Hofmann safeguard.
```

Compute `uebergabe_datum - 1 day` the same UTC way Mieterhöhung does:
```typescript
const d = new Date((uebergabe_datum as string) + "T00:00:00.000Z");
d.setUTCDate(d.getUTCDate() - 1);
const close_at = d.toISOString().slice(0, 10);
```

---

## Step 2 — Register in EMITTERS map

`src/lib/emitters/index.ts`:
```typescript
import { emitWohnungsuebergabeprotokollClaims } from "./wohnungsuebergabeprotokoll";

export const EMITTERS = {
  mietvertrag: { fn: emitMietvertragClaims, version: "1.0.0" },
  mieterhoehung: { fn: emitMieterhoehungClaims, version: "1.0.0" },
  wohnungsuebergabeprotokoll: { fn: emitWohnungsuebergabeprotokollClaims, version: "1.0.0" },
};
```

---

## Step 3 — Tests

`src/tests/emitter-wohnungsuebergabeprotokoll.test.ts`. Pure-function tests (no DB). Four scenarios, ≥28 assertions.

**Scenario 1 — Einzug:**
- Envelope: uebergabe_typ=Einzug, unit_ref=1.OG, uebergabe_datum=2025-04-01, mieter_in={name:"Everding, Lena"}
- Assert: 1 claim, predicate=tenant_active, claim_kind=event, subject=unit:1.OG, valid_from=2025-04-01, value.tenants[0].name="Everding, Lena", 0 closures

**Scenario 2 — Auszug:**
- Envelope: uebergabe_typ=Auszug, unit_ref=EG, uebergabe_datum=2024-06-30, mieter_out={name:"Paul, Friedrich"}
- Assert: 1 event claim predicate=lease_terminated subject=unit:EG; 4 closure intents
- Assert each closure: close_mode=close_overlapping_and_future, close_at=2024-06-30
- Assert target_predicates across the 4 intents = {kaltmiete, tenant_active, kaution, nebenkostenvorauszahlung}
- Assert match.tenant_identity="Paul, Friedrich" on tenant_active closure, match_strictness present

**Scenario 3 — Eigentümerwechsel (the Hofmann safeguard):**
- Envelope: uebergabe_typ=Eigentümerwechsel, uebergabe_datum=2025-11-15, kaeufer={name:"Denn Immobilienverwaltung eGbR", is_legal_entity:true, legal_form:"eGbR"}, verkaeufer={name:"Bernhardt, Cornelia"}
- Assert: 2 claims — 1 ownership_transferred event + 1 owner assertion (subject="property", value owner=kaeufer)
- Assert: exactly 1 closure intent, target_predicate=owner ONLY
- **Assert: NO closure intent targets tenant_active, kaltmiete, kaution, or nebenkostenvorauszahlung** (the Hofmann assertion — iterate all closure_intents, assert none have those target_predicates)
- Assert: owner closure close_mode=close_overlapping_and_supersede_future, close_at=2025-11-14 (uebergabe_datum - 1)
- Assert: match against verkaeufer

**Scenario 4 — unklar:**
- Envelope: uebergabe_typ=unklar
- Assert: 0 claims, 0 closures

**Scenario 5 — missing required field (defer, not crash):**
- Envelope: uebergabe_typ=Auszug but unit_ref absent
- Assert: 0 claims, 0 closures (returns empty, does not throw)

---

## Step 4 — Purity gate

Add the new file to `src/tests/emitter-purity.test.ts`:
```typescript
const FILES_TO_CHECK = [
  "src/lib/emitters/types.ts",
  "src/lib/emitters/mietvertrag.ts",
  "src/lib/emitters/mieterhoehung.ts",
  "src/lib/emitters/wohnungsuebergabeprotokoll.ts",  // NEW
];
```

---

## Step 5 — ARCHITECTURE_STATE.md

Append:

```markdown
## Übergabeprotokoll emitter shipped (Task 2.4, 2026-05-27)

Third emitter. Dispatches on uebergabe_typ into four branches. The Hofmann
safeguard is now structural code.

**Behavior:**
- Einzug → 1 tenant_active event claim (subject unit:<unit_ref>), no closures
- Auszug → 1 lease_terminated event claim + 4 closure intents (kaltmiete,
  tenant_active, kaution, nebenkostenvorauszahlung), close_overlapping_and_future,
  close_at = uebergabe_datum, match against mieter_out
- Eigentümerwechsel → 1 ownership_transferred event + 1 new owner assertion
  (subject "property", owner = kaeufer) + 1 closure for previous owner
  (close_overlapping_and_supersede_future, close_at = uebergabe_datum - 1,
  match verkaeufer). NEVER closes tenant/kaltmiete/kaution claims — Hofmann.
- unklar / missing required field → empty EmissionResult (defers to triage)

**Resolved inconsistency:** domain knowledge (Task 1.4) declared
close_overlapping_only for the Eigentümerwechsel owner closure; architecture
§5.5.2/§5.5.3 specify close_overlapping_and_supersede_future. The emitter
uses the architecture value (previous owner is genuinely superseded by the
new owner). The domain knowledge file's closes array should be updated to
match in a follow-up (cosmetic — the emitter is authoritative for behavior).

**Hofmann safeguard, two layers:**
1. Emitter: the Eigentümerwechsel branch never constructs tenant-claim closures
2. Applier (Task 1.8 §5.5.4): rejects any ownership→tenant closure intent

**Pending:**
- Task 2.5: Hofmann fixture test (Phase 2 gate)
- Task 2.6: PLZ verifier
- owner_of_property resolver (later)
- Follow-up: align domain knowledge closes array close_mode with architecture
```

---

## Step 6 — Verify

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-wohnungsuebergabeprotokoll.test.ts | tail -40
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-purity.test.ts | tail -10

# Regression: all emitter + claim-store tests
for f in src/tests/emitter-*.test.ts src/tests/claim-store/*.test.ts src/tests/integration/*.test.ts; do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -2
done

npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

All green, tsc silent.

---

## Step 7 — PR

```bash
git add src/lib/emitters/wohnungsuebergabeprotokoll.ts \
        src/lib/emitters/index.ts \
        src/lib/emitters/types.ts \
        src/tests/emitter-wohnungsuebergabeprotokoll.test.ts \
        src/tests/emitter-purity.test.ts \
        ARCHITECTURE_STATE.md
git commit -m "feat(emitters): add Übergabeprotokoll emitter with uebergabe_typ dispatch (Task 2.4)

Third emitter. Dispatches on uebergabe_typ. The Hofmann safeguard is now
structural code: the Eigentümerwechsel branch never emits tenant-claim closures.

- Einzug → tenant_active event claim, no closures
- Auszug → lease_terminated event + closures for kaltmiete/tenant_active/
  kaution/nebenkostenvorauszahlung (close_overlapping_and_future)
- Eigentümerwechsel → ownership_transferred event + new owner assertion +
  previous-owner closure (close_overlapping_and_supersede_future). NO tenant
  closures (BGB §566, the Hofmann fix).
- unklar / missing required field → empty result (defers to triage)

Uses architecture §5.5.2 close_mode for Eigentümerwechsel
(close_overlapping_and_supersede_future), resolving the inconsistency with
the domain knowledge file's close_overlapping_only (architecture wins).

- src/lib/emitters/wohnungsuebergabeprotokoll.ts: the emitter
- src/lib/emitters/index.ts: register wohnungsuebergabeprotokoll
- src/tests/emitter-wohnungsuebergabeprotokoll.test.ts: 28+ assertions, 5 scenarios
- src/tests/emitter-purity.test.ts: extend gate to the new file
- ARCHITECTURE_STATE.md: Task 2.4 section"
git push -u origin feature/task-2.4-uebergabeprotokoll-emitter
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.4-uebergabeprotokoll-emitter
```

---

## Definition of done

- [ ] Step 0 contracts verified; emitter matches actual shipped types
- [ ] `src/lib/emitters/wohnungsuebergabeprotokoll.ts` created, pure
- [ ] Registered in EMITTERS map
- [ ] ≥28 assertions across 5 scenarios, all pass
- [ ] Hofmann assertion explicit: Eigentümerwechsel emits zero tenant/kaltmiete/kaution/nebenkostenvorauszahlung closures
- [ ] Purity gate extended + passes
- [ ] tsc clean, all existing tests pass, tenant-isolation clean
- [ ] Branch pushed, PR opened, CI green
- [ ] ARCHITECTURE_STATE.md appended
- [ ] PR merged

---

## Notes for reviewer

**The Hofmann safeguard is the absence of code, not a flag.** The Eigentümerwechsel branch closes only `owner`. There is no "should I close tenant claims?" decision to get wrong — the branch simply never constructs those intents. The prominent comment block exists to stop a future contributor from "fixing" a perceived gap by adding tenant closures. The applier is the second layer.

**unklar and missing-field both return empty, not throw.** Unlike Mieterhöhung (where absent new_kaltmiete is a hard error because the document is definitionally not a Mieterhöhung), an incomplete Übergabeprotokoll is still a valid document that should defer to human triage rather than crash the pipeline. Empty EmissionResult is the safe, non-destructive default — it matches the domain knowledge's "better no claim than a wrong claim" principle.

**Architecture beats domain knowledge on the Eigentümerwechsel close_mode.** Per the precedence rule (code > ARCHITECTURE_STATE > ARCHITECTURE > project files), the architecture doc's `close_overlapping_and_supersede_future` wins over the domain knowledge file's `close_overlapping_only`. It's also more correct: the previous owner is genuinely superseded by the new owner (a true authority transfer), so setting `superseded_by_claim_id` preserves the ownership chain for audit. The domain knowledge file should be updated to match in a cosmetic follow-up.

**Auszug closes four predicates, two of which may have no open claims.** kaution and nebenkostenvorauszahlung may not be emitted by the current Mietvertrag emitter. Closing a predicate with no open claims is a harmless no-op (the applier's close query matches nothing). Including them is future-proofing: when the Mietvertrag emitter starts emitting them, Auszug already closes them correctly. No downside today.

**Owner claims use subject `property`, not `property:<id>`.** Per architecture §4.2 examples, the subject is the literal string `property` because `property_id` is already a column on the claim. The owner claim is property-level, distinct from unit-level claims (`unit:<unit_ref>`).

**The emitter emits event claims (lease_terminated, ownership_transferred) the applier requires.** The applier dispatches its blocker checks on the event claim's predicate and uses it as the reason_claim_id for closures. This mirrors Mieterhöhung's kaltmiete_amended event. Without the event claim, the applier has no reason claim to attach to the closure rows.

**Einzug does not close the previous tenant.** An Einzug documents a new tenant arriving; the previous tenant's departure is a separate Auszug document. If a previous tenant_active claim is still open when an Einzug arrives, that's a data gap to surface in triage, not something Einzug should silently resolve. This matches the domain knowledge.
