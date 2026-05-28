# Task 2.6 — PLZ verifier (the Kuru hallucinated-address case)

**Task type:** t2 S (deterministic verifier + static data; closes Phase 2)

**Branch:** `feature/task-2.6-plz-verifier`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.6 acceptance criteria
- **Architecture §10 (deterministic verifiers) — authoritative over the implementation plan's looser wording.** §10 PLZ verifier: "Every extracted German address with a PLZ must check the PLZ against a static lookup of valid German postal codes (5 digits, valid range, matched to a Bundesland). The Kuru '36270 Eosbacher Str.' case fails because 36270 doesn't exist near Schauenburg. Verifier marks `confidence = low` and `validation_status = requires_human_review`."
- Architecture §9.3 — verifier provider-agnosticism: verifier source must contain NO model-specific identifiers. CI scan `verifiers-no-model-identifiers.test.ts` enforces.
- **Precedent to mirror exactly:** the existing verifiers in `supabase/functions/process-document/verifiers/` — `date-format.ts`, `enum.ts`, `monetary-verbatim.ts`, `types.ts`, `index.ts`. The shipped `VerifierResult` type and registration pattern are authoritative.

**What this delivers:** the deterministic guard against hallucinated addresses. The data file (all 8,298 valid German PLZs → Bundesland) and the verifier logic are pre-built and validated (28 assertions pass, including the Kuru case). This task is mostly **wiring the pre-built pieces to the shipped verifier interface** — not writing logic from scratch.

---

## Pre-built artifacts (validated, attached)

Three files are provided ready, already tested end-to-end (28 assertions, all pass, against the real dataset):

1. **`plz-bundesland.json`** — 8,298 valid German postal codes mapped to Bundesland. Built by point-in-polygon of each PLZ's coordinates against dissolved Bundesland boundaries (source: WZB plz_geocoord + official county boundaries, AGS SN_L → Bundesland). Spot-validated: 34270→Hessen (Schauenburg, KO132), 34117→Hessen (Kassel, HHS55), 80331→Bayern, 10115→Berlin, 01067→Sachsen, and **36270→absent** (the Kuru hallucination — it jumps 36269→36272). Distribution is realistic (Bayern 2060 … Bremen 40, all 16 states present).

2. **`plz.ts`** — the verifier. Pure core `checkPlz(plz, expectedBundesland?)` + `extractPlz(address)` + a `plzVerifier(...)` wrapper implementing §10 semantics (failure → confidence "low", validation_status "requires_human_review"). No model identifiers (§9.3 clean). **The import path and the wrapper's return shape are placeholders to adapt in Step 0.**

3. **`plz.test.ts`** — 28 assertions covering valid codes, the Kuru case, malformed input, Bundesland mismatch, address extraction, and the §10 wrapper semantics.

**Do not rebuild the data file or the core logic.** They are correct. The task is to place them and wire them to the real interface.

---

## Step 0 — Verify shipped contracts BEFORE wiring

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-2.6-plz-verifier

# 1. The VerifierResult type the existing verifiers return
echo "=== verifiers/types.ts ==="
cat supabase/functions/process-document/verifiers/types.ts

# 2. How an existing verifier is structured + what it returns (mirror this exactly)
echo "=== monetary-verbatim.ts (the closest analogue) ==="
cat supabase/functions/process-document/verifiers/monetary-verbatim.ts

# 3. How verifiers are registered + dispatched
echo "=== verifiers/index.ts ==="
cat supabase/functions/process-document/verifiers/index.ts

# 4. How verifiers are invoked in post-processing + how a field's type/verifier_refs select which verifiers run
echo "=== verifier invocation in the pipeline ==="
grep -rn "verifier\|verifier_refs\|validation_status\|requires_human_review" supabase/functions/process-document/index.ts | head -20

# 5. How the unit test imports verifiers (src path vs function path)
echo "=== existing verifier test ==="
sed -n '1,30p' src/tests/verifiers.test.ts

