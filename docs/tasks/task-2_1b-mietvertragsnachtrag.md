# Task 2.1b — Mietvertragsnachtrag schema, domain knowledge, emitter

**Task type:** t2 M (new doc_type spanning schema + domain knowledge + emitter with delegation + classifier prompt change; requires review before merge)

**Branch:** `feature/task-2.1b-mietvertragsnachtrag`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.1b acceptance criteria
- Architecture §4.4 (emitter purity), §4.2 (claim_kind enum includes `reference`), §6.3 (domain knowledge front-matter)
- **Precedent to mirror:** `src/lib/emitters/mieterhoehung.ts` (Task 2.1 — the emitter this one DELEGATES to), `schemas/mieterhoehung/schema.yaml` (the schema structure), `domain_knowledge/mieterhoehung.md` (front-matter format)
- `src/lib/emitters/index.ts` (register the new emitter), `schemas/index.ts` (register the new doc_type)

**What this delivers:** the doc_type that catches the ~15-20% of Nachträge that change NON-rent terms (pet clauses, parking, deposit, ancillary cost, term, usage rights). Splitting these out of Mieterhöhung prevents silent data loss — a pet-clause Nachtrag misclassified as a Mieterhöhung would fail (no new_kaltmiete) and surface in triage instead of corrupting rent. The emitter delegates `rent_change` scope back to the Mieterhöhung emitter so bilateral rent-change amendments still produce correct supersession.

---

## Step 0 — Verify shipped contracts BEFORE writing code

```bash
cd ~/repos/property-management-saas
git checkout main && git pull
git checkout -b feature/task-2.1b-mietvertragsnachtrag

# 1. Mieterhöhung emitter: exact export name, envelope interface, context shape
echo "=== mieterhoehung emitter signature ==="
grep -n "export function\|export const EMITTER\|interface.*Envelope\|context:" src/lib/emitters/mieterhoehung.ts | head -20

# 2. claim_kind values + Claim shape — confirm 'reference' is valid; find how a
#    claim carries a review/status flag (the spec wants status: unsupported_requires_review)
echo "=== Claim type + claim_kind ==="
grep -n "claim_kind\|reference\|status\|requires_review\|ClaimKind" src/lib/emitters/types.ts | head -20

# 3. Classification prompt file location + current mieterhoehung/nachtrag handling
echo "=== classification prompt file ==="
ls supabase/functions/process-document/ | grep -i "class\|prompt"
grep -rn "mieterhoehung\|nachtrag\|Mietvertragsnachtrag" supabase/functions/process-document/ | head -10

# 4. Registration patterns (how 2.1 + 2.3 registered)
echo "=== schemas/index.ts registration ==="
cat schemas/index.ts 2>/dev/null | head -40
echo "=== emitters/index.ts ==="
cat src/lib/emitters/index.ts

# 5. Generator script name confirmation
grep "gen:schemas" package.json
```

**Reconcile before coding.** Critical confirmations:
- The exact `emitMieterhoehungClaims` signature and the envelope field names it reads (new_kaltmiete, effective_date, unit_ref, landlord_signature_present, document_status, tenant_identity, rechtsgrundlage, staffelmiete_context). The delegation builds an envelope of exactly this shape.
- How a `reference` claim carries the "unsupported_requires_review" signal. The Claim type from Task 2.2 has no top-level `status` field — likely it goes into the `value` JSONB (`value: { scope, status: "unsupported_requires_review", ...payload }`). Confirm and use whatever the shipped Claim type supports.
- The classification prompt's actual structure — whether doc_types are listed with descriptions, and where to add the mieterhoehung-vs-nachtrag distinction.

---

## Scope

Four deliverables:

