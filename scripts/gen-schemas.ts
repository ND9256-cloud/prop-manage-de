import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { validateSchemas } from "./validate-schemas";

// --- Types ---

interface FieldDef {
  id: string;
  german_label: string;
  severity: string;
  requiredness: string;
  condition?: string;
  type: string;
  enum_values?: string[];
  item_schema?: Array<{ field: string; type: string; required: boolean }>;
  description?: string;
}

interface SchemaFile {
  doc_type: string;
  schema_version: string;
  claim_kind: string;
  domain_knowledge_ref: string;
  prompt_fragment_template: string;
  fields: FieldDef[];
}

// --- Constants ---

const SCHEMAS_DIR = path.resolve(__dirname, "../schemas");

// Canonical absence_state values per architecture §3.2.
// A field is never just "missing" or "present" — it is in one of these 8 states.
// The prompt fragments instruct Sonnet to use these exact strings.
const VALID_ABSENCE_STATES = [
  "present",
  "absent",
  "illegible",
  "ambiguous",
  "contradicted",
  "not_applicable",
  "inferred",
  "requires_human_review",
] as const;

// --- Header ---

function header(docType: string, schemaVersion: string): string {
  return [
    `// DO NOT EDIT — generated from schemas/${docType}/schema.yaml`,
    `// Generator: scripts/gen-schemas.ts`,
    `// Schema version: ${schemaVersion}`,
    `// Run \`npm run gen:schemas\` to regenerate.`,
  ].join("\n");
}

// --- Generators ---

function generatePromptFragment(schema: SchemaFile): string {
  const h = header(schema.doc_type, schema.schema_version);
  const templateContent = schema.prompt_fragment_template.trimEnd();
  // Escape backticks and backslashes for template literal safety
  const escaped = templateContent.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `${h}

export const PROMPT_FRAGMENT = \`${escaped}\`;

export const SCHEMA_VERSION = ${JSON.stringify(schema.schema_version)};
export const DOC_TYPE = ${JSON.stringify(schema.doc_type)};
`;
}