# 6. Does any schema field use type 'address' or a plz verifier_ref today?
echo "=== address-typed fields / plz refs ==="
grep -rn "type: address\|type: \"address\"\|plz\|verifier_refs" schemas/ | head -20
```

**Reconcile before wiring.** The key unknowns the existing code resolves:
- **`VerifierResult` exact shape** — the provided `plzVerifier` returns `{ validation_status, confidence_override, detail }`. Adapt this to whatever `types.ts` defines (it may use different field names, an `absence_state` override, an `evidence`/`detail` field, etc.). Keep the §10 semantics: failure → confidence low + validation_status requires_human_review.
- **Registration** — how `index.ts` maps a verifier name (e.g. `"plz"`) to its function, and how `verifier_refs: [plz]` in a schema field selects it.
- **JSON bundle path** — Edge Functions bundle only files reachable by relative import from the function entry. Decide where the data file lives (see Step 1).
- **Test location + import** — whether the test imports from the function path or a src shim. Place `plz.test.ts` consistent with `verifiers.test.ts`.

---

## Step 1 — Place the data file

Decision: the verifier runs in the Edge Function (Deno), which bundles only files it imports relatively. Two options — pick based on what Step 0 shows about how the function bundles assets:

- **Option A (preferred if the function can import from repo root):** `data/plz-bundesland.json`, imported as in the provided `plz.ts`. Confirm the deploy bundles it (check whether other non-function assets like `schemas/` are bundled — they are, per the deploy upload list, so repo-root `data/` likely works too).
- **Option B (safe fallback):** `supabase/functions/process-document/data/plz-bundesland.json`, with the import path in `plz.ts` updated to `"../data/plz-bundesland.json"`.

```bash
# place the provided data file (Option A shown; adjust for B)
mkdir -p data
cp ~/path/to/plz-bundesland.json data/plz-bundesland.json   # scp'd location
```

Update the import line at the top of `plz.ts` to the chosen path. The provided file uses `import ... with { type: "json" }` (Deno-native); if the repo's other verifiers import JSON differently, match their style.

---

## Step 2 — Place + adapt the verifier

```bash
cp ~/path/to/plz.ts supabase/functions/process-document/verifiers/plz.ts
```

Then adapt the `plzVerifier` wrapper's return type to the shipped `VerifierResult` (Step 0). The pure core (`checkPlz`, `extractPlz`) needs no changes — keep it as-is. Only the wrapper that produces the `VerifierResult` should change to match the interface.

Confirm no model identifiers remain (the provided file is clean, but verify after any edits):
```bash
grep -iE "sonnet|gpt|gemini|haiku|opus|claude|llama|mistral" supabase/functions/process-document/verifiers/plz.ts || echo "clean"
```

---

## Step 3 — Register the verifier

In `verifiers/index.ts`, register `plz` alongside `date-format`, `enum`, `monetary-verbatim`, following the exact registration pattern Step 0 revealed. The verifier should be selectable via a schema field's `verifier_refs: [plz]`.

---

## Step 4 — Wire into address-field post-processing

Per §10, the verifier runs on any field of type `address` (or any field declaring `verifier_refs: [plz]`). Two sub-steps:

1. **Selection:** ensure the post-processing loop that runs verifiers picks up `plz` for address-typed fields. If verifier selection is by `verifier_refs` on the schema field, then address fields in existing schemas need `verifier_refs: [plz]` added. If selection is by field `type == address`, wire it there.
2. **Application of result:** on a failing PLZ check, the field's `confidence` is set to `low` and `validation_status` to `requires_human_review` (§10). Follow how `monetary-verbatim`'s `failed_verifier` result is applied to the field — use the same application path with the §10 status values.

**Scope note:** address fields are not critical-severity in the launch slice, so there may be few or zero `type: address` fields in current schemas. If none exist yet, the verifier is registered and unit-tested but dormant until an address field is added — that's acceptable (the implementation plan notes this verifier is "cheap to add and prevents recurrence of the Kuru bug class"). Do not invent address fields just to exercise it; the unit test is the proof of correctness.

---

## Step 5 — Place + run the test

```bash
cp ~/path/to/plz.test.ts <test-location>/plz.test.ts   # match verifiers.test.ts location
# adjust the import in plz.test.ts to the placed plz.ts path
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <test-location>/plz.test.ts | tail -35
```

Expected:
```
✓ 28 PLZ verifier assertions passed
✓ Kuru hallucinated-address case (36270) structurally caught
```

If the repo runs verifier tests through `src/tests/verifiers.test.ts` rather than a standalone file, fold the assertions in there instead, matching the existing harness.

---

## Step 6 — Verify (regression + gates)

```bash
cd ~/repos/property-management-saas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/verifiers.test.ts | tail -5
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/verifiers-no-model-identifiers.test.ts | tail -5
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/schemas.test.ts | tail -5
npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

All green, especially `verifiers-no-model-identifiers` (proves §9.3 compliance).

---

## Step 7 — ARCHITECTURE_STATE.md + PR

