# Task 4.3c-b-ii-A — promote table_cell into the production envelope contract + provenance rendering (no emission, no Sonnet)

Context: task-4.3c-plan.md + task-4.3c-b-1a-table-cell.md + the ChatGPT 1b-ii critique.
Make the PRODUCTION envelope able to CARRY, shape-VALIDATE, and RENDER table_cell
evidence — WITHOUT teaching the extractor to emit it yet. Closes the provenance
display break BEFORE any table_cell reaches a UI. NO emission guidance, NO
re-extraction, NO Sonnet. Teaching the extractor to emit + re-extracting Lena is
the SEPARATE next task (4.3c-b-ii-B).

SAFETY INVARIANT: this task is ADDITIVE and BACKWARD-COMPATIBLE. Existing
direct_quote behavior must be BYTE-UNCHANGED — same extraction output, same
emitter/applier/claims flow, same provenance rendering for direct_quote. Nothing
emits table_cell yet; this only adds the capability to carry/validate/render it.

## 1. Evidence type → backward-compatible union (align with scripts/eval/types.ts)
Widen the production evidence type to a discriminated union on OPTIONAL
evidence_type (absent ⇒ direct_quote):
- direct_quote: { evidence_type?:"direct_quote", quote, page?, bbox? }  (UNCHANGED)
- table_cell:   { evidence_type:"table_cell", page, table_cell:{ row_anchor?:{quote,anchor_type,canonical?}, column_anchor:{quote,canonical?}, cell_value_raw, derivation_rule } }
Apply the widening everywhere evidence is typed so it compiles:
- src/lib/emitters/{mietvertrag,mietvertragsnachtrag,mieterhoehung,wohnungsuebergabeprotokoll}.ts (currently {page?,quote?}[] → union)
- supabase/functions/process-document/verifiers/types.ts (currently {quote:string;...} → widen so verifiers compile; verifiers run on money fields only, behavior unchanged)
Match the eval union shape exactly.

## 2. Emitters/applier carry the whole evidence object
Emitters must pass the FULL evidence object (incl. table_cell) into claims — not
just a quote string. Confirm claims store the whole evidence object. NO change to
applier dedup/supersession logic.

## 3. Validator: shape + per-field allowed evidence types (NOT grounding)
- Accept table_cell when shape-valid: page + column_anchor.quote + cell_value_raw + derivation_rule present; row_anchor optional. Reject malformed.
- Enforce per-field allowed evidence types: unit_ref allows {direct_quote, derived, table_cell}; other fields keep direct_quote (+ existing). Disallowed type for a field → reject.
- Validator checks SHAPE, never grounding. If it currently rejects "value present but no evidence quote", change to "no VALID evidence object" — quote mandatory for direct_quote; cell_value_raw+column_anchor+page minimal for table_cell.

## 4. renderEvidence() — German provenance display, wired into the modal
Add renderEvidence(evidence) → human string, GERMAN (UI is German-only):
- direct_quote → the quote (unchanged).
- table_cell + row_anchor → "Tabellenzelle — Zeile [<row>], Spalte [<col>], Rohwert [<raw>], Seite <page>".
- table_cell, no row_anchor → "Tabellenzelle — Spalte [<col>], Rohwert [<raw>], Seite <page>".
Wire into the provenance click-through path in src/lib/dashboard-actions.ts
(ProvenanceClaim) so a table_cell claim renders readable source, not a blank quote.

## 5. Prompt evidence-shape description (the one localized wrapper edit)
Update index.ts (~line 939, "evidence (Array von {quote, page, bbox})") to describe
BOTH variants: direct_quote {quote,page,bbox} and table_cell {evidence_type,page,
table_cell:{...}}. Mirror the SAME edit in scripts/eval/extractor.ts so the
drift-guard stays green; adjust extractor-drift.test.ts. SHAPE DESCRIPTION ONLY —
do NOT add guidance on WHEN to use table_cell (that is 4.3c-b-ii-B, schema-driven).

## Steps
1. Evidence union in production types + the four emitters + verifiers/types.ts (compile-safe, direct_quote unchanged).
2. Confirm emitters/claims carry the full evidence object.
3. Validator: shape-valid table_cell, per-field allowed types, "valid evidence object" not "quote present".
4. renderEvidence() (German) + wire into dashboard-actions.ts provenance.
5. Prompt shape-description edit in index.ts + extractor.ts mirror; keep extractor-drift green.
6. Tests: renderEvidence unit test (direct_quote→quote; table_cell ±row_anchor → German strings); validator test (valid table_cell accepts; missing required field rejects; disallowed type rejects; unit_ref allows table_cell). Wire into CI if a new file.
7. ARCHITECTURE_STATE.md update — REQUIRED (touches src/lib/*-actions.ts, emitters, supabase/functions/process-document → trigger paths).

## Out of scope
- NO extractor EMISSION guidance (when to use table_cell) — that is 4.3c-b-ii-B.
- NO re-extraction, NO Sonnet, NO prompt-tuning loop.
- NO composite/address, NO money table_cell.
- Do NOT change direct_quote behavior, applier dedup/supersession, or the eval scorer/grade logic.

## Definition of done
- Evidence union backward-compatible; tsc clean across emitters, verifiers, dashboard-actions, Deno function.
- Validator accepts shape-valid table_cell + per-field allowed types; rejects malformed/disallowed.
- renderEvidence renders German for direct_quote and table_cell (±row_anchor); wired into provenance modal.
- Prompt shape-description updated in index.ts + extractor.ts; extractor-drift.test.ts green.
- New renderEvidence + validator tests green; ALL existing eval tests unchanged-green; the everding-end-to-end integration test green locally (proves the union widening didn't break emitter→applier→claims→resolver).
- ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3c-b-ii-A-table-cell-contract; PR; CI green.
