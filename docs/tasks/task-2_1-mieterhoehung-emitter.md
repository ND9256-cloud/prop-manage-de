# Task 2.1 — Mieterhöhung schema, domain knowledge, emitter

**Task type:** t2 L (new doc_type spans schema YAML + domain knowledge + emitter + tests; introduces the first closure-emitting emitter, second-order interactions with applier; requires review before merge)

**Branch:** `feature/task-2.1-mieterhoehung-emitter`

**Reference:**
- `extraction-v2-implementation-plan.md` → Task 2.1 acceptance criteria
- Architecture §5.5 (closure pattern), §5.5.2 (closing matrix), §5.5.3 (three close_modes), §5.5.4 (applier safety rules), §5.5.5 (claim-aware blockers)
- Architecture §6.3 (domain knowledge file format) — the existing `domain_knowledge/mietvertrag.md` is the precedent pattern
- Architecture §4.4 (emitter purity rules)
- Existing patterns: `src/lib/emitters/mietvertrag.ts` (Task 1.7), `src/lib/emitters/types.ts` (EmissionResult, ClosureIntent, EmissionContext), `src/lib/emitters/index.ts` (the EMITTERS registry — new emitter goes here)

**Phase 2 success criterion this task delivers:** Mieterhöhung documents produce two outputs through the chain: (a) a new `kaltmiete` assertion claim for the unit with `valid_from = effective_date`, and (b) a closure intent that closes the previous kaltmiete claim via `close_overlapping_only`, with the applier's claim-aware Staffelmiete check (§5.5.5) deciding whether to apply or suspend the closure. After Task 2.2 ships, Paul's rent goes from €525 → €575 correctly.

---

## Scope

Three deliverables, in dependency order:

1. **`domain_knowledge/mieterhoehung.md`** — front-matter declares this doc_type's `closes` rule and the canonical gotchas. This file is the contract.
2. **`schemas/mieterhoehung/schema.yaml`** — extraction fields Sonnet must populate. Schema fields drive the prompt fragment and the validator.
3. **`src/lib/emitters/mieterhoehung.ts`** — pure function. Given a Mieterhöhung extraction envelope, produces an EmissionResult with one new kaltmiete claim + (when prerequisites are met) one ClosureIntent.

Plus required registration: add `mieterhoehung` to `src/lib/emitters/index.ts` EMITTERS map so the HTTP bridge (Task 1.9 route) can dispatch to it.

Plus tests: ≥25 assertions, three core scenarios (Paul happy path, draft-no-signatures, Staffelmiete-in-extraction blocker flag).

---

## Out of scope

- **Mietvertragsnachtrag** (Task 2.1b) — separate doc_type for non-rent amendments. Parallel task.
- **End-to-end Paul case test** (Task 2.2) — depends on this task + Task 1.8 (already shipped).
- **Step 4 classifier prompt update** to distinguish Mieterhöhung from Mietvertragsnachtrag — that's part of 2.1b.
- **Predicate-pair allowlist generator** — Task 1.8's applier still has a TODO note for this; Phase 2 second wave. For now the applier accepts any (event_predicate, target_predicate) pair without checking the allowlist; this task does NOT close that gap.
- **Evidence-row population** — closure_intent's evidence remains null for now; Phase 2 second wave.
- **Indexmiete recomputation jobs** (§558 + Indexmiete clauses produce future recomputation, not pre-emitted claims) — separate later task.
- **Sonnet prompt fragment for Mieterhöhung extraction** — the schema YAML drives this via the existing generator from Phase 0 (Task 0.3); regenerate is automatic via `pnpm gen:schemas` per the plan. If the generator doesn't already cover Mieterhöhung doc_type, this task adds it minimally; if it does, no extra prompt code.

---

## Files touched

- `domain_knowledge/mieterhoehung.md` — new
- `schemas/mieterhoehung/schema.yaml` — new
- `schemas/mieterhoehung/*` (any generator-produced files) — regenerated
- `src/lib/emitters/mieterhoehung.ts` — new
- `src/lib/emitters/index.ts` — add `mieterhoehung` to EMITTERS map
- `src/tests/emitter-mieterhoehung.test.ts` — new (≥25 assertions, 3 scenarios)
- `ARCHITECTURE_STATE.md` — append "Mieterhöhung emitter shipped" section

