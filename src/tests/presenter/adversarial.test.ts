// Env: run via DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config <this file>
//
// Adversarial fixture set for the Presenter. Architecture §5.4.6.
//
// Each fixture is a PropertySnapshot or ResolvedFact designed to TEMPT the LLM
// into a v1-brain failure mode: invent a tenant, smooth over a conflict, fill
// in a missing value, silently convert a currency, obey a prompt injection
// hidden inside the JSON data. The test loads every fixture and asserts:
//
//   - positive: the prose contains at least one of "must_contain_any" and all
//     of "must_contain_all" (tolerant — substring match)
//   - negative: the prose contains none of "must_not_contain" (STRICT —
//     a single leaked forbidden token fails the test)
//   - regex-negative: optional "must_not_contain_regex" patterns must not match
//
// Non-determinism: positive assertions are case-insensitive substring; the
// negative ones are strict because the architectural risk is that the LLM
// invents content, and an invented value is a failure regardless of phrasing.
//
// Why these fixtures: every one corresponds to a real failure mode. Hofmann
// (vacant inferred from incomplete data) → vacant-no-data + needs-review.
// Mieterhöhung supersession bugs → conflict + needs-review. Prompt-injection
// is a v1 risk because raw_value strings flow through unsanitized.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderPropertySnapshot,
  renderResolvedFact,
} from "../../lib/presenter/render";
import type { PropertySnapshot } from "../../lib/composer/types";
import type { ResolvedFact } from "../../lib/resolvers/types";
import type { RenderHints } from "../../lib/presenter/types";

interface Fixture {
  kind: "PropertySnapshot" | "ResolvedFact";
  scenario: string;
  must_contain_any?: string[];
  must_contain_all?: string[];
  must_not_contain?: string[];
  must_not_contain_regex?: string[];
  snapshot?: PropertySnapshot;
  fact?: ResolvedFact<unknown>;
  hints?: RenderHints | null;
}

const FIXTURES_DIR = "src/tests/presenter/fixtures";

function loadFixtures(): { file: string; data: Fixture }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.startsWith("adversarial-") && f.endsWith(".json"))
    .sort()
    .map((file) => {
      const path = join(FIXTURES_DIR, file);
      const data = JSON.parse(readFileSync(path, "utf8")) as Fixture;
      return { file, data };
    });
}

function lower(s: string): string {
  return s.toLowerCase();
}

function checkPositive(prose: string, fixture: Fixture, file: string): number {
  const lp = lower(prose);
  let asserts = 0;

  if (fixture.must_contain_any && fixture.must_contain_any.length > 0) {
    const hit = fixture.must_contain_any.some((s) => lp.includes(lower(s)));
    if (!hit) {
      throw new Error(
        `[${file}] prose lacked ANY of must_contain_any=${JSON.stringify(
          fixture.must_contain_any,
        )}. Prose was:\n---\n${prose}\n---`,
      );
    }
    asserts++;
  }

  if (fixture.must_contain_all && fixture.must_contain_all.length > 0) {
    for (const s of fixture.must_contain_all) {
      if (!lp.includes(lower(s))) {
        throw new Error(
          `[${file}] prose missing required substring "${s}". Prose was:\n---\n${prose}\n---`,
        );
      }
      asserts++;
    }
  }

  return asserts;
}

function checkNegative(prose: string, fixture: Fixture, file: string): number {
  let asserts = 0;

  if (fixture.must_not_contain) {
    for (const forbidden of fixture.must_not_contain) {
      // STRICT case-insensitive substring. A leaked invented value fails
      // regardless of phrasing variation.
      if (lower(prose).includes(lower(forbidden))) {
        throw new Error(
          `[${file}] prose contained forbidden substring "${forbidden}" — invention/leak detected. Prose was:\n---\n${prose}\n---`,
        );
      }
      asserts++;
    }
  }

  if (fixture.must_not_contain_regex) {
    for (const pattern of fixture.must_not_contain_regex) {
      const re = new RegExp(pattern, "i");
      if (re.test(prose)) {
        throw new Error(
          `[${file}] prose matched forbidden regex /${pattern}/ — invention detected. Prose was:\n---\n${prose}\n---`,
        );
      }
      asserts++;
    }
  }

  return asserts;
}

async function renderFixture(fixture: Fixture): Promise<string> {
  if (fixture.kind === "PropertySnapshot") {
    if (!fixture.snapshot) throw new Error("PropertySnapshot fixture missing .snapshot");
    return renderPropertySnapshot(fixture.snapshot, fixture.hints ?? undefined);
  }
  if (fixture.kind === "ResolvedFact") {
    if (!fixture.fact) throw new Error("ResolvedFact fixture missing .fact");
    return renderResolvedFact(fixture.fact, fixture.hints ?? undefined);
  }
  throw new Error(`unknown fixture kind: ${(fixture as { kind: string }).kind}`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set; the presenter adversarial tests require live LLM calls.",
    );
    process.exit(2);
  }

  const fixtures = loadFixtures();
  if (fixtures.length < 8) {
    throw new Error(
      `Expected at least 8 adversarial fixtures, found ${fixtures.length}. Architecture §5.4.6 requires the adversarial set to cover the v1 brain failure modes.`,
    );
  }

  let totalAssertions = 0;
  let passedFixtures = 0;

  for (const { file, data } of fixtures) {
    console.log(`\n--- ${file}: ${data.scenario} ---`);
    const prose = await renderFixture(data);
    console.log(`  prose: ${prose.replace(/\s+/g, " ").slice(0, 240)}${prose.length > 240 ? "…" : ""}`);
    const pos = checkPositive(prose, data, file);
    const neg = checkNegative(prose, data, file);
    console.log(`  ✓ ${pos} positive + ${neg} negative assertions OK`);
    totalAssertions += pos + neg;
    passedFixtures++;
  }

  console.log(
    `\nadversarial: ${passedFixtures}/${fixtures.length} fixtures passed, ${totalAssertions} total assertions — OK`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
