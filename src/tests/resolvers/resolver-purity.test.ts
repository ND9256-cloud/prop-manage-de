// CI gate: resolver modules must not import LLM clients, prompt modules,
// emitter modules, extraction modules, or make HTTP calls.
//
// Why: resolvers are pure query functions per architecture §5.1/§5.3.
// They read warehouse.claims and return ResolvedFact. If a resolver starts
// importing emitter code, LLM clients, or making HTTP calls, the architectural
// invariant is broken.

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

// No HTTP calls from resolvers — they're not integrations.
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

const resolverFiles = walk("src/lib/resolvers");

let assertions = 0;

for (const file of resolverFiles) {
  const src = readFileSync(file, "utf8");

  for (const pattern of FORBIDDEN_IMPORTS) {
    assert.ok(
      !pattern.test(src),
      `Resolver ${file} contains forbidden import matching ${pattern}. Resolvers must be pure (architecture §5.1/§5.3).`
    );
    assertions++;
  }

  assert.ok(
    !FETCH_USAGE.test(src),
    `Resolver ${file} uses fetch(). Resolvers must not make HTTP calls (architecture §5.3).`
  );
  assertions++;

  // Check for https:// literals but exclude comments that discuss the rule
  const nonCommentLines = src.split("\n").filter(line => !line.trim().startsWith("//"));
  const nonCommentSrc = nonCommentLines.join("\n");
  assert.ok(
    !HTTPS_LITERAL.test(nonCommentSrc),
    `Resolver ${file} contains https:// literal in non-comment code. Resolvers must not make HTTP calls (architecture §5.3).`
  );
  assertions++;
}

console.log(`resolver-purity: ${assertions} assertions across ${resolverFiles.length} file(s) — OK`);
