// Integration test for POST /api/pipeline/apply-emission
//
// Runs against a live Next.js dev server (npm run dev) on localhost:3000.
// Uses the real DB. Skips gracefully unless RUN_INTEGRATION_TESTS=1.
//
// HARD PRECONDITION: TEST_DOCUMENT_ID must reference a warehouse.documents row
// whose property_id belongs to a dedicated test property (e.g. shortcode
// TEST_ISOLATED), NOT a real production property (KO132, HHS55). The test
// inserts synthetic claims under that property's id. Since warehouse.claims
// cannot be DELETEd (GoBD trigger), those claims persist and would surface in
// any future rent_for_unit query against that property.
//
// Setup steps for first-time test run:
//   1. Create a dedicated Property row in the test org with shortcode TEST_ISOLATED.
//   2. Create one warehouse.documents row attached to it.
//   3. Record the document UUID as TEST_DOCUMENT_ID in .env.local.
//   4. Never query that property via rent_for_unit in production reporting.
//
// Run:
//   RUN_INTEGRATION_TESTS=1 \
//     TEST_DOCUMENT_ID=<uuid> \
//     DOTENV_CONFIG_PATH=.env.local \
//     npx tsx -r dotenv/config src/tests/api/apply-emission.test.ts

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/db";

const SECRET = process.env.PIPELINE_INTERNAL_SECRET!;
const BASE = process.env.APP_URL_FOR_TEST ?? "http://localhost:3000";

if (process.env.RUN_INTEGRATION_TESTS !== "1") {
  console.log("apply-emission integration test skipped (set RUN_INTEGRATION_TESTS=1)");
  process.exit(0);
}

assert.ok(SECRET, "PIPELINE_INTERNAL_SECRET env required");

const extraction_run_id = randomUUID();
const source_document_id = process.env.TEST_DOCUMENT_ID;
assert.ok(source_document_id, "TEST_DOCUMENT_ID env required");

// Step 1: insert a synthetic mietvertrag envelope mirroring Lena's shape
// @tenant-isolation-disable-next-line -- reason: test inserts synthetic envelope for integration testing, tagged with model=test-synthetic
await prisma.$executeRaw`
  INSERT INTO warehouse.document_extractions_v2
    (source_document_id, doc_type, schema_version, prompt_version, model,
     extraction_run_id, fields, lifecycle, human_review_status)
  VALUES
    (${source_document_id}::uuid, 'mietvertrag', '2026-05-21-v1', '2026-05-21-v1',
     'test-synthetic', ${extraction_run_id}::uuid,
     ${JSON.stringify({
       kaltmiete: { absence_state: "present", confidence: "high", raw_value: "650",
                    normalized_value: { amount: 65000, currency: "EUR" },
                    evidence: [{ page: 1, quote: "synthetic" }] },
       unit_ref:  { absence_state: "present", confidence: "high", raw_value: "1",
                    normalized_value: "1.OG", evidence: [{ page: 1, quote: "synthetic" }] },
       tenant_identity: { absence_state: "present", confidence: "high",
                          raw_value: "Test, Tenant",
                          normalized_value: { name: "Test, Tenant", is_legal_entity: false, legal_form: null },
                          evidence: [{ page: 1, quote: "synthetic" }] },
       mietbeginn: { absence_state: "present", confidence: "high", raw_value: "01.01.2025",
                     normalized_value: "2025-01-01",
                     evidence: [{ page: 1, quote: "synthetic" }] },
       mietende: { absence_state: "not_applicable", confidence: "high",
                   raw_value: null, normalized_value: null, evidence: [] },
     })}::jsonb,
     ${JSON.stringify({ document_status: "active", effective_date: "2025-01-01" })}::jsonb,
     'not_reviewed')
`;

// Step 2: POST the route
const res = await fetch(`${BASE}/api/pipeline/apply-emission`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-secret": SECRET },
  body: JSON.stringify({ extraction_run_id }),
});
const body = await res.json();

assert.equal(res.status, 200, `route returned ${res.status}: ${JSON.stringify(body)}`);
assert.equal(body.status, "applied");
assert.equal(body.apply_result.inserted_claim_ids.length, 2);

// Step 3: verify claims landed
// @tenant-isolation-disable-next-line -- reason: test SELECT verifies synthetic claims were inserted correctly
const claims = await prisma.$queryRaw<any[]>`
  SELECT predicate, value FROM warehouse.claims
  WHERE source_extraction_run_id = ${extraction_run_id}::uuid
  ORDER BY predicate
`;
assert.equal(claims.length, 2);
assert.equal(claims[0].predicate, "kaltmiete");
assert.equal(claims[0].value.amount, 65000);
assert.equal(claims[1].predicate, "tenant_active");
assert.equal(claims[1].value.tenants[0].name, "Test, Tenant");

console.log("✓ apply-emission integration: synthetic envelope → 2 claims inserted");
await prisma.$disconnect();
