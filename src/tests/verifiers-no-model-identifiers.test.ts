import * as fs from "fs";
import * as path from "path";

const VERIFIER_DIR = path.resolve(
  __dirname,
  "../../supabase/functions/process-document/verifiers"
);

// Model identifiers that must NEVER appear in verifier source.
// Verifiers must be model-agnostic per architecture §9.3.
const FORBIDDEN_TOKENS = [
  "sonnet",
  "haiku",
  "opus",
  "gpt",
  "gemini",
  "claude",
  "llama",
  "mistral",
];

function scanFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
  const found: string[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

const files = fs
  .readdirSync(VERIFIER_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(VERIFIER_DIR, f));

let violations = 0;
for (const file of files) {
  const found = scanFile(file);
  if (found.length > 0) {
    console.error(
      `\u2717 ${path.basename(file)} contains forbidden model identifier(s): ${found.join(", ")}`
    );
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\nVerifier source files must be model-agnostic (architecture §9.3). Remove model identifiers from the above files.`
  );
  process.exit(1);
}

console.log(`\u2713 ${files.length} verifier files scanned, no model identifiers found`);
