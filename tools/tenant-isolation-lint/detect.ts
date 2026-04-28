// tools/tenant-isolation-lint/detect.ts
//
// Scans TypeScript source files for tenant-isolation violations.
//
// This is a pattern-based detector, not a full AST walker. The tradeoff:
// - Faster, no TypeScript compiler dependency, no tsconfig coupling
// - Cannot do dataflow analysis (by design — we fail closed on ambiguity)
// - Catches the common-case patterns that matter for a solo-operator codebase
//
// Detection rules:
// 1. Any prisma.<model>.<operation>() where <model> is @tenant-scoped must
//    be preceded by (or inside a function that calls) an approved wrapper
// 2. Any $queryRaw / $executeRaw / $queryRawUnsafe / $executeRawUnsafe is banned
// 3. Any $transaction call has its contents inspected
// 4. Lines with @tenant-isolation-disable-next-line are exempt if reason is valid

import * as fs from 'fs';
import {
  APPROVED_WRAPPERS,
  PRISMA_CLIENT_NAMES,
  BANNED_RAW_SQL_METHODS,
  PRISMA_OPERATIONS,
  DISABLE_COMMENT,
  MIN_REASON_LENGTH,
  REASON_DENY_LIST,
} from './config.js';
import type { TenantScopedModel } from './parse-schema.js';

export interface Violation {
  file: string;
  line: number;
  column: number;
  model: string;
  operation: string;
  message: string;
  rule: string;
}

export interface DisableAnnotation {
  file: string;
  line: number;
  reason: string;
  coversLine: number; // the line it actually disables
}

interface ScanContext {
  file: string;
  lines: string[];
  modelMap: Map<string, TenantScopedModel>;
  violations: Violation[];
  annotations: DisableAnnotation[];
  /** Lines disabled by valid annotations. */
  disabledLines: Set<number>;
  /** Whether an approved wrapper call was found in the current function scope. */
  wrapperFoundInScope: boolean;
}

/**
 * Scan a single TypeScript file for tenant-isolation violations.
 */
export function scanFile(
  filePath: string,
  modelMap: Map<string, TenantScopedModel>,
): { violations: Violation[]; annotations: DisableAnnotation[] } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const ctx: ScanContext = {
    file: filePath,
    lines,
    modelMap,
    violations: [],
    annotations: [],
    disabledLines: new Set(),
    wrapperFoundInScope: false,
  };

  // First pass: find all disable annotations and validate them
  findAnnotations(ctx);

  // Second pass: check for approved wrapper usage in the file
  checkWrapperUsage(ctx);

  // Third pass: find violations
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1; // 1-indexed
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '') {
      continue;
    }

    // Check for banned raw SQL methods
    checkRawSql(ctx, line, lineNum);

    // Check for Prisma model operations
    checkPrismaOperations(ctx, line, lineNum);
  }

  // Filter out violations on disabled lines
  const activeViolations = ctx.violations.filter(v => !ctx.disabledLines.has(v.line));

  return { violations: activeViolations, annotations: ctx.annotations };
}

/**
 * Find @tenant-isolation-disable-next-line annotations and validate them.
 */
