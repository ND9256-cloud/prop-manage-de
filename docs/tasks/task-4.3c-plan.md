# Task 4.3c — Derived & composite evidence grounding (Step-0 plan)

Context: task-4.3-plan.md WS2; 4.3a/names did scalar + identity grounding.
4.3c covers the fields scalar grounding can't honestly grade: derived (unit_ref)
and composite (full_address). Same philosophy: scorer-only FIRST, touch the
schema only where the scorer genuinely cannot reconstruct grounding.

## Core problem
A derived value isn't a literal OCR substring — unit_ref "1.OG" is synthesized
from "1. Obergeschoss". Two sub-cases:
- Single-source derived (unit_ref): the model already cites ONE source quote.
  The scorer can validate WITHOUT a schema change — does the quote ground in OCR
  (grade 3 by the existing rule) AND does a declared normalization rule map that
  quote to the value?
- Multi-component composite (full_address = street + house_no + PLZ + city,
  split across OCR lines): no single quote suffices; each component must ground
  separately. This NEEDS the extractor to emit source_components — schema change.

## Phasing (preserve scorer-first discipline)
### 4.3c-a — scorer-only derived grounding (no schema change)
- unit_ref: grade 3 if (1) the existing evidence.quote grounds at grade 3, AND
  (2) a declared deterministic rule (floor_synonym_normalization) maps quote->value.
  Else ungrounded.
- Rules live in the scorer (small declared map), tested deterministically. No
  extractor/schema change, no re-extraction. unit_ref: derived_pending -> graded.
- This is the 4.3a analogue: prove derived grounding scorer-side before touching
  the envelope contract.

### 4.3c-b — typed evidence + source_components (schema change)
- For composites (full_address): extend envelope evidence to carry
  { evidence_type, source_components[], derivation_rule }. Typed status enum
  (per ChatGPT critique): direct_quote_grounded | table_cell_grounded |
  derived_grounded | value_present_unclear | ungrounded.
- Touches: production extractor (supabase/functions/process-document/index.ts),
  eval extractor.ts, envelope validator, generated field specs, + RE-EXTRACTION.
  High blast radius; trips ARCHITECTURE_STATE (+ migration gate if schema). Do it
  deliberately, with a ChatGPT adversarial pass on the schema shape first
  (legal-shield + migration cost).
- The scorer VALIDATES the model's declared source_components (each grounds at
  grade 3) + that the rule yields the value — it does NOT trust the declaration.
  This is exactly why scalar/scorer-first mattered: the scorer is the independent
  check on the extractor's self-reports.

## Open decisions (settle before 4.3c-b)
- Field inventory: single-source-derived (-> c-a) vs multi-component-composite
  (-> c-b)? unit_ref = c-a; full_address = c-b; audit schemas for others.
- derivation_rule vocabulary: closed enum (floor_synonym_normalization,
  address_component_composition, ...), declared in schema.
- Ambiguous derivation (e.g. "erste Etage" -> 1.OG, lower confidence): grade 3 or cap at 2?

## Sequence
4.3c-a (scorer-only, unit_ref) -> ChatGPT critique on the typed-evidence schema ->
4.3c-b (schema source_components + composites, with re-extraction). WS3 derived/
composite fixtures (plan Fixtures 6/7/10) land alongside 4.3c-b.
