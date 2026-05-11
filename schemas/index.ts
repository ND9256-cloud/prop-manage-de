// Registry of doc types with v2 schemas.
// This file is HAND-MAINTAINED. When adding a new doc-type schema:
// 1. Create schemas/<doc_type>/schema.yaml
// 2. Run npm run gen:schemas
// 3. Add the doc_type to V2_SCHEMA_DOC_TYPES below
//
// Hand-maintained (rather than auto-generated) so adding a doc type is a
// deliberate, reviewable act — not a side effect of a YAML file existing.

export const V2_SCHEMA_DOC_TYPES = new Set([
  "mietvertrag",
]);

export function hasV2Schema(docType: string): boolean {
  return V2_SCHEMA_DOC_TYPES.has(docType);
}
