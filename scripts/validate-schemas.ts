import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// --- Zod schema mirroring schemas/_meta_schema.yaml ---

const ClaimKind = z.enum(["assertion", "snapshot", "event", "reference"]);
const Severity = z.enum(["critical", "important", "nice_to_have"]);
const Requiredness = z.enum(["required", "conditional", "optional"]);
const FieldType = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "money",
  "enum",
  "enum_extensible",
  "structured",
  "structured_array",
]);

const ItemSchemaEntry = z.object({
  field: z.string(),
  type: z.string(),
  required: z.boolean(),
});

const FieldDef = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, "must be snake_case"),
    german_label: z.string().min(1),
    severity: Severity,
    requiredness: Requiredness,
    condition: z.string().optional(),
    type: FieldType,
    enum_values: z.array(z.string()).optional(),
    item_schema: z.array(ItemSchemaEntry).optional(),
    verifier_refs: z.array(z.string()).default([]),
    normalization_rule_ref: z.string().optional(),
    description: z.string().optional(),
    used_in_resolvers: z.boolean().default(false),
    customer_visible: z.boolean().default(true),
    classification_hints: z.string().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.requiredness === "conditional" && !field.condition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field "${field.id}": requiredness is "conditional" but no condition provided`,
      });
    }
    if (
      (field.type === "enum" || field.type === "enum_extensible") &&
      (!field.enum_values || field.enum_values.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field "${field.id}": type is "${field.type}" but no enum_values provided`,
      });
    }
    if (
      (field.type === "structured" || field.type === "structured_array") &&
      (!field.item_schema || field.item_schema.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field "${field.id}": type is "${field.type}" but no item_schema provided`,
      });
    }
  });

const SchemaFile = z.object({
  doc_type: z.string(),
  schema_version: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}-v\d+$/, "must match YYYY-MM-DD-vN format"),
  claim_kind: ClaimKind,
  domain_knowledge_ref: z.string(),
  prompt_fragment_template: z.string(),
  fields: z.array(FieldDef).min(1, "fields must contain at least one entry"),
});

// --- Validation logic ---

export interface ValidationError {
  file: string;
  check: string;
  message: string;
}

export function validateSchemas(schemasDir?: string): {
  validated: number;
  errors: ValidationError[];
} {
  const SCHEMAS_DIR = schemasDir ?? path.resolve(__dirname, "../schemas");
  const errors: ValidationError[] = [];
  let validated = 0;

  const entries = fs.readdirSync(SCHEMAS_DIR, { withFileTypes: true });
  const docTypeDirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith("_")
  );

  if (docTypeDirs.length === 0) {
    errors.push({
      file: SCHEMAS_DIR,
      check: "discovery",
      message: "No doc-type subdirectories found in schemas/",
    });
    return { validated: 0, errors };
  }

  for (const dir of docTypeDirs) {
    const docType = dir.name;
    const schemaPath = path.join(SCHEMAS_DIR, docType, "schema.yaml");

    // Check B (partial) — file must exist
    if (!fs.existsSync(schemaPath)) {
      errors.push({
        file: schemaPath,
        check: "B",
        message: `schema.yaml not found in schemas/${docType}/`,
      });
      continue;
    }

    const raw = fs.readFileSync(schemaPath, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = yaml.load(raw) as Record<string, unknown>;
    } catch (e) {
      errors.push({
        file: schemaPath,
        check: "A",
        message: `YAML parse error: ${(e as Error).message}`,
      });
      continue;
    }

    // Check A — meta-schema validity
    const result = SchemaFile.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      errors.push({
        file: schemaPath,
        check: "A",
        message: `Meta-schema validation failed:\n${issues}`,
      });
      continue;
    }

    const schema = result.data;

    // Check B — directory and filename consistency
    if (schema.doc_type !== docType) {
      errors.push({
        file: schemaPath,
        check: "B",
        message: `doc_type "${schema.doc_type}" does not match directory name "${docType}"`,
      });
    }

    // Check C — cross-reference to domain knowledge
    const dkPath = path.resolve(SCHEMAS_DIR, "..", schema.domain_knowledge_ref);
    if (!fs.existsSync(dkPath)) {
      errors.push({
        file: schemaPath,
        check: "C",
        message: `domain_knowledge_ref "${schema.domain_knowledge_ref}" does not exist at ${dkPath}`,
      });
    } else {
      const dkRaw = fs.readFileSync(dkPath, "utf-8");
      const fmMatch = dkRaw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        errors.push({
          file: schemaPath,
          check: "C",
          message: `Domain knowledge file "${schema.domain_knowledge_ref}" has no YAML front-matter`,
        });
      } else {
        const dkParsed = yaml.load(fmMatch[1]) as Record<string, unknown>;

        // claim_kind must match default_claim_kind
        if (dkParsed.default_claim_kind !== schema.claim_kind) {
          errors.push({
            file: schemaPath,
            check: "C",
            message: `claim_kind "${schema.claim_kind}" does not match domain knowledge default_claim_kind "${dkParsed.default_claim_kind}"`,
          });
        }

        // fields_governed coverage
        const fieldsGoverned = Array.isArray(dkParsed.fields_governed)
          ? (dkParsed.fields_governed as string[])
          : [];
        const schemaFieldIds = new Set(schema.fields.map((f) => f.id));
        for (const governed of fieldsGoverned) {
          if (!schemaFieldIds.has(governed)) {
            errors.push({
              file: schemaPath,
              check: "C",
              message: `Domain knowledge fields_governed entry "${governed}" not found in schema fields`,
            });
          }
        }

        // Check D — normalization_rule_ref integrity
        const normRules = Array.isArray(dkParsed.normalization_rules)
          ? (dkParsed.normalization_rules as Array<{ id: string }>)
          : [];
        const normRuleIds = new Set(normRules.map((r) => r.id));

        for (const field of schema.fields) {
          if (
            field.normalization_rule_ref &&
            !normRuleIds.has(field.normalization_rule_ref)
          ) {
            errors.push({
              file: schemaPath,
              check: "D",
              message: `Field "${field.id}" has normalization_rule_ref "${field.normalization_rule_ref}" not found in domain knowledge normalization_rules`,
            });
          }
        }
      }
    }

    if (!errors.some((e) => e.file === schemaPath)) {
      validated++;
    }
  }

  return { validated, errors };
}

// --- CLI entry point ---
if (require.main === module || process.argv[1]?.endsWith("validate-schemas.ts")) {
  const { validated, errors } = validateSchemas();

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`FAIL [${err.check}] ${err.file}: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`\u2713 ${validated} schemas validated`);
}