function generateFieldLabels(schema: SchemaFile): string {
  const labels: Record<string, string> = {};
  for (const field of schema.fields) {
    labels[field.id] = field.german_label;
  }
  const obj = {
    schema_version: schema.schema_version,
    doc_type: schema.doc_type,
    labels,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

function generateEnvelopeValidator(schema: SchemaFile): string {
  const h = header(schema.doc_type, schema.schema_version);

  // Build per-field validation info
  const fieldChecks: string[] = [];
  for (const field of schema.fields) {
    const enumCheck =
      (field.type === "enum" || field.type === "enum_extensible") && field.enum_values
        ? `    enumValues: ${JSON.stringify(field.enum_values)},`
        : `    enumValues: null,`;
    fieldChecks.push(
      `  ${JSON.stringify(field.id)}: {\n    type: ${JSON.stringify(field.type)},\n    severity: ${JSON.stringify(field.severity)},\n${enumCheck}\n  }`
    );
  }

  const fieldMap = `{\n${fieldChecks.join(",\n")}\n}`;

  return `${h}

export class EnvelopeValidationError extends Error {
  constructor(public field: string, public check: string, message: string) {
    super(message);
    this.name = "EnvelopeValidationError";
  }
}

const VALID_ABSENCE_STATES: ReadonlyArray<string> = ${JSON.stringify(VALID_ABSENCE_STATES)};

const FIELD_DEFS: Record<string, { type: string; severity: string; enumValues: string[] | null }> = ${fieldMap};

export function validateEnvelope(envelope: unknown): void {
  if (typeof envelope !== "object" || envelope === null) {
    throw new EnvelopeValidationError("_root", "type", "Envelope must be a non-null object");
  }

  const env = envelope as Record<string, unknown>;

  for (const [fieldId, def] of Object.entries(FIELD_DEFS)) {
    const value = env[fieldId];
    if (value === undefined || value === null) {
      continue; // field not present in envelope — OK, requiredness is not enforced here
    }

    if (typeof value !== "object" || value === null) {
      throw new EnvelopeValidationError(fieldId, "shape", \`Field "\${fieldId}" value must be an object\`);
    }

    const v = value as Record<string, unknown>;

    // Check 1: evidence is required when absence_state === "present"
    // (architecture §3.1: "Evidence is mandatory unless absence_state is one of the absence states")
    if (v.absence_state === "present") {
      if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
        throw new EnvelopeValidationError(fieldId, "evidence", \`Field "\${fieldId}" must have a non-empty evidence array when absence_state == "present"\`);
      }
    } else if (v.evidence !== undefined && v.evidence !== null) {
      // If evidence is provided for a non-present field, it must still be a valid array shape
      if (!Array.isArray(v.evidence)) {
        throw new EnvelopeValidationError(fieldId, "evidence", \`Field "\${fieldId}" evidence must be an array if provided\`);
      }
    }

    // Check 2: absence_state validity (if present)
    if (v.absence_state !== undefined && v.absence_state !== null) {
      if (typeof v.absence_state !== "string" || !VALID_ABSENCE_STATES.includes(v.absence_state)) {
        throw new EnvelopeValidationError(fieldId, "absence_state", \`Field "\${fieldId}" has invalid absence_state: \${JSON.stringify(v.absence_state)}\`);
      }
    }

    // Check 3: enum type validation — applies only when absence_state == "present"
    if ((def.type === "enum") && def.enumValues !== null && v.absence_state === "present") {
      if (typeof v.normalized_value !== "string" || !def.enumValues.includes(v.normalized_value)) {
        throw new EnvelopeValidationError(fieldId, "enum_value", \`Field "\${fieldId}" normalized_value \${JSON.stringify(v.normalized_value)} is not in allowed enum_values: \${JSON.stringify(def.enumValues)}\`);
      }
    }

    // Check 4: severity must be present and match the schema (architecture §3.1:
    // "copied into extraction for eval"). The pipeline is responsible for copying
    // severity from FIELD_DEFS into each field of the envelope before calling
    // validateEnvelope. The validator confirms it landed correctly.
    if (typeof v.severity !== "string") {
      throw new EnvelopeValidationError(fieldId, "severity", \`Field "\${fieldId}" must have a string severity (pipeline should inject from FIELD_DEFS)\`);
    }
    if (v.severity !== def.severity) {
      throw new EnvelopeValidationError(fieldId, "severity_mismatch", \`Field "\${fieldId}" severity "\${v.severity}" does not match schema-declared severity "\${def.severity}"\`);
    }

    // Check 5: confidence must be one of the architecture-defined values
    if (v.confidence !== undefined && v.confidence !== null) {
      const validConfidence = ["high", "medium", "low"];
      if (typeof v.confidence !== "string" || !validConfidence.includes(v.confidence)) {
        throw new EnvelopeValidationError(fieldId, "confidence", \`Field "\${fieldId}" has invalid confidence: \${JSON.stringify(v.confidence)} (must be high | medium | low)\`);
      }
    }

    // Check 6: validation_status must be one of the architecture-defined values
    if (v.validation_status !== undefined && v.validation_status !== null) {
      const validStatus = ["valid", "failed_format", "failed_verifier", "requires_human_review"];
      if (typeof v.validation_status !== "string" || !validStatus.includes(v.validation_status)) {
        throw new EnvelopeValidationError(fieldId, "validation_status", \`Field "\${fieldId}" has invalid validation_status: \${JSON.stringify(v.validation_status)} (must be valid | failed_format | failed_verifier | requires_human_review)\`);
      }
    }
  }
}

export const SCHEMA_VERSION = ${JSON.stringify(schema.schema_version)};
export const DOC_TYPE = ${JSON.stringify(schema.doc_type)};
`;
}

// --- Main ---

function discoverDocTypes(): string[] {
  const entries = fs.readdirSync(SCHEMAS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
}

function loadSchema(docType: string): SchemaFile {
  const schemaPath = path.join(SCHEMAS_DIR, docType, "schema.yaml");
  const raw = fs.readFileSync(schemaPath, "utf-8");
  return yaml.load(raw) as SchemaFile;
}

function generateForDocType(
  docType: string,
  checkMode: boolean
): { diffFound: boolean } {
  const schema = loadSchema(docType);
  const genDir = path.join(SCHEMAS_DIR, docType, "generated");

  const outputs: Array<{ filename: string; content: string }> = [
    { filename: "prompt_fragment.ts", content: generatePromptFragment(schema) },
    { filename: "field_labels.json", content: generateFieldLabels(schema) },
    { filename: "envelope_validator.ts", content: generateEnvelopeValidator(schema) },
  ];

  if (checkMode) {
    for (const { filename, content } of outputs) {
      const filePath = path.join(genDir, filename);
      if (!fs.existsSync(filePath)) {
        console.error(`DIFF: ${filePath} does not exist on disk`);
        return { diffFound: true };
      }
      const disk = fs.readFileSync(filePath, "utf-8");
      if (disk !== content) {
        console.error(`DIFF: ${filePath} differs from generated content`);
        return { diffFound: true };
      }
    }
    return { diffFound: false };
  }

  // Write mode
  if (!fs.existsSync(genDir)) {
    fs.mkdirSync(genDir, { recursive: true });
  }

  for (const { filename, content } of outputs) {
    fs.writeFileSync(path.join(genDir, filename), content, "utf-8");
  }

  return { diffFound: false };
}

function main(): void {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const docTypeArgIdx = args.indexOf("--doc-type");
  const singleDocType = docTypeArgIdx !== -1 ? args[docTypeArgIdx + 1] : undefined;

  // Step 1: Validate all schemas first
  const { validated, errors, warnings } = validateSchemas(SCHEMAS_DIR);
  for (const warn of warnings) {
    console.warn(`WARN [${warn.check}] ${warn.file}: ${warn.message}`);
  }
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`FAIL [${err.check}] ${err.file}: ${err.message}`);
    }
    process.exit(1);
  }

  // Step 2: Generate
  const docTypes = singleDocType ? [singleDocType] : discoverDocTypes();
  let anyDiff = false;

  for (const docType of docTypes) {
    const { diffFound } = generateForDocType(docType, checkMode);
    if (diffFound) {
      anyDiff = true;
    }
  }

  if (checkMode && anyDiff) {
    console.error(
      "Generated files are out of sync with source schemas. Run `npm run gen:schemas` to regenerate."
    );
    process.exit(1);
  }

  console.log(`\u2713 Generated outputs for ${docTypes.length} doc types`);
}

main();
