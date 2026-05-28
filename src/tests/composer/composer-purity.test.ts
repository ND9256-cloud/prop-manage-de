// CI gate: composer modules must not import LLM clients, prompt modules,
// emitter modules, extraction modules, or make HTTP calls.
//
// Why: the composer is the deterministic brain replacement per architecture
// §5.4.1/§5.4.3. The whole point is "no LLM, no inference, no prompts." If a
// composer module starts importing prompt code or fetch()ing model APIs, the
// architectural invariant is broken.
//
// Mirrors src/tests/resolvers/resolver-purity.test.ts; intentionally a SLIGHTLY
// stricter version (composer does NOT need to import emitter or extraction
// code either — anything beyond resolvers + DB is forbidden).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const FORBIDDEN_IMPORTS = [
  /from\s+["']@anthropic-ai\//,
  /from\s+["']openai["']/,
  /from\s+["'].*emitters\//,
  /from\s+["'].*supabase\/functions\/process-document\//,
  /from\s+["'].*prompt.*["']/,
  /from\s+["'].*extract.*["']/,
];

const FETCH_USAGE = /\bfetch\s*\(/;
const HTTPS_LITERAL = /https?:\/\//;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const composerFiles = walk("src/lib/composer");

let assertions = 0;

for (const file of composerFiles) {
  const src = readFileSync(file, "utf8");

  for (const pattern of FORBIDDEN_IMPORTS) {
    assert.ok(
      !pattern.test(src),
      `Composer ${file} contains forbidden import matching ${pattern}. The composer must be pure (architecture §5.4.1/§5.4.3).`
    );
    assertions++;
  }

  assert.ok(
    !FETCH_USAGE.test(src),
    `Composer ${file} uses fetch(). The composer must not make HTTP calls (architecture §5.4.1).`
  );
  assertions++;

  // Allow https:// only inside // comments (we discuss the rule in prose).
  const nonCommentLines = src.split("\n").filter((line) => !line.trim().startsWith("//"));
  const nonCommentSrc = nonCommentLines.join("\n");
  assert.ok(
    !HTTPS_LITERAL.test(nonCommentSrc),
    `Composer ${file} contains https:// literal in non-comment code. The composer must not make HTTP calls (architecture §5.4.1).`
  );
  assertions++;
}

console.log(
  `composer-purity: ${assertions} assertions across ${composerFiles.length} file(s) — OK`
);