**NOT touched:**
- `src/lib/claim-store/applier.ts` — applier is general; no changes needed (§5.5.5's Staffelmiete check is the applier's responsibility, but it should already be there from Task 1.8 — verify before starting; if missing, that's a separate task)
- `src/lib/resolvers/*` — resolver already handles multi-claim closure case (Task 1.10)
- Edge Function — no Deno-side changes; the HTTP bridge uses the emitter registry
- DB schema — no migrations

---

## Repo conventions (recap)

- npm (not pnpm — `pnpm gen:schemas` in the plan is shorthand; project uses npm. Verify command: `npm run gen:schemas` or whatever exists in package.json scripts; substitute accordingly)
- tsc clean, lint clean
- Tests run via `DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <file>`
- Branch protection on main, feature branch + PR
- Single descriptive commit per PR
- Test files use relative imports (`../../lib/...`) matching Task 1.10 precedent

---

## Step 0 — Verify applier has the Staffelmiete check

Before starting: confirm `src/lib/claim-store/applier.ts` already implements the Mieterhöhung + Staffelmiete check per §5.5.5. The Task 1.8 brief mentioned this as one of the three blocker checks ("staffelmiete_conflict"). Quick grep:

```bash
grep -n "staffelmiete\|Staffel" src/lib/claim-store/applier.ts
```

If absent — STOP and flag. The Staffelmiete check belongs in the applier, not this task. We'd need to either ship it as a quick prerequisite or scope down this task to not produce closures yet.

Assume present. Proceed.

---

## Step 1 — `domain_knowledge/mieterhoehung.md`

The file format is the front-matter spec from architecture §6.3 (see `domain_knowledge/mietvertrag.md` for the existing pattern). Front-matter is machine-readable contract; markdown body is human prose.

```markdown
---
doc_type: mieterhoehung
default_claim_kind: assertion
last_updated: 2026-05-27
legal_grounding:
  - statute: BGB §557
    description: General rules for rent increases in residential lease
  - statute: BGB §558
    description: Vergleichsmieten-Erhöhung — increase to local comparable rents
  - statute: BGB §559
    description: Modernisierungsmieterhöhung — increase after modernization
  - statute: BGB §559b
    description: Form requirements for Modernisierungsmieterhöhung
  - statute: BGB §560
    description: Indexmiete-based increases
fields_governed:
  - new_kaltmiete
  - previous_kaltmiete
  - effective_date
  - notice_date
  - unit_ref
  - tenant_identity
  - landlord_signature_present
  - tenant_signature_present
  - rechtsgrundlage
  - nachtrag_typ
normalization_rules:
  - id: effective_date_required_for_closure
    field: effective_date
    description: |
      A Mieterhöhung without an effective_date cannot produce a closure
      intent. The new kaltmiete claim is still emitted with reduced
      confidence ("medium") and the closure intent is omitted entirely.
      The case surfaces in triage for manual effective_date setting.
  - id: signature_requirements_per_grundlage
    field: tenant_signature_present
    description: |
      §558 (Vergleichsmieten) and §559 (Modernisierung) are unilateral
      landlord notices — tenant signature is NOT required for legal
      validity. Indexmiete and Staffelmiete amendments via bilateral
      agreement (a true Mietvertragsnachtrag with rent change scope)
      DO require tenant signature. Emitter uses landlord_signature_present
      as the prerequisite; tenant_signature_present is informational.
gotchas:
  - id: scope_narrowed_to_rent_change
    description: |
      This doc_type covers ONLY rent-change amendments. Non-rent
      Nachträge (pet clauses, parking, ancillary cost reallocation)
      belong to mietvertragsnachtrag. Misclassification causes silent
      data loss: emitter expects new_kaltmiete and either rejects the
      extraction or produces wrong claims.
    real_failure_reference: nachtrag_misclassified_as_mieterhoehung
  - id: kappungsgrenze_15_percent
    description: |
      §558 increases are capped at 15% within three years (some
      municipalities tighten this to 15% absolute or 20%). The emitter
      does NOT enforce the cap — that's a downstream presenter/legal
      review concern. Extraction must preserve previous_kaltmiete so
      the cap can be evaluated.
  - id: tenant_consent_requirement
    description: |
      Bilateral rent-change amendments (where both parties sign) are
      legally distinct from unilateral §558/§559 notices. Both arrive
      as Mieterhöhung doc_type but the consent path matters for
      enforceability. Emitter records tenant_signature_present so
      downstream can distinguish.
  - id: effective_date_vs_notice_date
    description: |
      §558 increases require a Zustimmungsfrist (consent window) that
      delays the effective_date well past notice_date. Emitter uses
      effective_date for the new claim's valid_from, never notice_date.
      If effective_date is absent and notice_date is present, the
      emitter does NOT default to notice_date — it omits the closure
      intent (see normalization_rule effective_date_required_for_closure).
  - id: future_dated_increase_no_immediate_closure
    description: |
      A Mieterhöhung with effective_date > today produces a future-dated
      kaltmiete claim. The closure intent's close_at = effective_date - 1
      day. The applier applies the closure as part of the same
      transaction; the OLD claim's valid_to is set in the past relative
      to when the increase actually takes effect. Resolver queries with
      as_of_date < effective_date still return the OLD rent (correct).
  - id: staffelmiete_mid_schedule_amendment
    description: |
      If the unit has existing future-dated Staffelmiete claims
      (pre-emitted from a Mietvertrag with Staffelplan), a Mieterhöhung
      arriving mid-schedule creates ambiguity: does the new agreement
      supersede the entire Staffelplan or just the next step? The
      emitter sets the closure intent's blocker_status to
      "requires_review" if the source extraction signals Staffelmiete
      context (field staffelmiete_context = true). The applier then
      ALSO independently checks open future-dated kaltmiete claims via
      §5.5.5 and respects requires_review regardless. Two layers of
      safety; human adjudicates in triage.
    real_failure_reference: staffelmiete_amendment_ambiguity
  - id: closure_prerequisites
    description: |
      Emitter omits the closure intent entirely (still emits the new
      kaltmiete claim with reduced confidence) if any prerequisite
      fails: missing effective_date, missing unit_ref, document_status
      is "draft" or "unsigned", landlord_signature_present is false.
      The new claim is emitted as informational with confidence "low"
      so it appears in triage but does not silently overwrite the
      open kaltmiete via the close_overlapping_only semantics.
adversarial_fixtures_required:
  - paul_mieterhoehung_625_to_650
  - mieterhoehung_draft_unsigned
  - mieterhoehung_with_staffelmiete_context
  - mieterhoehung_missing_effective_date
  - mieterhoehung_indexmiete_recomputation
  - mieterhoehung_misclassified_pet_clause_nachtrag
closes:
  - trigger_predicate: kaltmiete_amended
    target_subject_template: "unit:<unit_ref>"
    target_predicates:
      - kaltmiete
    match:
      unit_ref: required
      tenant_identity: optional
    close_mode: close_overlapping_only
    close_at_template: "<effective_date> - 1 day"
    when:
      - landlord_signature_present == true
      - effective_date is present
      - unit_ref is present
      - document_status != "draft"
      - document_status != "unsigned"
---

# Mieterhöhung — domain knowledge

A Mieterhöhung is a rent-increase amendment to an existing Mietvertrag.
German tenancy law treats different grounds (Rechtsgrundlagen) differently:

- **§558 (Vergleichsmieten)** — landlord notice citing local comparable rents.
  Unilateral; tenant has a Zustimmungsfrist (consent window). Effective date
  is typically 3 months after notice. Capped at 15-20% over 3 years
  (Kappungsgrenze).
- **§559 (Modernisierung)** — landlord notice after qualifying modernization.
  Unilateral with form requirements per §559b. No consent window in the same
  sense — tenant can object on hardship grounds but the increase generally
  takes effect.
- **Indexmiete (§560)** — automatic adjustment formula tied to the consumer
  price index. The Mieterhöhung document declares the new amount; the
  formula was agreed in the original Mietvertrag.
- **Staffelmiete (§557a)** — pre-agreed schedule in the original Mietvertrag.
  No separate Mieterhöhung document is needed for normal schedule steps; a
  Mieterhöhung document arriving in a Staffelmiete context typically signals
  a renegotiation that supersedes the schedule.
- **Bilateral Mietvertragsnachtrag with rent-change scope** — both parties
  sign a fresh amendment changing the rent. Legally robust; no consent
  window because consent is in the signature.

The emitter does not pick between these — it records `rechtsgrundlage` and
trusts downstream presenters to surface the legal context. What it DOES
enforce is the closure prerequisite chain: no signature, no closure.
```

The `closes` field is **the contract with the applier**. CI consumer-contract checks (§6.4) will eventually generate the predicate-pair allowlist from this. Right now the applier accepts any pair, but the front-matter is still authoritative once the generator catches up — write it correctly today.

---

## Step 2 — `schemas/mieterhoehung/schema.yaml`

Mirror the existing `schemas/mietvertrag/schema.yaml` structure. Required fields:

```yaml
doc_type: mieterhoehung
schema_version: 2026-05-27-v1
domain_knowledge_ref: domain_knowledge/mieterhoehung.md

fields:
  nachtrag_typ:
    type: enum
    enum_values:
      - mieterhoehung
      - mietvertragsnachtrag_rent_change
      - mietvertragsnachtrag_other
    description: |
      Discriminates Mieterhöhung from Mietvertragsnachtrag and from
      bilateral rent-change amendments. mieterhoehung = unilateral
      §558/§559 notice; mietvertragsnachtrag_rent_change = bilateral
      amendment that happens to change rent; mietvertragsnachtrag_other
      = non-rent amendment (should not reach this emitter).
    absence_states: [absent, illegible, contradicted]

  rechtsgrundlage:
    type: enum
    enum_values:
      - "§558"          # Vergleichsmieten
      - "§559"          # Modernisierung
      - "indexmiete"    # §560
      - "staffelmiete"  # §557a (atypical here, usually only in original Mietvertrag)
      - "bilateral"     # both-party signed amendment
      - "unspecified"
    description: |
      Legal grounds for the rent increase. Drives downstream
      interpretation (cap rules, form requirements). Not used by
      emitter for emission decisions.
    absence_states: [absent, illegible, contradicted]

  new_kaltmiete:
    type: money
    description: |
      The new kaltmiete after this Mieterhöhung takes effect, in EUR.
      Stored as { amount: <minor_units>, currency: "EUR", raw_value: "<source>" }.
    absence_states: [absent, illegible, contradicted]

  previous_kaltmiete:
    type: money
    description: |
      The kaltmiete being superseded. Used downstream for Kappungsgrenze
      evaluation. Not required for emission.
    absence_states: [absent, illegible, contradicted]

  effective_date:
    type: date
    description: |
      Date the new rent takes effect. ISO YYYY-MM-DD. Drives the new
      claim's valid_from and the closure intent's close_at.
    absence_states: [absent, illegible, contradicted]

  notice_date:
    type: date
    description: |
      Date the notice was issued. NOT used for emission; informational.
    absence_states: [absent, illegible, contradicted]

  unit_ref:
    type: string
    description: |
      Unit reference matching the Mietvertrag's unit_ref (e.g., "1.OG",
      "EG", "DG"). Required for claim subject construction.
    absence_states: [absent, illegible, contradicted]

  tenant_identity:
    type: tenant_identity
    description: |
      The tenant party to the lease being amended. Same shape as
      mietvertrag's tenant_identity. Used for closure match (optional
      strictness).
    absence_states: [absent, illegible, contradicted]

  landlord_signature_present:
    type: boolean
    description: |
      True if the document carries a landlord signature. For §558/§559
      this is the legally-required signature. For bilateral amendments
      both signatures are required; this field is one of two.
    absence_states: [absent, illegible]

  tenant_signature_present:
    type: boolean
    description: |
      True if the document carries a tenant signature. Required only
      for bilateral rent-change amendments. Informational for §558/§559.
    absence_states: [absent, illegible]

  document_status:
    type: enum
    enum_values:
      - draft
      - unsigned
      - signed
      - executed
    description: |
      Lifecycle state of the document. Emitter requires "signed" or
      "executed" to emit a closure intent.
    absence_states: [absent, illegible]

  staffelmiete_context:
    type: boolean
    description: |
      True if the source extraction detected language indicating the
      unit is on a Staffelmiete schedule (e.g., references to a
      Staffelplan in the original Mietvertrag context, or the
      Mieterhöhung document itself explicitly mentions superseding a
      Staffel step). Used by the emitter to set blocker_status on
      the closure intent. This is a HEURISTIC signal — the applier
      ALSO independently checks the claim store for open future-dated
      kaltmiete claims and applies its own blocker (§5.5.5).
    absence_states: [absent, illegible]

  paragraph_558_basis:
    type: structured_optional
    description: |
      Present only when rechtsgrundlage == "§558". Carries the
      comparable-rent justification.
    fields:
      vergleichswohnungen:
        type: array_of_strings
      mietspiegel_reference:
        type: string
      consent_deadline:
        type: date

  paragraph_559_basis:
    type: structured_optional
    description: |
      Present only when rechtsgrundlage == "§559". Carries the
      modernization basis.
    fields:
      modernization_cost_total:
        type: money
      annual_cost_share_percentage:
        type: number
      modernization_completed_on:
        type: date

  indexmiete_basis:
    type: structured_optional
    description: |
      Present only when rechtsgrundlage == "indexmiete". Carries the
      index reference for downstream recomputation.
    fields:
      index_reference_old:
        type: number
      index_reference_new:
        type: number
      index_publisher:
        type: string

verifiers:
  - id: new_kaltmiete_monetary_verbatim
    type: monetary-verbatim
    target_field: new_kaltmiete
  - id: previous_kaltmiete_monetary_verbatim
    type: monetary-verbatim
    target_field: previous_kaltmiete
    optional: true
  - id: effective_date_format
    type: date-format
    target_field: effective_date
  - id: notice_date_format
    type: date-format
    target_field: notice_date
    optional: true
  - id: rechtsgrundlage_enum
    type: enum
    target_field: rechtsgrundlage
  - id: document_status_enum
    type: enum
    target_field: document_status
```

Run the schema generator after writing this file:

```bash
npm run gen:schemas
```

If the script name differs, check `package.json` scripts section and use the matching one. The generator produces TypeScript types and validator code from the YAML — those are committed alongside.

---

## Step 3 — `src/lib/emitters/mieterhoehung.ts`

Pure function per Task 1.7 precedent. No DB queries. No HTTP. No LLM calls.

Key design decisions, all explicit:

1. **Emitter signature mirrors `emitMietvertragClaims`** — takes `(envelope, context) → EmissionResult`. Same EmitterContext shape.
2. **New kaltmiete claim is always emitted**, even when prerequisites for closure fail. Confidence is downgraded to "low" when prerequisites fail. This makes failures triageable without losing the data.
3. **Closure intent is conditional**:
   - All prerequisites must pass: `landlord_signature_present == true`, `effective_date` is present, `unit_ref` is present, `document_status` is `"signed"` or `"executed"`.
   - If any fails: no closure intent. Claim only.
4. **`blocker_status` is set when `staffelmiete_context == true`**. The emitter does NOT query the DB. It only reads the source extraction's `staffelmiete_context` boolean signal. The applier independently does the DB check per §5.5.5 and respects requires_review regardless.
5. **`tenant_active` is NOT emitted by Mieterhöhung.** The existing tenant claim from the original Mietvertrag remains valid. Mieterhöhung amends rent, not tenancy.
6. **`close_at = effective_date - 1 day`**. The applier converts this to a Postgres date; emitter passes it as an ISO string.

```typescript
// src/lib/emitters/mieterhoehung.ts
//
// Mieterhöhung claim emitter. Architecture §5.5.2 (closing matrix:
// kaltmiete_amended → kaltmiete, close_overlapping_only).
//
// Pure function. No DB queries, no HTTP, no LLM calls.
// CI purity gate enforces no LLM/prompt imports.

import type {
  EmissionResult,
  EmitterContext,
  ClosureIntent,
  ClaimToInsert,
} from "./types";

export const EMITTER_NAME = "mieterhoehung";
export const EMITTER_VERSION = "1.0.0";

interface MieterhoehungEnvelope {
  doc_type: "mieterhoehung";
  schema_version: string;
  fields: {
    new_kaltmiete?: { normalized_value?: { amount: number; currency: string; raw_value?: string }; absence_state?: string };
    previous_kaltmiete?: { normalized_value?: { amount: number; currency: string; raw_value?: string }; absence_state?: string };
    effective_date?: { normalized_value?: string; absence_state?: string };
    notice_date?: { normalized_value?: string; absence_state?: string };
    unit_ref?: { normalized_value?: string; absence_state?: string };
    tenant_identity?: { normalized_value?: { name: string; is_legal_entity?: boolean; legal_form?: string | null }; absence_state?: string };
    landlord_signature_present?: { normalized_value?: boolean; absence_state?: string };
    tenant_signature_present?: { normalized_value?: boolean; absence_state?: string };
    document_status?: { normalized_value?: string; absence_state?: string };
    rechtsgrundlage?: { normalized_value?: string; absence_state?: string };
    nachtrag_typ?: { normalized_value?: string; absence_state?: string };
    staffelmiete_context?: { normalized_value?: boolean; absence_state?: string };
    [k: string]: any;
  };
  lifecycle?: any;
}

export function emitMieterhoehungClaims(
  envelope: MieterhoehungEnvelope,
  ctx: EmitterContext
): EmissionResult {
  const f = envelope.fields ?? {};

  const new_kaltmiete = f.new_kaltmiete?.normalized_value ?? null;
  const effective_date = f.effective_date?.normalized_value ?? null;
  const unit_ref = f.unit_ref?.normalized_value ?? null;
  const landlord_signed = f.landlord_signature_present?.normalized_value ?? false;
  const document_status = f.document_status?.normalized_value ?? null;
  const staffelmiete_context = f.staffelmiete_context?.normalized_value === true;
  const tenant = f.tenant_identity?.normalized_value ?? null;

  // --- Required field checks (Mieterhöhung is undefined without these) ----
  if (!new_kaltmiete || typeof new_kaltmiete.amount !== "number") {
    throw new Error(
      `mieterhoehung emitter: new_kaltmiete is required but absent (absence_state=${f.new_kaltmiete?.absence_state ?? "missing"}); cannot emit`
    );
  }

  // --- Prerequisite check for closure (§5.5.5 / front-matter `when` clause)
  const prerequisitesMet =
    landlord_signed === true &&
    effective_date !== null &&
    unit_ref !== null &&
    document_status !== "draft" &&
    document_status !== "unsigned";

  // --- Build the new kaltmiete claim --------------------------------------
  // valid_from is effective_date when present; otherwise emit a low-confidence
  // claim with valid_from = notice_date if available, else today.
  // Confidence is downgraded if prerequisites fail.
  const valid_from = effective_date
    ?? f.notice_date?.normalized_value
    ?? new Date().toISOString().slice(0, 10);

  const subject = unit_ref ? `unit:${unit_ref}` : `unit:unknown`;
  const confidence: "high" | "medium" | "low" =
    prerequisitesMet ? "high" : "low";

  const newClaim: ClaimToInsert = {
    subject,
    predicate: "kaltmiete",
    value: {
      amount: new_kaltmiete.amount,
      currency: new_kaltmiete.currency,
      raw_value: new_kaltmiete.raw_value,
    },
    claim_kind: "assertion",
    source_type: "document_extraction",
    source_document_id: ctx.source_document_id,
    source_extraction_run_id: ctx.source_extraction_run_id,
    source_field_path: "fields.new_kaltmiete",
    valid_from,
    valid_to: null,
    confidence,
  };

  // --- Build closure intent if prerequisites met --------------------------
  const closure_intents: ClosureIntent[] = [];

  if (prerequisitesMet) {
    // close_at = effective_date - 1 day
    const effDate = new Date(effective_date as string + "T00:00:00.000Z");
    effDate.setUTCDate(effDate.getUTCDate() - 1);
    const close_at = effDate.toISOString().slice(0, 10);

    closure_intents.push({
      target_subject: subject,
      target_predicate: "kaltmiete",
      close_at,
      close_mode: "close_overlapping_only",
      match: tenant?.name ? { tenant_identity: tenant.name } : {},
      match_strictness: tenant?.name ? "optional" : "absent",
      blocker_status: staffelmiete_context ? "requires_review" : "none",
      triggering_event_predicate: "kaltmiete_amended",
      source_extraction_run_id: ctx.source_extraction_run_id,
      source_field_path: "fields.effective_date",
    });
  }

  return {
    claims_to_insert: [newClaim],
    closure_intents,
    emitter_name: EMITTER_NAME,
    emitter_version: EMITTER_VERSION,
  };
}
```

**Type imports caveat:** `ClosureIntent` may or may not exist in `src/lib/emitters/types.ts` yet. Mietvertrag emits no closures (it's just an assertion), so the type may not have been defined. If absent, ADD `ClosureIntent` to `types.ts` matching the architecture §5.5.3 shape (`target_subject`, `target_predicate`, `close_at`, `close_mode`, `match`, `match_strictness`, `blocker_status`, `triggering_event_predicate`, `source_extraction_run_id`, `source_field_path`). The applier (Task 1.8) consumes ClosureIntent already — its `applier.ts` must reference the same type; either import from a shared types module or check that the shapes match exactly. If the applier uses a different type name (e.g., `ClaimClosure`), this emitter must produce that exact shape.

**Verify type alignment BEFORE writing the emitter** — read `src/lib/claim-store/applier.ts` and `src/lib/emitters/types.ts` together to confirm the closure-intent shape the applier expects. Any mismatch breaks the integration.

---

## Step 4 — Register in EMITTERS map

`src/lib/emitters/index.ts`:

```typescript
import { emitMietvertragClaims } from "./mietvertrag";
import { emitMieterhoehungClaims } from "./mieterhoehung";

export const EMITTERS = {
  mietvertrag: { fn: emitMietvertragClaims, version: "1.0.0" },
  mieterhoehung: { fn: emitMieterhoehungClaims, version: "1.0.0" },
};
```

The HTTP bridge route (`/api/pipeline/apply-emission`) reads this map by `envelope.doc_type` and dispatches. No bridge code change needed.

---

## Step 5 — Tests

Create `src/tests/emitter-mieterhoehung.test.ts`. Three scenarios, ≥25 assertions.

### Scenario 1 — Paul Mieterhöhung happy path (€525 → €575, signed, no Staffelmiete)

Synthetic envelope with all prerequisites met:

```typescript
const envelope = {
  doc_type: "mieterhoehung",
  schema_version: "2026-05-27-v1",
  fields: {
    new_kaltmiete: { normalized_value: { amount: 57500, currency: "EUR", raw_value: "575,00 €" } },
    previous_kaltmiete: { normalized_value: { amount: 52500, currency: "EUR", raw_value: "525,00 €" } },
    effective_date: { normalized_value: "2024-01-01" },
    notice_date: { normalized_value: "2023-09-15" },
    unit_ref: { normalized_value: "EG" },
    tenant_identity: { normalized_value: { name: "Paul, Test", is_legal_entity: false, legal_form: null } },
    landlord_signature_present: { normalized_value: true },
    tenant_signature_present: { normalized_value: false },
    document_status: { normalized_value: "signed" },
    rechtsgrundlage: { normalized_value: "§558" },
    nachtrag_typ: { normalized_value: "mieterhoehung" },
    staffelmiete_context: { normalized_value: false },
  },
  lifecycle: {},
};
```

Assertions:
1. `result.claims_to_insert.length === 1`
2. `result.claims_to_insert[0].predicate === "kaltmiete"`
3. `result.claims_to_insert[0].subject === "unit:EG"`
4. `result.claims_to_insert[0].value.amount === 57500`
5. `result.claims_to_insert[0].claim_kind === "assertion"`
6. `result.claims_to_insert[0].valid_from === "2024-01-01"`
7. `result.claims_to_insert[0].confidence === "high"`
8. `result.closure_intents.length === 1`
9. `result.closure_intents[0].target_subject === "unit:EG"`
10. `result.closure_intents[0].target_predicate === "kaltmiete"`
11. `result.closure_intents[0].close_mode === "close_overlapping_only"`
12. `result.closure_intents[0].close_at === "2023-12-31"`
13. `result.closure_intents[0].blocker_status === "none"`
14. `result.closure_intents[0].match.tenant_identity === "Paul, Test"`
15. `result.closure_intents[0].match_strictness === "optional"`
16. `result.closure_intents[0].triggering_event_predicate === "kaltmiete_amended"`

### Scenario 2 — Draft / unsigned (no closure)

Same as Scenario 1 but `landlord_signature_present: false` and `document_status: "draft"`.

Assertions:
17. `result.claims_to_insert.length === 1` (still emit the claim)
18. `result.claims_to_insert[0].confidence === "low"` (downgraded)
19. `result.closure_intents.length === 0` (no closure)

### Scenario 3 — Staffelmiete context (requires_review blocker)

Same as Scenario 1 but `staffelmiete_context: { normalized_value: true }`.

Assertions:
20. `result.claims_to_insert.length === 1`
21. `result.claims_to_insert[0].confidence === "high"` (prerequisites met)
22. `result.closure_intents.length === 1`
23. `result.closure_intents[0].blocker_status === "requires_review"`
24. `result.closure_intents[0].close_mode === "close_overlapping_only"` (still produces the closure; just flagged)
25. `result.closure_intents[0].target_subject === "unit:EG"`

### Optional Scenario 4 — Missing new_kaltmiete (throws)

Envelope with `new_kaltmiete: { absence_state: "absent" }`. Expect `emitMieterhoehungClaims` to throw with a descriptive error.

Add ≥1 assertion using assert.throws.

---

## Step 6 — Emitter purity gate

Update `src/tests/emitter-purity.test.ts` (if it exists; otherwise check Task 1.7's path) to also lint the new file:

```typescript
const FILES_TO_CHECK = [
  "src/lib/emitters/types.ts",
  "src/lib/emitters/mietvertrag.ts",
  "src/lib/emitters/mieterhoehung.ts",  // NEW
];
```

The gate asserts no LLM/prompt/extraction/HTTP imports in any emitter file. Same forbidden patterns as Task 1.7.

---

## Step 7 — ARCHITECTURE_STATE.md update

Append:

```markdown
## Mieterhöhung emitter shipped (Task 2.1, 2026-05-27)

Second doc_type in the v2 chain. First emitter that produces closure intents.

**Shipped:**
- `domain_knowledge/mieterhoehung.md` — front-matter declares the `closes`
  rule (trigger_predicate: kaltmiete_amended, target: kaltmiete, close_mode:
  close_overlapping_only) and the seven required gotchas
- `schemas/mieterhoehung/schema.yaml` — extraction fields including
  nachtrag_typ, rechtsgrundlage, new_kaltmiete, previous_kaltmiete,
  effective_date, notice_date, unit_ref, tenant_identity, signature flags,
  document_status, staffelmiete_context, and §558/§559/Indexmiete-specific
  structured fields
- `src/lib/emitters/mieterhoehung.ts` — pure function: emits one new
  kaltmiete claim (always) + one ClosureIntent when prerequisites pass
  (landlord_signed, effective_date present, unit_ref present, document_status
  not draft/unsigned). Sets blocker_status="requires_review" if extraction
  signaled staffelmiete_context=true. The applier independently re-checks
  the Staffelmiete blocker per §5.5.5.
- `src/lib/emitters/index.ts` — `mieterhoehung` registered for HTTP bridge dispatch
- `src/tests/emitter-mieterhoehung.test.ts` — 25+ assertions across happy
  path, draft-no-closure, and Staffelmiete-blocker scenarios

**Pending (separate tasks):**
- Task 2.1b: Mietvertragsnachtrag (non-rent amendments)
- Task 2.2: End-to-end Paul case test (supersession through full chain)
- Predicate-pair allowlist generator (CI consumer-contract per §6.4 — when
  it lands, this front-matter's `closes` is the source of truth)
- Evidence-row population for closure intents (still null)
- Indexmiete recomputation jobs (future field-level resolver)
```

---

## Step 8 — Verify locally

```bash
cd ~/repos/property-management-saas
git pull
git checkout -b feature/task-2.1-mieterhoehung-emitter

# Schema generator
npm run gen:schemas
git status  # check what generator produced

# Type check
DOTENV_CONFIG_PATH=.env.local npx tsc --noEmit | cat

# Emitter purity gate (extended to cover mieterhoehung.ts)
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-purity.test.ts | tail -10

# Mieterhöhung emitter test
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config src/tests/emitter-mieterhoehung.test.ts | tail -30

# Full existing suite for regression
for f in $(find src/tests -name "*.test.ts"); do
  echo "=== $f ===" && DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config "$f" 2>&1 | tail -3 || break
done

# Tenant-isolation gate
npx tsx tools/tenant-isolation-lint/index.ts | tail -5
```

All tests pass, tsc silent.

---

## Step 9 — PR

```bash
git add domain_knowledge/mieterhoehung.md \
        schemas/mieterhoehung/ \
        src/lib/emitters/mieterhoehung.ts \
        src/lib/emitters/index.ts \
        src/lib/emitters/types.ts \
        src/tests/emitter-mieterhoehung.test.ts \
        src/tests/emitter-purity.test.ts \
        ARCHITECTURE_STATE.md
# Also add any generator outputs that landed under schemas/mieterhoehung/

git commit -m "feat(emitters): add Mieterhöhung emitter with closure intents (Task 2.1)

Second doc_type in the v2 chain. First emitter that produces closure intents
per architecture §5.5.2 (trigger kaltmiete_amended, close_overlapping_only).

- domain_knowledge/mieterhoehung.md: front-matter declares closes rule,
  seven required gotchas (scope_narrowed_to_rent_change,
  kappungsgrenze_15_percent, tenant_consent_requirement,
  effective_date_vs_notice_date, future_dated_increase_no_immediate_closure,
  staffelmiete_mid_schedule_amendment, closure_prerequisites)
- schemas/mieterhoehung/schema.yaml: 12+ fields including nachtrag_typ,
  rechtsgrundlage (§558/§559/Indexmiete/Staffelmiete/bilateral), signatures,
  document_status, staffelmiete_context, and §558/§559/Indexmiete-specific
  structured sub-objects
- src/lib/emitters/mieterhoehung.ts: pure function, no DB queries.
  Always emits the new kaltmiete claim (confidence downgraded to 'low'
  when prerequisites fail). Emits closure_intent only when prerequisites
  pass. Sets blocker_status='requires_review' if staffelmiete_context true.
- src/lib/emitters/index.ts: register mieterhoehung in EMITTERS map
- src/tests/emitter-mieterhoehung.test.ts: 25+ assertions, 3 scenarios
- src/tests/emitter-purity.test.ts: extend purity gate to mieterhoehung.ts
- ARCHITECTURE_STATE.md: Task 2.1 section"
git push -u origin feature/task-2.1-mieterhoehung-emitter
```

PR via:
```
https://github.com/ND9256-cloud/prop-manage-de/compare/main...feature/task-2.1-mieterhoehung-emitter
```

---

## Definition of done

- [ ] `domain_knowledge/mieterhoehung.md` created, front-matter valid per `_schema.yaml`
- [ ] `schemas/mieterhoehung/schema.yaml` created with all required fields
- [ ] `npm run gen:schemas` produces clean output, no errors
- [ ] `src/lib/emitters/mieterhoehung.ts` created as pure function
- [ ] `src/lib/emitters/index.ts` registers mieterhoehung
- [ ] If `ClosureIntent` type was missing from `src/lib/emitters/types.ts`, it has been added matching the applier's expected shape
- [ ] `src/tests/emitter-mieterhoehung.test.ts` reports ≥25 assertions, all OK
- [ ] `src/tests/emitter-purity.test.ts` passes for both mietvertrag.ts AND mieterhoehung.ts
- [ ] `npx tsc --noEmit` silent
- [ ] All existing tests pass (regression check)
- [ ] tenant-isolation gate clean
- [ ] Branch pushed, PR opened, CI green
- [ ] ARCHITECTURE_STATE.md section appended
- [ ] PR merged into main

---

## Notes for reviewer

**The closure intent's `blocker_status` is set by the emitter from extraction signals, not from a DB query.** The architecture's §5.5.5 specifies the applier does the authoritative claim-store check for Staffelmiete conflicts. The emitter's job is to flag extractions where the source document already indicated Staffelmiete context, so the applier sees the flag set even if its DB check happens to miss the conflict (defense in depth). The truth source is the applier; the emitter's flag is advisory.

**"Always emit the claim, conditionally emit the closure"** is the chosen pattern over "throw if prerequisites fail." Reason: a draft Mieterhöhung still contains real data (the proposed new rent), and losing that data because of missing signatures is worse than emitting a low-confidence claim that surfaces in triage. The triage UI can prompt the user to confirm the increase took effect; the closure can be applied retroactively by a human-adjudicated emission later.

**`new_kaltmiete` absent is a hard error.** Without the new rent, the document isn't a Mieterhöhung; it's a Mietvertragsnachtrag (covered by Task 2.1b) or a misclassification. The emitter throws rather than producing an empty result. The pipeline upstream catches the throw and marks the extraction as `requires_review`.

**`tenant_active` is NOT emitted.** The existing tenant claim from the original Mietvertrag remains valid through the amendment. Mieterhöhung amends rent, not tenancy. Emitting a new tenant_active claim would create a confusing duplicate.

**`close_at = effective_date - 1 day` is computed in UTC.** This matches the convention used elsewhere (claim valid_from is also UTC-derived). Edge case: if effective_date is the first of a month, close_at is the last day of the previous month, which is correct semantically (the old rent applies up to and including the day before the new one takes effect).

**Schema YAML's structured sub-objects (`paragraph_558_basis`, `paragraph_559_basis`, `indexmiete_basis`) are extractor-side**, NOT consumed by the emitter. They exist so downstream presenters can show the legal context (e.g., "§558 increase, Mietspiegel reference Köln 2024, consent deadline 2024-12-15"). The emitter ignores them. Including them in the schema today avoids a later migration.

**The `closes` field in front-matter is the contract with the applier, but the predicate-pair allowlist generator (the CI gate that would enforce this) is deferred to Phase 2's second wave.** Until that ships, the applier accepts any (event_predicate, target_predicate) pair. The front-matter is still authoritative — the generator will catch up. Write the front-matter correctly today; don't wait for the gate.

**No Indexmiete recomputation here.** The Indexmiete rechtsgrundlage is recorded for downstream presentation, but the emitter does not produce a "future recomputation" claim or schedule. That's a separate field-level resolver pattern (resolve "current Indexmiete value" by reading the index and applying the formula). Phase 2 second wave or Phase 3.

**Misclassified pet-clause Nachtrag adversarial fixture** is mentioned in the front-matter's `adversarial_fixtures_required`. The actual fixture file is NOT created in this task — that belongs to Task 2.1b (Mietvertragsnachtrag) and the cross-emitter classification test. Listing it in the required-fixtures field is the contract; the file lands later.

**No Edge Function changes.** The schema YAML, when regenerated, may produce a new prompt fragment for `mieterhoehung` doc_type. The Edge Function reads prompts via `STRUCTURED_PROMPTS` lookup — if the existing mechanism doesn't auto-pick up new doc_types, that's a separate small wiring task. Verify by checking `supabase/functions/process-document/extraction_schemas.ts` and the generator output. If wiring is needed, scope it into this task and document it; if it's automatic, no action.
