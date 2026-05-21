// CI gate: emitter modules must not import DB, fetch, or other I/O.
//
// Why: emitters are pure functions per architecture $4.4. The applier
// (Task 1.8) does the I/O. If an emitter starts querying Prisma or
// calling fetch, the architectural invariant is broken and tests
// downstream get harder to write.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const FORBIDDEN_IMPORTS = [
  /from\s+["']@?\/?(lib\/)?prisma["']/,
  /from\s+["']@prisma\/client["']/,
  /from\s+["']@?\/?(lib\/)?db["']/,
  /from\s+["']@?\/?(lib\/)?supabase/,
  /from\s+["']pg["']/,
  /from\s+["']node-fetch["']/,
  /require\s*\(\s*["']pg["']\)/,
];

// Built-in fetch is also forbidden in emitter modules.
const FETCH_USAGE = /\bfetch\s*\(/;

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

const emitterFiles = walk("src/lib/emitters")
  .filter(f => !f.endsWith(".test.ts") && !f.endsWith("/types.ts"));

let assertions = 0;

for (const file of emitterFiles) {
  const src = readFileSync(file, "utf8");

  for (const pattern of FORBIDDEN_IMPORTS) {
    assert.ok(
      !pattern.test(src),
      `Emitter ${file} contains forbidden import matching ${pattern}. Emitters must be pure (architecture $4.4).`
    );
    assertions++;
  }

  assert.ok(
    !FETCH_USAGE.test(src),
    `Emitter ${file} uses fetch(). Emitters must be pure (architecture $4.4). Move I/O to the applier.`
  );
  assertions++;
}

console.log(`emitter-purity: ${assertions} assertions across ${emitterFiles.length} file(s) — OK`);