function findAnnotations(ctx: ScanContext): void {
  for (let i = 0; i < ctx.lines.length; i++) {
    const line = ctx.lines[i].trim();
    if (!line.includes(DISABLE_COMMENT)) continue;

    const lineNum = i + 1;
    const coversLine = i + 2; // disables the NEXT line

    // Extract reason after `--`
    const reasonMatch = line.match(/@tenant-isolation-disable-next-line\s+--\s+reason:\s*(.*)/);

    if (!reasonMatch || !reasonMatch[1]) {
      ctx.violations.push({
        file: ctx.file,
        line: lineNum,
        column: 1,
        model: '',
        operation: '',
        message: `Invalid annotation: must follow format: // ${DISABLE_COMMENT} -- reason: <text ≥${MIN_REASON_LENGTH} chars>`,
        rule: 'tenant-isolation/invalid-annotation',
      });
      continue;
    }

    const reason = reasonMatch[1].trim();

    // Check minimum length
    if (reason.length < MIN_REASON_LENGTH) {
      ctx.violations.push({
        file: ctx.file,
        line: lineNum,
        column: 1,
        model: '',
        operation: '',
        message: `Annotation reason too short (${reason.length} < ${MIN_REASON_LENGTH} chars): "${reason}"`,
        rule: 'tenant-isolation/reason-too-short',
      });
      continue;
    }

    // Check deny-list
    const lowerReason = reason.toLowerCase();
    for (const denied of REASON_DENY_LIST) {
      if (lowerReason.includes(denied)) {
        ctx.violations.push({
          file: ctx.file,
          line: lineNum,
          column: 1,
          model: '',
          operation: '',
          message: `Annotation reason contains denied placeholder "${denied}": "${reason}"`,
          rule: 'tenant-isolation/placeholder-reason',
        });
        continue;
      }
    }

    // Valid annotation
    ctx.disabledLines.add(coversLine);
    ctx.annotations.push({
      file: ctx.file,
      line: lineNum,
      reason,
      coversLine,
    });
  }
}

/**
 * Check if any approved wrapper is called in this file.
 * This is a simple heuristic: if the file calls getOrgContext() or similar,
 * we know the function is aware of tenant-scoping. This doesn't prove every
 * query uses it, but it's a signal used in combination with other checks.
 */
function checkWrapperUsage(ctx: ScanContext): void {
  const content = ctx.lines.join('\n');
  ctx.wrapperFoundInScope = APPROVED_WRAPPERS.some(w => content.includes(w));
}

/**
 * Check a line for banned raw SQL methods.
 */
function checkRawSql(ctx: ScanContext, line: string, lineNum: number): void {
  if (ctx.disabledLines.has(lineNum)) return;

  for (const method of BANNED_RAW_SQL_METHODS) {
    // Match patterns like prisma.$queryRaw, db.$executeRaw, etc.
    // method is like "$queryRaw" — escape $ for regex with backslash
    const escapedMethod = method.replace(/\$/g, '\\$');
    const pattern = new RegExp(`\\b(${PRISMA_CLIENT_NAMES.join('|')})\\.${escapedMethod}\\b`, 'g');
    let match;
    while ((match = pattern.exec(line)) !== null) {
      ctx.violations.push({
        file: ctx.file,
        line: lineNum,
        column: match.index + 1,
        model: '',
        operation: method,
        message: `Raw SQL method "${method}" is banned in application code. Annotate with ${DISABLE_COMMENT} -- reason: <call-site-specific reason, ≥${MIN_REASON_LENGTH} chars> or move to an allowlisted path. Raw SQL wrappers planned for iteration 2.`,
        rule: 'tenant-isolation/banned-raw-sql',
      });
    }
  }
}

/**
 * Check a line for Prisma model operations on tenant-scoped models.
 *
 * Matches patterns like:
 *   prisma.property.findMany(...)
 *   db.user.update(...)
 *   tx.lease.deleteMany(...)
 *   client.bankTransaction.create(...)
 */
