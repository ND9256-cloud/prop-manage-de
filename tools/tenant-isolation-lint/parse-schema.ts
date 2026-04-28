// tools/tenant-isolation-lint/parse-schema.ts
//
// Line-oriented parser for Prisma schema tenant-scoping annotations.
// Does NOT use @prisma/internals — parses raw text for stability.
//
// Recognizes three annotations on model definitions:
//   /// @tenant-scoped
//   /// @tenant-scoped-via: <fkField>
//   /// @global

import * as fs from 'fs';
import * as path from 'path';

export interface TenantScopedModel {
  name: string;
  type: 'direct' | 'indirect' | 'global';
  /** For direct: the org column name (organizationId or orgId). */
  orgColumn?: string;
  /** For indirect: the FK field that confers tenancy. */
  viaField?: string;
  /** Line number in schema file where the model is defined. */
  line: number;
}

export interface SchemaParseResult {
  models: TenantScopedModel[];
  /** Models that have no annotation — these should fail CI. */
  unannotated: { name: string; line: number }[];
  errors: string[];
}

/**
 * Parse a Prisma schema file and extract tenant-scoping annotations.
 *
 * Rules:
 *   - Annotations must appear on the line(s) immediately before `model Foo {`
 *   - `/// @tenant-scoped` marks direct tenancy (model has organizationId or orgId)
 *   - `/// @tenant-scoped-via: fieldName` marks indirect tenancy
 *   - `/// @global` marks explicitly non-tenant-scoped models
 *   - Models without any of these three annotations are flagged as unannotated
 */
export function parseSchema(schemaPath: string): SchemaParseResult {
  const content = fs.readFileSync(schemaPath, 'utf-8');
  const lines = content.split('\n');

  const models: TenantScopedModel[] = [];
  const unannotated: { name: string; line: number }[] = [];
  const errors: string[] = [];

  // Collect comment block above each model definition
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (!modelMatch) continue;

    const modelName = modelMatch[1];
    const modelLine = i + 1; // 1-indexed

    // Look backwards for comment annotations
    let annotation: string | null = null;
    let viaField: string | null = null;

    for (let j = i - 1; j >= 0 && j >= i - 10; j--) {
      const commentLine = lines[j].trim();
      if (!commentLine.startsWith('///') && !commentLine.startsWith('//')) break;

      if (commentLine.includes('@tenant-scoped-via:')) {
        const match = commentLine.match(/@tenant-scoped-via:\s*(\w+)/);
        if (match) {
          annotation = 'indirect';
          viaField = match[1];
        } else {
          errors.push(`${schemaPath}:${j + 1}: @tenant-scoped-via missing field name on model ${modelName}`);
        }
        break;
      }

      if (commentLine.includes('@tenant-scoped')) {
        annotation = 'direct';
        break;
      }

      if (commentLine.includes('@global')) {
        annotation = 'global';
        break;
      }
    }

    if (annotation === null) {
      // Check if this is an enum or other non-model — skip those
      // (We already matched `model X {` so this is a real model)
      unannotated.push({ name: modelName, line: modelLine });
      continue;
    }

    if (annotation === 'direct') {
      // Try to find the org column in the model body
      const orgColumn = findOrgColumn(lines, i);
      models.push({
        name: modelName,
        type: 'direct',
        orgColumn: orgColumn || 'organizationId',
        line: modelLine,
      });
    } else if (annotation === 'indirect') {
      models.push({
        name: modelName,
        type: 'indirect',
        viaField: viaField!,
        line: modelLine,
      });
    } else if (annotation === 'global') {
      models.push({
        name: modelName,
        type: 'global',
        line: modelLine,
      });
    }
  }

  return { models, unannotated, errors };
}

/**
 * Find the org column (organizationId or orgId) inside a model body.
 * Scans from the model opening brace until the closing brace.
 */
function findOrgColumn(lines: string[], modelStartIndex: number): string | null {
  for (let i = modelStartIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '}') break;

    // Match field declarations like: organizationId String @db.Uuid
    const fieldMatch = line.match(/^(organizationId|orgId)\s+/);
    if (fieldMatch) return fieldMatch[1];
  }
  return null;
}

/**
 * Build a lookup map from model name to tenant-scoping info.
 */
export function buildModelMap(result: SchemaParseResult): Map<string, TenantScopedModel> {
  const map = new Map<string, TenantScopedModel>();
  for (const model of result.models) {
    map.set(model.name, model);
    // Also add lowercase version for case-insensitive lookup
    map.set(model.name.toLowerCase(), model);
  }
  return map;
}
