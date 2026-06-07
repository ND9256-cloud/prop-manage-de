# Task 4.3c-b-ii-B — emit table_cell evidence for unit_ref (schema-driven) + re-extract Lena

Context: task-4.3c-plan.md + the ii-A entry in ARCHITECTURE_STATE.md + the ChatGPT
1b-ii critique. Teach the extractor to EMIT table_cell evidence for unit_ref when
the floor comes from a table, schema-driven (edit unit_ref's prompt_fragment_template
prose — NOT the duplicated wrapper), then re-extract Lena and prove it through the
EVAL SCORER. The production envelope already CARRIES/shape-VALIDATES/RENDERS
table_cell (ii-A). This task is the EMISSION + eval proof.

SCOPE NOTE: emitters do not read evidence today (evidence_id → null, no
warehouse.evidence table). So UI provenance for table_cell is NOT in scope — making
Lena's floor provenance visible in the product requires an evidence-persistence
decision in warehouse.* (GoBD append-only) and is deferred to a separate ii-C with
its own design. ii-B proves emission via the eval scorer, not the UI.

## 1. Schema-driven emission guidance (edit prose, regenerate)
In schemas/mietvertrag/schema.yaml, extend unit_ref's prompt_fragment_template prose
(currently lines ~25-30) with table_cell guidance. Add, generically (NOT Lena-specific):
- "When the floor/unit comes from a TABLE CELL rather than a clean phrase, emit
  evidence_type: table_cell with { column_anchor (the header that means floor —
  Geschoss/Etage/Stockwerk/Ebene), cell_value_raw (the EXACT raw token in the cell,
  e.g. "1"), derivation_rule: geschoss_numeric_to_og, page }."
- "cell_value_raw MUST be the raw token. Do NOT put the normalized value (e.g.
  "1.OG") in cell_value_raw unless "1.OG" literally appears in the OCR."
- "Include row_anchor ONLY when the table has multiple unit/person rows that must be
  disambiguated. OMIT row_anchor for a single-unit description table. NEVER invent a
  row_anchor from a tenant name/address/prose outside the table row."
- "Do NOT use an ambiguous column (Nr., Zimmer, Anzahl, Pos.) to derive a floor."
- "If the correct row in a multi-row table cannot be identified, set
  absence_state: ambiguous — do not guess."
Keep direct_quote the default for non-table sources. Regenerate
(scripts/gen-schemas.ts → prompt_fragment.ts); both production index.ts and eval
extractor.ts inherit via the shared generated fragment, so the drift-guard stays
green (no wrapper edit). gen:schemas:check must pass.

## 2. Re-extract Lena + score
Re-extract Lena via the eval extract path (one Sonnet call), then score:
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/eval/run.ts extract --live --fixture-id everding --out eval/candidates/lena-iiB
DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/eval/run.ts score --candidate eval/candidates/lena-iiB --doc-type mietvertrag --fixture-id everding
EXPECTATION (honest): unit_ref SHOULD move 0 → 3 IF the model emits a grounded
table_cell that the validator accepts (column=Geschoss, cell_value_raw="1",
geschoss_numeric_to_og, single-row so no row_anchor). If it lands at 2 or
ambiguous because her OCR is genuinely weak, THAT IS ACCEPTABLE — tune to HONEST
EVIDENCE, not to grade 3. Do not force grade 3.

## 3. Held-out table shapes (prevent overfitting to Lena)
Add three synthetic eval fixtures (or extend table-cell-grounding coverage) and
verify emission/scoring behavior — these are about the GUIDANCE being general:
- multi-row rent-roll (Mieter|Geschoss|Miete, 2 tenants) → row_anchor PRESENT, grade 3.
- single-row description table (Lena shape) → row_anchor OMITTED, grade 3.
- ambiguous numeric column ("1" under Nr./Zimmer) → NOT grade 3.
(These can be scored as gold/candidate pairs; no live Sonnet needed for the
held-outs — hand-author the candidate table_cell evidence to confirm the validator
behaves. Live Sonnet is only for Lena.)

## 4. Stop condition (explicit)
Tune the prompt prose until the model reliably: emits the RAW token (not normalized),
omits row_anchor in single-row tables, includes it in multi-row, refuses ambiguous
columns. STOP when the evidence is HONEST — accept grade 2 / ambiguous for genuinely
weak OCR. Do NOT keep tuning until grade 3; that trains the model to overclaim.

## Out of scope
- NO emitter/claim/DB change; NO warehouse.evidence persistence; NO UI provenance for table_cell (→ ii-C, separate design).
- NO change to the generated envelope_validator (still array-only; standalone validateEvidence from ii-A unchanged).
- NO composite/address, NO money table_cell, NO bbox.
- Do NOT change direct_quote behavior, scalar/identity/derived grade logic, normalized_match, or applier logic.

## Definition of done
- unit_ref prompt_fragment_template carries table_cell emission guidance (generic, not Lena-specific); regenerated; drift-guard + gen:schemas:check green.
- Lena re-extracted: unit_ref evidence is a table_cell; scored honestly (0→3 if it grounds, ≤2/ambiguous if OCR is weak — report the real grade, do not force 3).
- Three held-out shapes verified (multi-row→row_anchor+3; single-row→no row_anchor+3; ambiguous column→not 3).
- All existing eval tests + everding-end-to-end (run WITH the now-self-loading env) unchanged-green; tsc clean.
- ARCHITECTURE_STATE.md updated (touches supabase/functions/process-document + schemas → trigger path).
- Single commit on feature/task-4.3c-b-ii-B-emit-table-cell; PR; CI green.