1. **`domain_knowledge/mietvertragsnachtrag.md`** — `default_claim_kind: reference`; the five required gotchas; a `closes` entry that fires only when `nachtrag_scope == "rent_change"` and delegates to Mieterhöhung's closing rule.
2. **`schemas/mietvertragsnachtrag/schema.yaml`** — `nachtrag_scope` enum + per-scope structured payloads.
3. **`src/lib/emitters/mietvertragsnachtrag.ts`** — pure function with delegation: `rent_change` → build Mieterhöhung-shaped envelope, call `emitMieterhoehungClaims`, return its result; otherwise → one `reference` claim, no closures.
4. **Step 4 classifier prompt update** — distinguish `mieterhoehung` from `mietvertragsnachtrag` by WHAT changes, not document title.

Plus registration (EMITTERS map + schemas index) and tests (4 scenarios).

---

## Out of scope

- Resolvers for amendment_present claims (reference claims are informational; no resolver consumes them yet)
- Supporting non-rent scopes as actionable claims (deposit changes, term changes → reference-only at launch; actionable emission is later)
- The adversarial Step-4-misclassification fixture as a full pipeline test (we test the emitter's rejection behavior in unit tests; the full Step 4 classifier eval is a separate harness)
- Multi-scope documents that change BOTH rent and a non-rent term in one Nachtrag (flag for review; do not attempt to emit both rent supersession AND reference claims in one pass — see gotcha multi_scope_documents)
- Production code beyond the emitter, schema, domain knowledge, classifier prompt, registrations

---

## Files touched

- `domain_knowledge/mietvertragsnachtrag.md` — new
- `schemas/mietvertragsnachtrag/schema.yaml` — new
- `schemas/mietvertragsnachtrag/*` — generator outputs
- `schemas/index.ts` — register doc_type
- `src/lib/emitters/mietvertragsnachtrag.ts` — new
- `src/lib/emitters/index.ts` — register emitter
- `supabase/functions/process-document/<classification-prompt-file>` — distinguish the two doc_types
- `src/tests/emitter-mietvertragsnachtrag.test.ts` — new, 4 scenarios
- `src/tests/emitter-purity.test.ts` — add new emitter file
- `ARCHITECTURE_STATE.md` — append section

**NOT touched:** applier, resolvers, mieterhoehung.ts (we import it, don't modify), DB schema.

---

## Step 1 — `domain_knowledge/mietvertragsnachtrag.md`

```markdown
---
doc_type: mietvertragsnachtrag
default_claim_kind: reference
last_updated: 2026-05-28
legal_grounding:
  - statute: BGB §311 Abs. 1
    description: >
      Amendment of an existing contract by mutual agreement. A
      Mietvertragsnachtrag is a bilateral modification of the lease — it
      requires both parties' consent, distinguishing it from a unilateral
      §558/§559 Mieterhöhung.
  - statute: BGB §550
    description: >
      Written-form requirement for leases longer than one year. Material
      amendments to such leases generally require written form to remain
      enforceable; the Nachtrag is that written instrument.
fields_governed:
  - nachtrag_scope
  - unit_ref
  - effective_date
  - tenant_identity
  - landlord_signature_present
  - tenant_signature_present
  - document_status
  - rent_change_payload
  - tenant_identity_change_payload
  - deposit_change_payload
  - ancillary_cost_change_payload
  - term_change_payload
  - usage_right_change_payload
  - other_change_descriptor
normalization_rules:
  - id: nachtrag_scope_canonical_values
    field: nachtrag_scope
    description: |
      nachtrag_scope must normalize to exactly one of: rent_change,
      tenant_identity_change, deposit_change, ancillary_cost_change,
      term_change, usage_right_change, other. Classify by WHAT the
      amendment changes, never by the document title (many Nachträge are
      titled generically). When multiple scopes are present, see the
      multi_scope_documents gotcha.
gotchas:
  - id: scope_classification_accuracy_critical
    description: |
      The nachtrag_scope drives whether this document supersedes rent
      (delegated to the Mieterhöhung emitter) or merely records a reference
      claim. A rent_change misclassified as usage_right_change would fail to
      update the rent; a usage_right_change misclassified as rent_change
      would route to the Mieterhöhung emitter and fail (no new_kaltmiete).
      Classification accuracy is the single most consequential extraction
      decision for this doc_type.
  - id: multi_scope_documents
    description: |
      A single Nachtrag may change several terms at once (e.g. rent AND
      parking). At launch the emitter handles the PRIMARY scope only. If the
      extraction signals multiple scopes, nachtrag_scope is set to the
      rent_change scope if rent is among them (rent supersession is the
      highest-stakes action); otherwise to "other", and the document is
      flagged requires_review so a human can adjudicate the secondary terms.
      Emitting partial multi-scope claims silently is worse than deferring.
  - id: rent_change_delegates_to_mieterhoehung
    description: |
      When nachtrag_scope == "rent_change", this emitter does NOT implement
      rent supersession itself. It builds a Mieterhöhung-shaped extraction
      from rent_change_payload + the common fields and delegates to
      emitMieterhoehungClaims. This keeps a single source of truth for the
      close_overlapping_only kaltmiete supersession logic. A bilateral
      rent-change Nachtrag and a unilateral §558 notice produce identical
      claim shapes via the same emitter.
  - id: non_rent_scopes_emit_reference_claims_only
    description: |
      All non-rent scopes (tenant_identity_change, deposit_change,
      ancillary_cost_change, term_change, usage_right_change, other) emit a
      single reference-kind claim with predicate "amendment_present" and
      value carrying the scope + payload + status
      "unsupported_requires_review". They produce NO closure intents and
      NEVER close tenant_active, kaltmiete, or any other claim. A tenant
      identity change Nachtrag does not close the tenant_active claim — the
      tenancy continues, only a name/party detail changed.
  - id: misclassified_as_mieterhoehung
    description: |
      If the Step 4 classifier wrongly routes a non-rent Nachtrag to the
      mieterhoehung doc_type, the Mieterhöhung emitter throws (new_kaltmiete
      absent) and the extraction surfaces in triage with a classification
      error. This is the SAFE failure: a loud rejection in triage rather
      than silent rent corruption. The Step 4 prompt must classify by what
      changes, not by the word "Nachtrag" or "Mieterhöhung" in the title.
adversarial_fixtures_required:
  - nachtrag_pet_clause_usage_right
  - nachtrag_tenant_identity_change
  - nachtrag_bilateral_rent_change
  - nachtrag_misclassified_as_mieterhoehung_at_step4
  - nachtrag_multi_scope_rent_and_parking
closes:
  - trigger_predicate: kaltmiete_amended
    when:
      - nachtrag_scope == "rent_change"
    delegates_to: mieterhoehung
    note: |
      Rent-change Nachträge delegate entirely to the Mieterhöhung emitter,
      which owns the kaltmiete close_overlapping_only closing rule. This
      entry documents the delegation; the actual closure intent is produced
      by emitMieterhoehungClaims, not by this emitter directly.
---

# Mietvertragsnachtrag — domain knowledge

A Mietvertragsnachtrag is a bilateral amendment to an existing lease. Unlike a
§558/§559 Mieterhöhung (a unilateral landlord notice), a Nachtrag is signed by
both parties and can change any term: rent, deposit, ancillary costs, lease
duration, permitted use, or party details.

## Why this doc_type exists separately from Mieterhöhung

Originally all amendments were funneled into the Mieterhöhung doc_type. That
caused silent data loss: a pet-clause Nachtrag has no new rent, so a
rent-centric emitter either rejected it (losing the amendment record) or, worse,
emitted garbage. Splitting Mietvertragsnachtrag out lets non-rent amendments be
recorded as reference claims while rent-change amendments still get correct
supersession via delegation.

## The scope discriminator

`nachtrag_scope` is classified by WHAT the amendment changes:
- **rent_change** — changes the Kaltmiete. Delegated to the Mieterhöhung emitter.
- **tenant_identity_change** — a party detail changes (marriage name change, a
  co-tenant added/removed). The tenancy continues; only a detail changes.
- **deposit_change** — the Kaution amount or terms change.
- **ancillary_cost_change** — Nebenkosten allocation or prepayment changes.
- **term_change** — lease duration, notice period, or end date changes.
- **usage_right_change** — permitted use changes (pets, subletting, parking,
  commercial use).
- **other** — anything not covered above, or multi-scope documents deferred
  for human adjudication.

## The delegation pattern

When `nachtrag_scope == "rent_change"`, this emitter does not reimplement rent
supersession. It constructs a Mieterhöhung-shaped extraction from the
rent_change_payload and the common fields, then calls the Mieterhöhung emitter.
This guarantees a bilateral rent-change Nachtrag and a unilateral §558 notice
produce identical claim shapes and identical close_overlapping_only behavior —
one source of truth for rent supersession.

## Non-rent scopes are reference-only

Every non-rent scope emits a single reference-kind claim
(predicate "amendment_present") carrying the scope and payload, with status
"unsupported_requires_review". These claims are informational: they record that
an amendment exists and what it concerns, surfaced in triage, without mutating
any resolver-backed fact. Critically, a tenant_identity_change Nachtrag does NOT
close the tenant_active claim — the tenancy persists; only a detail changed.
```

---

## Step 2 — `schemas/mietvertragsnachtrag/schema.yaml`

Mirror the Mieterhöhung schema structure (top-level keys, `fields:` array with id/german_label/severity/requiredness/type/...). Required fields:

- `nachtrag_scope` (critical, enum: rent_change, tenant_identity_change, deposit_change, ancillary_cost_change, term_change, usage_right_change, other)
- `unit_ref` (enum, same values as Mieterhöhung)
- `effective_date` (date)
- `tenant_identity` (structured)
- `landlord_signature_present` (boolean)
- `tenant_signature_present` (boolean)
- `document_status` (enum: draft, unsigned, signed, executed)
- `rent_change_payload` (structured, conditional on nachtrag_scope == "rent_change") — carries new_kaltmiete, previous_kaltmiete, rechtsgrundlage so it can be reshaped into a Mieterhöhung envelope
- `tenant_identity_change_payload` (structured, conditional)
- `deposit_change_payload` (structured, conditional)
- `ancillary_cost_change_payload` (structured, conditional)
- `term_change_payload` (structured, conditional)
- `usage_right_change_payload` (structured, conditional)
- `other_change_descriptor` (string, conditional)

The `rent_change_payload` sub-fields must include everything the Mieterhöhung emitter reads:
```yaml
  - id: rent_change_payload
    german_label: "Mietänderungs-Details"
    severity: critical
    requiredness: conditional
    condition: "nachtrag_scope == 'rent_change'"
    type: structured
    item_schema:
      - field: new_kaltmiete
        type: money
        required: true
      - field: previous_kaltmiete
        type: money
        required: false
      - field: rechtsgrundlage
        type: string
        required: false
      - field: staffelmiete_context
        type: boolean
        required: false
    description: |
      Rent-change details. When nachtrag_scope == "rent_change", the emitter
      reshapes this payload + common fields (effective_date, unit_ref,
      tenant_identity, signatures, document_status) into a Mieterhöhung-shaped
      extraction and delegates to emitMieterhoehungClaims.
```

Run `npm run gen:schemas` after writing.

---

## Step 3 — `src/lib/emitters/mietvertragsnachtrag.ts`

Pure function. Imports `emitMieterhoehungClaims` for delegation.

```typescript
// src/lib/emitters/mietvertragsnachtrag.ts
//
// Mietvertragsnachtrag claim emitter. Dispatches on nachtrag_scope.
//
// PURITY CONTRACT: no DB, no fetch, no fs, no env reads.
//
// rent_change → reshape into a Mieterhöhung extraction, delegate to
//   emitMieterhoehungClaims (single source of truth for kaltmiete supersession).
// all other scopes → one reference-kind "amendment_present" claim, no closures.

import type { Claim, EmissionResult, EmitterContext } from "./types.ts";
import { emitMieterhoehungClaims } from "./mieterhoehung.ts";

export const EMITTER_NAME = "mietvertragsnachtrag";
export const EMITTER_VERSION = "1.0.0";

// ... envelope interface ...

export function emitMietvertragsnachtragClaims(
  envelope: MietvertragsnachtragEnvelope,
  context: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};
  const scope = isPresent(f.nachtrag_scope) ? f.nachtrag_scope?.normalized_value ?? null : null;

  if (scope === null) {
    return { claims_to_insert: [], closure_intents: [] };
  }

  if (scope === "rent_change") {
    // Reshape rent_change_payload + common fields into a Mieterhöhung envelope.
    const payload = f.rent_change_payload?.normalized_value ?? {};
    const mieterhoehungEnvelope = {
      doc_type: "mieterhoehung" as const,
      schema_version: envelope.schema_version,
      fields: {
        new_kaltmiete: { absence_state: "present", normalized_value: payload.new_kaltmiete },
        previous_kaltmiete: payload.previous_kaltmiete
          ? { absence_state: "present", normalized_value: payload.previous_kaltmiete }
          : { absence_state: "absent" },
        effective_date: f.effective_date,
        unit_ref: f.unit_ref,
        tenant_identity: f.tenant_identity,
        landlord_signature_present: f.landlord_signature_present,
        document_status: f.document_status,
        rechtsgrundlage: payload.rechtsgrundlage
          ? { absence_state: "present", normalized_value: payload.rechtsgrundlage }
          : { absence_state: "present", normalized_value: "bilateral" },
        staffelmiete_context: payload.staffelmiete_context
          ? { absence_state: "present", normalized_value: payload.staffelmiete_context }
          : { absence_state: "present", normalized_value: false },
      },
      lifecycle: envelope.lifecycle ?? {},
    };
    // Delegate. Single source of truth for kaltmiete close_overlapping_only.
    return emitMieterhoehungClaims(mieterhoehungEnvelope as any, context);
  }

  // Non-rent scope → one reference claim, no closures.
  const subject = isPresent(f.unit_ref) && f.unit_ref?.normalized_value
    ? `unit:${f.unit_ref.normalized_value}`
    : "property";

  const referenceClaim: Claim = {
    property_id: context.property_id,
    subject,
    predicate: "amendment_present",
    value: {
      scope,
      status: "unsupported_requires_review",
      payload: extractPayloadForScope(f, scope),
    },
    claim_kind: "reference",
    valid_from: isPresent(f.effective_date) ? f.effective_date?.normalized_value ?? todayIso() : todayIso(),
    valid_to: null,
    source_document_id: context.source_document_id,
    source_extraction_run_id: context.source_extraction_run_id,
    source_field_path: "fields.nachtrag_scope",
    confidence: "medium",
    evidence_id: context.evidence_id_for_field("fields.nachtrag_scope"),
    source_type: "document_extraction",
    human_actor_id: null,
  };

  return { claims_to_insert: [referenceClaim], closure_intents: [] };
}
```

**Match the actual shipped Claim shape from Step 0.** The `value.status` representation, the exact field names, and the `reference` claim_kind must align with the shipped types. If `reference` isn't an accepted claim_kind, STOP and flag.

---

## Step 4 — Register

`src/lib/emitters/index.ts`:
```typescript
import { emitMietvertragsnachtragClaims } from "./mietvertragsnachtrag";
// ...
  mietvertragsnachtrag: { fn: emitMietvertragsnachtragClaims, version: "1.0.0" },
```

`schemas/index.ts`: register `mietvertragsnachtrag` mirroring how 2.1/2.3 registered their doc_types.

---

## Step 5 — Step 4 classifier prompt

In the classification prompt file (located in Step 0), add explicit guidance distinguishing the two doc_types by WHAT changes:

> **mieterhoehung vs mietvertragsnachtrag:** Classify by what the document
> changes, not its title. If the PRIMARY change is the Kaltmiete (rent amount)
> and the document is a unilateral landlord notice citing §558 (Vergleichsmieten)
> or §559 (Modernisierung) → `mieterhoehung`. If the document is a bilateral
> amendment (both parties sign) changing ANY term — including rent, but also
> deposit, ancillary costs, lease term, permitted use (pets/parking/subletting),
> or party details → `mietvertragsnachtrag`. A document titled "Nachtrag" that
> only raises rent via §558 is still `mieterhoehung`. A document titled
> "Mieterhöhung" that actually changes parking rights is `mietvertragsnachtrag`.
> When the primary change is non-rent, always choose `mietvertragsnachtrag`.

Keep the change minimal and additive — do not restructure the existing prompt.

---

## Step 6 — Tests

`src/tests/emitter-mietvertragsnachtrag.test.ts`, 4 scenarios, ≥20 assertions.

**Scenario 1 — Pet-clause (usage_right_change):**
- Envelope: nachtrag_scope=usage_right_change, usage_right_change_payload={ change: "Hundehaltung erlaubt" }, unit_ref=1.OG
- Assert: 1 claim, claim_kind=reference, predicate=amendment_present, value.scope=usage_right_change, value.status=unsupported_requires_review, 0 closures

**Scenario 2 — Tenant identity change:**
- Envelope: nachtrag_scope=tenant_identity_change, payload={ old_name, new_name }
- Assert: 1 reference claim, 0 closures (tenant_active stays open — assert no closure_intents target tenant_active)

**Scenario 3 — Bilateral rent change (delegation):**
- Envelope: nachtrag_scope=rent_change, rent_change_payload={ new_kaltmiete: {amount:60000,currency:EUR}, previous_kaltmiete:{amount:55000,...} }, effective_date=2024-07-01, unit_ref=EG, landlord_signature_present=true, document_status=signed
- Assert: result matches a Mieterhöhung EmissionResult — 2 claims (kaltmiete assertion + kaltmiete_amended event) + 1 closure intent (close_overlapping_only, target kaltmiete, close_at=2024-06-30)
- Assert: the kaltmiete claim value.amount === 60000

**Scenario 4 — Misclassification rejection:**
- Build a usage_right_change envelope but feed it directly to `emitMieterhoehungClaims` (simulating Step 4 misrouting)
- Assert: emitMieterhoehungClaims THROWS (new_kaltmiete absent) — the safe loud failure

---

## Step 7 — Purity gate + ARCHITECTURE_STATE.md

Add `src/lib/emitters/mietvertragsnachtrag.ts` to `emitter-purity.test.ts`'s file list.

Note: the purity gate forbids imports of LLM/prompt/extraction modules — but importing ANOTHER EMITTER (`./mieterhoehung`) is fine (it's a pure function too). Confirm the purity gate doesn't flag emitter-to-emitter imports; if it does, adjust the gate's allowlist to permit `src/lib/emitters/*` cross-imports.

Append ARCHITECTURE_STATE.md section documenting the delegation pattern and the reference-claim-only behavior for non-rent scopes.

---

## Step 8 — Verify

```bash
cd ~/repos/property-management-saas
npm run gen:schemas
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-mietvertragsnachtrag.test.ts | tail -30
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-purity.test.ts | tail -10
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/schemas.test.ts | tail -5

# regression
for f in src/tests/emitter-*.test.ts src/tests/integration/*.test.ts; do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -2
done

npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

---

## Step 9 — PR

```bash
git add domain_knowledge/mietvertragsnachtrag.md \
        schemas/mietvertragsnachtrag/ \
        schemas/index.ts \
        src/lib/emitters/mietvertragsnachtrag.ts \
        src/lib/emitters/index.ts \
        src/tests/emitter-mietvertragsnachtrag.test.ts \
        src/tests/emitter-purity.test.ts \
        supabase/functions/process-document/ \
        ARCHITECTURE_STATE.md
git commit -m "feat(emitters): add Mietvertragsnachtrag doc_type with delegation (Task 2.1b)

New doc_type catching non-rent lease amendments (pet clauses, parking,
deposit, ancillary cost, term, party changes) that would otherwise be lost
or misemitted by the rent-centric Mieterhöhung emitter.

- domain_knowledge/mietvertragsnachtrag.md: default_claim_kind reference,
  five gotchas, closes entry that delegates rent_change to Mieterhöhung
- schemas/mietvertragsnachtrag/schema.yaml: nachtrag_scope enum + per-scope
  structured payloads
- src/lib/emitters/mietvertragsnachtrag.ts: rent_change → reshape + delegate
  to emitMieterhoehungClaims (single source of truth for kaltmiete
  supersession); non-rent scopes → one reference 'amendment_present' claim,
  status unsupported_requires_review, no closures (tenant_active stays open)
- Step 4 classifier prompt: distinguish the two doc_types by WHAT changes,
  not document title
- registrations: EMITTERS map + schemas index
- tests: pet-clause, tenant-identity-change, bilateral-rent-change delegation,
  misclassification rejection
- ARCHITECTURE_STATE.md: Task 2.1b section"
git push -u origin feature/task-2.1b-mietvertragsnachtrag
```

PR:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.1b-mietvertragsnachtrag
```

---

## Definition of done

- [ ] Step 0 contracts verified; delegation envelope shape matches the Mieterhöhung emitter exactly
- [ ] domain knowledge + schema created, generator clean, doc_type registered
- [ ] emitter created, pure, delegation works
- [ ] classifier prompt distinguishes the two doc_types
- [ ] 4 test scenarios, ≥20 assertions, all pass (esp. delegation produces Mieterhöhung-shaped result + misclassification throws)
- [ ] purity gate extended + passes (emitter-to-emitter import allowed)
- [ ] tsc clean, regression passes, tenant-isolation clean
- [ ] PR merged

---

## Notes for reviewer

**Delegation, not duplication.** The rent_change scope routes to the Mieterhöhung emitter rather than reimplementing kaltmiete supersession. This is the single most important design choice: it guarantees a bilateral rent-change Nachtrag and a unilateral §558 notice produce byte-identical claim shapes and identical close_overlapping_only behavior. If we duplicated the logic, the two paths would drift. The cost is a small envelope-reshaping step; the benefit is one source of truth.

**Non-rent scopes are deliberately inert.** They emit a single reference claim and close nothing. A tenant_identity_change does NOT touch the tenant_active claim — the tenancy continues; only a party detail changed. Emitting reference-only claims means the amendment is recorded and surfaced in triage without any resolver-backed fact being mutated by a scope we don't yet fully model. When we later model deposit/term/usage changes as actionable, the reference claims are already there to upgrade.

**The misclassification rejection is a feature.** Scenario 4 asserts that feeding a non-rent Nachtrag to the Mieterhöhung emitter throws. This is the safety property: if the Step 4 classifier misroutes, the failure is loud (triage flag) rather than silent (rent corruption). The split doc_type plus the Mieterhöhung emitter's hard error on absent new_kaltmiete together form the guard.

**Multi-scope documents defer rather than partially emit.** A Nachtrag changing both rent and parking sets nachtrag_scope to rent_change (rent is highest-stakes) and flags review for the secondary term, OR sets "other" if no rent is involved. We never emit a partial set of claims for a multi-scope document — partial silent emission is the failure mode we're eliminating. Full multi-scope handling is later scope.

**Classifier prompt change is additive and minimal.** The Step 4 prompt gets a focused paragraph distinguishing the two doc_types by what changes. We do not restructure the prompt. The risk of prompt changes is regression in OTHER doc_types' classification; keeping the change additive and scoped minimizes that. The real validation is the adversarial fixture (nachtrag_misclassified_as_mieterhoehung_at_step4), which is a separate classifier-eval task — this task only ensures the emitter handles the misroute safely.

**Emitter-to-emitter import is acceptable purity.** The purity gate forbids LLM/prompt/extraction imports, but `mietvertragsnachtrag.ts` importing `mieterhoehung.ts` is fine — both are pure functions with no side effects. If the gate's pattern matching is too aggressive and flags the import, the fix is to allowlist `src/lib/emitters/*` cross-imports, not to weaken the gate's LLM/HTTP checks.
