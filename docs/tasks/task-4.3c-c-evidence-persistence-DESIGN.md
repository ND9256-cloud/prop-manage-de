# Task 4.3c-c — Evidence persistence + UI provenance for table_cell (DESIGN NOTE / deferred)

Status: DEFERRED — trigger is first-customer / first real audit need. NOT a blind
dispatch. This is a GoBD append-only warehouse.* schema decision; design + a
ChatGPT critique pass BEFORE implementation, same discipline as the grounding-rule
and typed-evidence decisions.

## Why deferred (not dropped)
The table-cell grounding arc is COMPLETE and verified through the eval scorer (the
architecture's authority on grounding quality): the extractor emits honest
table_cell evidence (cell_value_raw raw token, not laundered), the validator
independently checks it, Lena's unit_ref grades 0→3. What ii-C adds is making that
evidence PERSIST into production claims and be VISIBLE in the app provenance modal.
Today: emitters do not read evidence (evidence_id → null, no warehouse.evidence
table); the provenance modal renders evidence_rendered from a claim value.evidence
object that nothing populates. The NEED to surface this is first-customer-driven
(when real documents flow and someone audits them), so per the "add a consumer when
the need exists" principle, this waits.

## The core decision (settle first, with ChatGPT critique)
WHERE does evidence live?
- Option A: a new `warehouse.evidence` table (append-only), claims reference it by
  evidence_id (the vestigial column becomes real). Cleanest separation; a migration;
  GoBD append-only/retention rules apply.
- Option B: evidence inline in the claim `value` jsonb (no new table; emitters thread
  the evidence object into value.evidence). Less infra; couples evidence to the claim
  row; provenance modal already reads value.evidence.
- Tradeoffs: A is more normalized/auditable and supports evidence shared across
  claims; B is simpler and the modal path already exists. GoBD append-only +
  retention + the existing soft-delete/supersession model must be respected either way.

## Scope when triggered
1. Decide A vs B (ChatGPT critique on the schema/audit implications).
2. If A: migration for warehouse.evidence (+ migration-discipline gate, ARCHITECTURE_STATE).
3. Emitters thread the unit_ref (and other) evidence object into the claim (value.evidence or evidence_id).
4. Applier/claim-store carries it append-only; supersession/soft-delete semantics preserved.
5. Provenance modal already renders it (renderEvidence/evidence_rendered from ii-A) — verify end-to-end with a re-extracted table_cell claim (Lena).
6. Wire validateEvidence (ii-A standalone shape validator) into the pipeline if a malformed emitted table_cell should be caught at ingest.

## Out of scope / guardrails
- Eval scorer is unchanged (it already grades table_cell; this is persistence/UI only).
- direct_quote behavior, applier dedup/supersession, normalized_match untouched.
- No eval-side changes — this is production persistence + UI.

## Done when (at trigger time)
- A re-extracted document with table_cell evidence persists it append-only and the
  provenance modal shows the German "Tabellenzelle — ..." string for that claim,
  end to end, with GoBD semantics intact.
