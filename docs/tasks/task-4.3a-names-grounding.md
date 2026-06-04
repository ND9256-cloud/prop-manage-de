# Task 4.3a-names — person/company grounding for tenant & landlord identity

Context: docs/tasks/task-4.3a-grounding-scorer.md and task-4.3-plan.md (WS2).
4.3a graded scalar fields and bucketed tenant_identity / landlord_identity as
`non_scalar` → ungraded. These are the two most audit-critical fields in any
tenancy document and must carry a grounding grade. Add person/company grounding
to the SAME 0–3 grade, scorer-only. NO schema/extractor change, no re-extraction,
no Sonnet.

## Value match for identity fields
- Person: surname core token required + ≥1 disambiguating token (given name or initial). Normalize umlauts (ä/ae etc.), case, "Surname, Given" vs "Given Surname" order.
- Company: legal-entity core token (the distinctive name) + accept/normalize legal-form suffix (GbR, GmbH, UG, KG). e.g. "Denn & Denn Verwaltungs GbR".

## Anchor = ROLE label, not a generic synonym (same-page window rules as 4.3a)
- tenant_identity grounds on: Mieter, Mieterin, Mietpartei, Vertragspartner (tenant side). Must NOT ground on: Vermieter, Empfänger, Eigentümer, witness.
- landlord_identity grounds on: Vermieter, Vermieterin, Eigentümer, vertreten durch (landlord side). Must NOT ground on tenant-side roles.
- Bare signature-block name (value present, no role label in window) = grade 2 (weak), never grade 3. A signature alone is not sufficient grounding.
- Source the role-anchor sets from schemas/<doc_type>/generated/field_specs.ts where available; if identity role anchors are not yet in the specs, add a small explicit per-field role map in metrics.ts (documented) — but keep value/number label sourcing as in 4.3a.

## Grade (reuse the 4.3a 0–3 scale)
- 3: normalized identity value + correct role anchor in same-page window.
- 2: identity value in window but no role anchor (or bare signature-block name).
- 1: identity value somewhere in OCR, not tied to the field/window.
- 0: value not in OCR / contradicted.

## Steps
1. In scripts/eval/metrics.ts, route tenant_identity & landlord_identity through identity grounding (remove their `non_scalar` exclusion). Keep unit_ref and true composite fields as derived_pending (4.3c).
2. Add identity assertions to src/tests/eval/grounding-grade.test.ts (or a sibling): tenant grounds via "Mieter" → grade 3; tenant value under "Vermieter" → NOT grade 3 (role-mismatch trap); company name + GbR suffix grounds; bare signature-block name → grade 2. Keep all existing 45 assertions green.
3. Re-score eval/candidates/lena2; tenant_identity and landlord_identity should now show grade 3 (Mieter / Vermieter anchors), unit_ref still derived_pending.
4. Update ARCHITECTURE_STATE.md eval section (identity fields now graded; role anchors; signature = weak). REQUIRED — arch path, gate fires otherwise.

## Out of scope
- No schema/extractor change, no re-extraction, no Sonnet.
- unit_ref and composite/address fields stay derived_pending (4.3c).
- Do not change normalized_match or the scalar grading from 4.3a.

## Definition of done
- tenant_identity & landlord_identity carry a 0–3 grade; role-mismatch and signature-only traps asserted in tests.
- Lena re-score: both identities grade 3, unit_ref derived_pending.
- All eval tests green in CI (existing 45 grounding assertions unchanged + new identity ones); tsc + lint clean; ARCHITECTURE_STATE.md updated.
- Single commit on feature/task-4.3a-names-grounding; PR; CI green.
