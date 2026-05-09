import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// Zod schema mirroring domain_knowledge/_schema.yaml
const ClaimKind = z.enum(["assertion", "snapshot", "event", "reference"]);

const LegalGrounding = z.object({
  statute: z.string(),
  description: z.string(),
});

const NormalizationRule = z.object({
  id: z.string(),
  field: z.string(),
  description: z.string(),
});

const Gotcha = z.object({
  id: z.string(),
  description: z.string(),
  behavior: z.record(z.string(), z.unknown()).optional(),
  real_failure_reference: z.string().optional(),
});

const CloseMode = z.enum([
  "close_overlapping_only",
  "close_overlapping_and_future",
  "close_overlapping_and_supersede_future",
]);

const CloseEntry = z.object({
  target_predicate: z.string(),
  target_subject_pattern: z.string(),
  close_mode: CloseMode,
  when: z.string(),
  valid_to_source: z.string(),
  match_requirements: z.record(z.string(), z.unknown()),
  blocker_check: z.array(z.unknown()).optional(),
});

const DomainKnowledgeFrontMatter = z.object({
  doc_type: z.string(),
  default_claim_kind: ClaimKind,
  last_updated: z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}/, "must be ISO 8601 date"),
    z.date(), // js-yaml auto-parses date strings into Date objects
  ]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
  legal_grounding: z.array(LegalGrounding).default([]),
  fields_governed: z.array(z.string()).default([]),
  normalization_rules: z.array(NormalizationRule).default([]),
  gotchas: z.array(Gotcha).default([]),
  adversarial_fixtures_required: z.array(z.string()).default([]),
  closes: z.array(CloseEntry).default([]),
});

// --- Main ---

const DOMAIN_DIR = path.resolve(__dirname, "../../domain_knowledge");
const SKIP_FILES = new Set(["_schema.yaml", "README.md"]);

const files = fs.readdirSync(DOMAIN_DIR).filter(
  (f) => f.endsWith(".md") && !SKIP_FILES.has(f)
);

if (files.length === 0) {
  throw new Error("No domain knowledge .md files found in domain_knowledge/");
}

let validated = 0;

for (const file of files) {
  const filePath = path.join(DOMAIN_DIR, file);
  const raw = fs.readFileSync(filePath, "utf-8");

  // Parse front-matter between --- delimiters
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`${file}: no YAML front-matter found`);
  }

  const parsed = yaml.load(match[1]) as Record<string, unknown>;
  const result = DomainKnowledgeFrontMatter.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`${file}: front-matter validation failed:\n${issues}`);
  }

  // Assert doc_type matches filename
  const expectedDocType = file.replace(/\.md$/, "");
  if (result.data.doc_type !== expectedDocType) {
    throw new Error(
      `${file}: doc_type "${result.data.doc_type}" does not match filename (expected "${expectedDocType}")`
    );
  }

  validated++;
}

console.log(`✓ ${validated} domain knowledge files validated`);
