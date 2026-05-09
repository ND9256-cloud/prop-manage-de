# domain_knowledge/

Domain knowledge files for the extraction v2 pipeline. Each `.md` file describes one German Hausverwaltung document type.

## Consumer contract

- **Front-matter** is consumed by emitters, verifiers, and the transaction applier. It is typed at runtime via the Zod schema in `src/tests/domain-knowledge.test.ts`.
- **Prose body** (below the front-matter) is human-readable reference material. It is not parsed by any system.

## Cross-validation rules

- Every field listed in `fields_governed` must appear as a `field.id` in the corresponding `schemas/<doc_type>/schema.yaml`. This is cross-validated by CI starting in Task 0.2.
- Every `gotcha.id` must be referenced from at least one adversarial fixture or verifier. This is CI-checked starting in Phase 1; soft until those exist.

## Transaction applier integration

The `closes` array is read by the transaction applier (see ARCHITECTURE.md §5.5). The `close_mode` field drives applier behavior:

| close_mode | Behavior |
|---|---|
| `close_overlapping_only` | Close claims with overlapping validity periods |
| `close_overlapping_and_future` | Close overlapping claims and all future-dated claims |
| `close_overlapping_and_supersede_future` | Close overlapping, supersede future claims with new values |

## File format

Each file uses YAML front-matter followed by a Markdown body:

```markdown
---
doc_type: mietvertrag
default_claim_kind: assertion
last_updated: 2026-05-08
legal_grounding: []
fields_governed: []
normalization_rules: []
gotchas: []
adversarial_fixtures_required: []
closes: []
---

Human-readable notes about the document type.
```

See `_schema.yaml` for the complete field specification.
