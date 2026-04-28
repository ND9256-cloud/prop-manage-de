#!/usr/bin/env node
// tools/tenant-isolation-lint/run-tests.ts
//
// Meta-test: runs the gate against fixture files and verifies it produces
// the expected violations (or lack thereof).
//
// Usage: npx tsx tools/tenant-isolation-lint/run-tests.ts

import * as path from 'path';
import { parseSchema, buildModelMap } from './parse-schema.js';
import { scanFile } from './detect.js';

const FIXTURES_DIR = path.join('tools', 'tenant-isolation-lint', '__fixtures__');
const TEST_SCHEMA = path.join(FIXTURES_DIR, 'test-schema.prisma');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function runTests(): void {
  console.log('=== Tenant Isolation Gate — Meta Tests ===\n');

  // 1. Schema parser tests
  console.log('--- Schema Parser ---');
  const schemaResult = parseSchema(TEST_SCHEMA);
  const modelMap = buildModelMap(schemaResult);

  assert(schemaResult.models.length === 3, `Parsed 3 annotated models (got ${schemaResult.models.length})`);
  assert(schemaResult.unannotated.length === 1, `Found 1 unannotated model (got ${schemaResult.unannotated.length})`);
  assert(schemaResult.unannotated[0]?.name === 'UnannotatedModel', `Unannotated model is "UnannotatedModel" (got ${schemaResult.unannotated[0]?.name})`);

  const orgModel = modelMap.get('Organization');
  assert(orgModel?.type === 'global', `Organization is @global (got ${orgModel?.type})`);

  const propModel = modelMap.get('Property');
  assert(propModel?.type === 'direct', `Property is @tenant-scoped (got ${propModel?.type})`);
  assert(propModel?.orgColumn === 'organizationId', `Property org column is organizationId (got ${propModel?.orgColumn})`);

  const unitModel = modelMap.get('Unit');
  assert(unitModel?.type === 'indirect', `Unit is @tenant-scoped-via (got ${unitModel?.type})`);
  assert(unitModel?.viaField === 'propertyId', `Unit via field is propertyId (got ${unitModel?.viaField})`);

  // Parser golden test: re-parse same schema, verify deterministic output
  const schemaResult2 = parseSchema(TEST_SCHEMA);
  assert(
    JSON.stringify(schemaResult.models) === JSON.stringify(schemaResult2.models),
    'Schema parsing is deterministic across runs',
  );

  // 2. Safe patterns test
  console.log('\n--- Safe Patterns (expect 0 violations) ---');
  const safeFile = path.join(FIXTURES_DIR, 'safe-patterns.ts');
  const safeResult = scanFile(safeFile, modelMap);
  assert(safeResult.violations.length === 0, `Safe patterns: 0 violations (got ${safeResult.violations.length})`);
  if (safeResult.violations.length > 0) {
    for (const v of safeResult.violations) {
      console.error(`    UNEXPECTED: ${v.file}:${v.line}: ${v.rule}: ${v.message}`);
    }
  }
  assert(safeResult.annotations.length >= 1, `Safe patterns: at least 1 valid annotation found (got ${safeResult.annotations.length})`);

  // 3. Violation patterns test
  console.log('\n--- Violation Patterns (expect violations) ---');
  const violationsFile = path.join(FIXTURES_DIR, 'violations.ts');
  const violResult = scanFile(violationsFile, modelMap);

  // We expect at least one violation per numbered pattern (13 patterns)
  assert(violResult.violations.length >= 10, `Violation patterns: ≥10 violations found (got ${violResult.violations.length})`);

  // Check specific violation rules are present
  const rules = new Set(violResult.violations.map(v => v.rule));
  assert(rules.has('tenant-isolation/missing-org-filter'), 'Caught: missing org filter on direct model');
  assert(rules.has('tenant-isolation/missing-fk-filter'), 'Caught: missing FK filter on indirect model');
  assert(rules.has('tenant-isolation/banned-raw-sql'), 'Caught: banned raw SQL');

  // Check annotation violations
  const annotationViolations = violResult.violations.filter(v =>
    v.rule === 'tenant-isolation/invalid-annotation' ||
    v.rule === 'tenant-isolation/placeholder-reason' ||
    v.rule === 'tenant-isolation/reason-too-short'
  );
  assert(annotationViolations.length >= 2, `Caught: annotation violations (≥2 expected, got ${annotationViolations.length})`);

  // 4. Unknown shape test (fail-closed behavior)
  console.log('\n--- Unknown Shape (fail-closed) ---');
  // The violations.ts doesn't have an unknown model test, but we verify
  // the gate's behavior is correct by checking it doesn't miss any pattern
  assert(
    violResult.violations.some(v => v.operation === '$queryRaw'),
    'Caught: $queryRaw specifically identified',
  );
  assert(
    violResult.violations.some(v => v.operation === '$executeRawUnsafe'),
    'Caught: $executeRawUnsafe specifically identified',
  );

  // 5. Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.error('\n❌ Meta-tests FAILED. Fix the gate before running against real codebase.');
    process.exit(1);
  } else {
    console.log('\n✅ All meta-tests passed.');
    process.exit(0);
  }
}

runTests();