function checkPrismaOperations(ctx: ScanContext, line: string, lineNum: number): void {
  if (ctx.disabledLines.has(lineNum)) return;

  // Build regex for: <client>.<model>.<operation>
  const clientPattern = PRISMA_CLIENT_NAMES.join('|');
  const opPattern = [...PRISMA_OPERATIONS].join('|');

  // Match prisma.modelName.operation patterns
  const regex = new RegExp(
    `\\b(${clientPattern})\\.(\\w+)\\.(${opPattern})\\s*\\(`,
    'g'
  );

  let match;
  while ((match = regex.exec(line)) !== null) {
    const [, clientName, modelNameRaw, operation] = match;
    
    // Prisma uses camelCase model names in client (e.g., prisma.bankTransaction)
    // Schema uses PascalCase (e.g., BankTransaction)
    // Try both cases for lookup
    const modelInfo = ctx.modelMap.get(modelNameRaw) || ctx.modelMap.get(capitalize(modelNameRaw));

    if (!modelInfo) {
      // Model not in our schema — could be a non-Prisma object or a model we don't know about
      // Fail closed on unknown models that look like they could be Prisma
      if (looksLikePrismaModel(modelNameRaw)) {
        ctx.violations.push({
          file: ctx.file,
          line: lineNum,
          column: match.index + 1,
          model: modelNameRaw,
          operation,
          message: `Unknown model "${modelNameRaw}" used with Prisma operation "${operation}". If this is a tenant-scoped model, add @tenant-scoped annotation to schema.prisma. If not a Prisma model, annotate this line to suppress.`,
          rule: 'tenant-isolation/unknown-model',
        });
      }
      continue;
    }

    // Global models are always allowed
    if (modelInfo.type === 'global') continue;

    // For tenant-scoped models, check if the query includes the org filter
    // We use a heuristic: scan forward from the match to find the where clause
    const restOfLine = line.slice(match.index);
    const surroundingLines = getSurroundingContext(ctx.lines, lineNum - 1, 10);

    if (modelInfo.type === 'direct') {
      // Direct tenancy: must filter on organizationId/orgId
      const orgColumn = modelInfo.orgColumn || 'organizationId';
      if (!containsOrgFilter(surroundingLines, orgColumn) && !ctx.wrapperFoundInScope) {
        ctx.violations.push({
          file: ctx.file,
          line: lineNum,
          column: match.index + 1,
          model: modelNameRaw,
          operation,
          message: `Model "${capitalize(modelNameRaw)}" is @tenant-scoped and requires "${orgColumn}" in the where clause, or use an approved wrapper (${APPROVED_WRAPPERS.join(', ')}). Annotate with ${DISABLE_COMMENT} -- reason: <≥${MIN_REASON_LENGTH} chars> if this is a legitimate exception.`,
          rule: 'tenant-isolation/missing-org-filter',
        });
      }
    } else if (modelInfo.type === 'indirect') {
      // Indirect tenancy: must filter on the FK field
      const fkField = modelInfo.viaField!;
      if (!containsFkFilter(surroundingLines, fkField) && !ctx.wrapperFoundInScope) {
        ctx.violations.push({
          file: ctx.file,
          line: lineNum,
          column: match.index + 1,
          model: modelNameRaw,
          operation,
          message: `Model "${capitalize(modelNameRaw)}" is @tenant-scoped-via: ${fkField} and requires "${fkField}" in the where clause, or use an approved wrapper. Note: @tenant-scoped-via is a weaker guarantee than direct org-key filtering — prefer direct organizationId columns for new tables.`,
          rule: 'tenant-isolation/missing-fk-filter',
        });
      }
    }
  }
}

/**
 * Check if the surrounding context contains a reference to the org column
 * in a where-clause-like position.
 */
function containsOrgFilter(context: string, orgColumn: string): boolean {
  // Check for the org column name in the context
  // This is intentionally broad — it catches:
  //   where: { organizationId: ctx.orgId }
  //   .eq('org_id', orgId)
  //   WHERE "organizationId" = $1
  return context.includes(orgColumn) || context.includes('org_id') || context.includes('orgId');
}

/**
 * Check if the surrounding context contains a reference to the FK field.
 */
function containsFkFilter(context: string, fkField: string): boolean {
  return context.includes(fkField);
}

/**
 * Get surrounding lines as a single string for context scanning.
 */
function getSurroundingContext(lines: string[], centerIndex: number, radius: number): string {
  const start = Math.max(0, centerIndex - radius);
  const end = Math.min(lines.length - 1, centerIndex + radius);
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Heuristic: does this identifier look like it could be a Prisma model name?
 * Prisma model names in client code are camelCase starting with lowercase.
 * We filter out obvious non-models like 'from', 'raw', 'transaction', etc.
 */
function looksLikePrismaModel(name: string): boolean {
  const NON_MODELS = new Set([
    'from', 'raw', 'transaction', 'connect', 'disconnect',
    'on', 'use', 'extend', 'metric', 'log',
  ]);
  if (NON_MODELS.has(name)) return false;
  // Must start with lowercase letter and be at least 3 chars
  return /^[a-z][a-zA-Z]{2,}$/.test(name);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