Append:
```markdown
## PLZ verifier shipped (Task 2.6, 2026-05-28) — Phase 2 COMPLETE

Deterministic verifier guarding against hallucinated German addresses (the
Kuru bug class). Static lookup of 8,298 valid German PLZs → Bundesland
(point-in-polygon of PLZ coordinates against dissolved official Bundesland
boundaries).

- data/plz-bundesland.json: 8,298 PLZ → Bundesland
- verifiers/plz.ts: checkPlz (pure core) + plzVerifier wrapper. On failure
  (PLZ not found OR Bundesland mismatch) → confidence "low",
  validation_status "requires_human_review" per §10. No model identifiers (§9.3).
- 28 assertions; the Kuru case (36270 — a non-existent PLZ) is structurally caught.

Runs on address-typed fields in extraction post-processing. Address fields are
not critical-severity in the launch slice, so the verifier may be dormant until
an address field is added — registered and unit-tested, ready when needed.

**Phase 2 COMPLETE.** Both original v1 bugs gate-tested (Weber 2.2, Hofmann 2.5);
Mieterhöhung, Übergabeprotokoll, Mietvertragsnachtrag emitters shipped;
supersession + Hofmann + PLZ guards in place. Next: Phase 3 (composer + brain
replacement).
```

```bash
git add data/plz-bundesland.json \
        supabase/functions/process-document/verifiers/plz.ts \
        supabase/functions/process-document/verifiers/index.ts \
        <test-location>/plz.test.ts \
        schemas/ \
        ARCHITECTURE_STATE.md
git commit -m "feat(verifiers): add PLZ verifier guarding hallucinated addresses (Task 2.6)

Deterministic verifier (architecture §10) checking extracted German address
PLZs against a static lookup of 8,298 valid postal codes mapped to Bundesland.

- data/plz-bundesland.json: PLZ → Bundesland, built by point-in-polygon of PLZ
  coordinates against dissolved official Bundesland boundaries
- verifiers/plz.ts: pure checkPlz core + plzVerifier wrapper; on failure
  (PLZ not found OR Bundesland mismatch) sets confidence low +
  validation_status requires_human_review per §10. No model identifiers (§9.3).
- 28 assertions; the Kuru case (36270, a non-existent PLZ) is structurally caught

Closes Phase 2.

- data/plz-bundesland.json
- supabase/functions/process-document/verifiers/plz.ts + index.ts registration
- verifier test (28 assertions)
- ARCHITECTURE_STATE.md: Phase 2 complete"
git push -u origin feature/task-2.6-plz-verifier
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.6-plz-verifier
```

**Deploy note:** like 2.1b, this touches the Edge Function. The verifier isn't live until `supabase functions deploy process-document` — and remember to `git pull` on main first (the May 25 stale-deploy rule). Not urgent: the verifier is dormant without address fields declaring it.

---

## Definition of done

- [ ] Step 0 contracts verified; wrapper return shape matches shipped VerifierResult
- [ ] data/plz-bundesland.json placed, import path resolves in the bundle
- [ ] plz.ts placed + adapted; no model identifiers
- [ ] registered in verifiers/index.ts
- [ ] wired into address-field post-processing (or registered + dormant if no address fields exist yet)
- [ ] 28 assertions pass, Kuru case caught
- [ ] tsc clean, verifiers + no-model-identifiers + schemas tests pass, tenant-isolation clean
- [ ] PR merged → Phase 2 COMPLETE

---

## Notes for reviewer

**The data file is pre-validated; don't regenerate it.** 8,298 PLZs, point-in-polygon against official Bundesland boundaries, 0 unmapped, distribution sanity-checked (Bayern largest, city-states smallest, all 16 present), demo properties confirmed (KO132/HHS55 → Hessen). Regenerating risks introducing errors; the file is correct.

**36270 doesn't exist — that's the whole point.** The Kuru hallucination wasn't a wrong-Bundesland case; 36270 simply isn't a German postal code (the range goes 36269 → 36272). So the "not found" branch catches it. The Bundesland-mismatch branch is the secondary guard for plausible-but-wrong-region PLZs.

**Architecture §10 beats the implementation plan on the failure result.** The plan said "returns passes: false". §10 specifies confidence "low" + validation_status "requires_human_review". Use §10 — it's the more precise, authoritative spec, and it routes the document to triage rather than hard-failing the extraction.

**§9.3 compliance is non-negotiable.** The verifier checks field semantics (is this a valid PLZ?), never model behavior. No model identifiers in the source. The `verifiers-no-model-identifiers.test.ts` CI gate enforces this — the provided file is already clean, but re-scan after any edits.

**Dormant-but-ready is an acceptable end state.** If no current schema field has `type: address` or `verifier_refs: [plz]`, the verifier ships registered and unit-tested but unexercised in production. That's fine and intended — the implementation plan explicitly frames this as cheap insurance against the Kuru bug class recurring when address fields are added later. Don't manufacture address fields to force it live.

**The pure core is the durable asset.** `checkPlz` and `extractPlz` have no I/O and no framework coupling — they're trivially testable and reusable (e.g. a future resolver or a frontend address validator could import the same logic). Only the thin `plzVerifier` wrapper is interface-specific; keep the core clean.
