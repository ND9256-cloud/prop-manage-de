#!/usr/bin/env node
// tools/tenant-isolation-lint/index.ts
//
// Entry point for the tenant-isolation CI gate.
//
// Usage:
//   npx tsx tools/tenant-isolation-lint/index.ts          # lint mode (CI)
//   npx tsx tools/tenant-isolation-lint/index.ts --write   # regenerate exceptions report
//   npx tsx tools/tenant-isolation-lint/index.ts --test    # run meta-tests only

import * as fs from 'fs';
import * as path from 'path';
import { parseSchema, buildModelMap } from './parse-schema.js';
import { scanFile, type Violation, type DisableAnnotation } from './detect.js';
import { diffReport, writeReport } from './report.js';
import { SCHEMA_PATH, IN_SCOPE_PATHS, DIRECTORY_ALLOWLIST } from './config.js';

const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const testMode = args.includes('--test');

function main(): void {
  if (testMode) {
    console.log('Meta-test mode: running fixture tests...');
    // Meta-tests are run separately via run-tests.ts
    console.log('Use: npx tsx tools/tenant-isolation-lint/run-tests.ts');
    process.exit(0);
  }

  // 1. Parse schema
  console.log(`Parsing schema: ${SCHEMA_PATH}`);
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`ERROR: Schema file not found: ${SCHEMA_PATH}`);
    process.exit(1);
  }

  const schemaResult = parseSchema(SCHEMA_PATH);

  // Check for unannotated models (meta-rule: every model must declare tenancy)
  if (schemaResult.unannotated.length > 0) {
    console.error('\n❌ UNANNOTATED MODELS (every model must declare @tenant-scoped, @tenant-scoped-via, or @global):');
    for (const m of schemaResult.unannotated) {
      console.error(`  ${SCHEMA_PATH}:${m.line}: model "${m.name}" has no tenant-scoping annotation`);
    }
    console.error('');
  }

  if (schemaResult.errors.length > 0) {
    console.error('\n❌ SCHEMA PARSE ERRORS:');
    for (const e of schemaResult.errors) {
      console.error(`  ${e}`);
    }
    console.error('');
  }

  const modelMap = buildModelMap(schemaResult);
  const tenantModels = schemaResult.models.filter(m => m.type !== 'global');
  console.log(`Found ${schemaResult.models.length} models (${tenantModels.length} tenant-scoped, ${schemaResult.models.length - tenantModels.length} global)`);

  // 2. Find all TypeScript files in scope
  const files = findInScopeFiles();
  console.log(`Scanning ${files.length} files...\n`);

  // 3. Scan each file
  const allViolations: Violation[] = [];
  const allAnnotations: DisableAnnotation[] = [];

  for (const file of files) {
    const { violations, annotations } = scanFile(file, modelMap);
    allViolations.push(...violations);
    allAnnotations.push(...annotations);
  }

  // 4. Add unannotated model violations
  for (const m of schemaResult.unannotated) {
    allViolations.push({
      file: SCHEMA_PATH,
      line: m.line,
      column: 1,
      model: m.name,
      operation: '',
      message: `Model "${m.name}" has no tenant-scoping annotation. Add one of: /// @tenant-scoped, /// @tenant-scoped-via: <fkField>, or /// @global`,
      rule: 'tenant-isolation/unannotated-model',
    });
  }

  // 5. Handle report
  if (writeMode) {
    writeReport(allAnnotations);
    console.log(`✅ Report written to tenant-isolation-exceptions.md (${allAnnotations.length} exceptions)`);
  } else {
    const { hasDiff, diff } = diffReport(allAnnotations);
    if (hasDiff) {
      allViolations.push({
        file: 'tenant-isolation-exceptions.md',
        line: 0,
        column: 0,
        model: '',
        operation: '',
        message: diff,
        rule: 'tenant-isolation/report-drift',
      });
    }
  }

  // 6. Output results
  if (allViolations.length === 0) {
    console.log('✅ No tenant-isolation violations found.');
    console.log(`   ${allAnnotations.length} exceptions annotated and reviewed.`);
    console.log(`   ${tenantModels.length} tenant-scoped models checked.`);
    process.exit(0);
  }

  // Print violations in ESLint-compatible format
  console.error(`\n❌ ${allViolations.length} tenant-isolation violation(s) found:\n`);
  for (const v of allViolations) {
    const location = v.line > 0 ? `${v.file}:${v.line}:${v.column}` : v.file;
    console.error(`${location}: ${v.rule}: ${v.message}`);
  }

  console.error(`\n${allViolations.length} error(s) found.`);
  process.exit(1);
}

/**
 * Find all TypeScript files in the in-scope paths,
 * excluding allowlisted directories/files.
 */
function findInScopeFiles(): string[] {
  const files: string[] = [];

  for (const scopePath of IN_SCOPE_PATHS) {
    if (scopePath.endsWith('.ts') || scopePath.endsWith('.tsx')) {
      // Specific file
      if (fs.existsSync(scopePath) && !isAllowlisted(scopePath)) {
        files.push(scopePath);
      }
      continue;
    }

    // Directory — walk recursively
    if (fs.existsSync(scopePath)) {
      walkDir(scopePath, files);
    }
  }

  return files;
}

function walkDir(dir: string, files: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, .next, generated
      if (['node_modules', '.next', 'dist', '.turbo'].includes(entry.name)) continue;
      walkDir(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      if (!isAllowlisted(fullPath)) {
        files.push(fullPath);
      }
    }
  }
}

function isAllowlisted(filePath: string): boolean {
  for (const allowed of Object.keys(DIRECTORY_ALLOWLIST)) {
    if (allowed.endsWith('/')) {
      // Directory allowlist
      if (filePath.startsWith(allowed)) return true;
    } else {
      // File allowlist
      if (filePath === allowed || filePath.endsWith(allowed)) return true;
    }
  }
  return false;
}

main();
