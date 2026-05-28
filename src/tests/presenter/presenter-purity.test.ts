// CI gate: presenter source must not import claim-store, resolver functions,
// composer functions, DB clients, or anything that would let it grow into a
// "second brain." Architecture §5.4.6.
//
// Why: the Presenter is a render-only layer. Its safety contract is enforced
// by two things: (1) the system prompt forbids invention/conflict-resolution,
// (2) this gate forbids the presenter from ever GAINING access to raw data.
// The only runtime import allowed is @anthropic-ai/sdk. Type-only imports
// from resolvers/composer/types are fine (the presenter needs to know the
// SHAPE of its input); function imports are not.
//
// Mirrors src/tests/composer/composer-purity.test.ts patterns.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

// Imports that are forbidden ENTIRELY — neither runtime nor type:
const FORBIDDEN_RUNTIME_OR_TYPE = [
  { pattern: /from\s+["']@\/lib\/db["']/, label: "@/lib/db (Prisma client)" },
  { pattern: /from\s+["']@\/lib\/claim-store/, label: "@/lib/claim-store" },
  { pattern: /from\s+["']@\/lib\/extractions/, label: "@/lib/extractions" },
  { pattern: /from\s+["']@\/lib\/emitters/, label: "@/lib/emitters" },
  { pattern: /from\s+["']@supabase\/supabase-js["']/, label: "@supabase/supabase-js" },
  { pattern: /from\s+["']@\/lib\/supabase/, label: "@/lib/supabase" },
  { pattern: /from\s+["']prisma["']/, label: "prisma" },
  { pattern: /from\s+["']@prisma\//, label: "@prisma/*" },
  { pattern: /from\s+["']node:fs["']/, label: "node:fs" },
  { pattern: /from\s+["']fs["']/, label: "fs" },
  { pattern: /from\s+["']fs\/promises["']/, label: "fs/promises" },
];

// Imports that are allowed ONLY as `import type` from a specific allowlist:
//   - ../resolvers/types          (ResolvedFact, Money, etc.)
//   - ../composer/types           (PropertySnapshot, etc.)
// Any other resolvers/* or composer/* import is forbidden — even type-only.
function checkResolverComposerImports(src: string, file: string): number {
  let assertions = 0;
  const lines = src.split("\n");
  for (const line of lines) {
    const m = line.match(/from\s+["']([^"']*(?:resolvers|composer)[^"']*)["']/);
    if (!m) continue;
    const importPath = m[1];

    // Allow type imports from the type modules only.
    const isResolverTypesModule = /resolvers\/types(?:\.ts)?$/.test(importPath);
    const isComposerTypesModule = /composer\/types(?:\.ts)?$/.test(importPath);
    const isTypeOnly = /^\s*import\s+type\b/.test(line);

    if ((isResolverTypesModule || isComposerTypesModule) && isTypeOnly) {
      assertions++;
      continue;
    }

    assert.ok(
      false,
      `Presenter ${file}: forbidden import "${importPath}". Presenter may only \`import type\` from "../resolvers/types" or "../composer/types"; any other resolver/composer import is forbidden. Line: ${line.trim()}`,
    );
  }
  return assertions;
}

// Direct fetch usage is forbidden — only @anthropic-ai/sdk's internal fetch
// is allowed (which is library-internal and invisible to grep).
const FETCH_USAGE = /\bfetch\s*\(/;

// https:// literals in non-comment code would indicate a hand-rolled HTTP call.
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

const presenterFiles = walk("src/lib/presenter");

assert.ok(
  presenterFiles.length > 0,
  "presenter-purity: expected at least one .ts file under src/lib/presenter",
);

let assertions = 0;

for (const file of presenterFiles) {
  const src = readFileSync(file, "utf8");

  // No "use server" directive — the presenter is a library, not a server action.
  // Check non-comment lines only so we don't flag prose explaining the rule.
  const nonCommentForDirective = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.ok(
    !/^\s*['"]use server['"]\s*;?\s*$/m.test(nonCommentForDirective),
    `Presenter ${file} declares "use server". The presenter is a LIBRARY, not a server action (architecture §5.4.6).`,
  );
  assertions++;

  for (const { pattern, label } of FORBIDDEN_RUNTIME_OR_TYPE) {
    assert.ok(
      !pattern.test(src),
      `Presenter ${file} contains forbidden import: ${label}. The presenter must not access raw data (architecture §5.4.6).`,
    );
    assertions++;
  }

  assertions += checkResolverComposerImports(src, file);

  assert.ok(
    !FETCH_USAGE.test(src),
    `Presenter ${file} uses fetch(). The presenter must not make raw HTTP calls; use @anthropic-ai/sdk (architecture §5.4.6).`,
  );
  assertions++;

  const nonCommentLines = src.split("\n").filter((line) => !line.trim().startsWith("//"));
  const nonCommentSrc = nonCommentLines.join("\n");
  assert.ok(
    !HTTPS_LITERAL.test(nonCommentSrc),
    `Presenter ${file} contains https:// literal in non-comment code. The presenter must not make raw HTTP calls (architecture §5.4.6).`,
  );
  assertions++;
}

console.log(
  `presenter-purity: ${assertions} assertions across ${presenterFiles.length} file(s) — OK`,
);
