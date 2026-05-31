// Test for Task 4.2c: --fixture-id substring targeting in the eval CLI.
//
// Drives the pure `applyFixtureId` filter (exported from run.ts) against the
// REAL on-disk fixtures loaded by the loader. No DB, no Anthropic API, no
// live extraction — just the deterministic substring filter.
//
// Asserts the three behaviours the flag promises:
//   1. A narrow substring selects exactly the expected fixture(s).
//   2. A broader substring returns all matches.
//   3. Zero matches is a hard error whose message names the bad value and
//      lists the available fixture_ids (never a silent no-op).

import assert from "node:assert/strict";

import { applyFixtureId } from "../../../scripts/eval/run.ts";
import { loadFixtures } from "../../../scripts/eval/loader.ts";

let assertions = 0;
function ok(cond: boolean, msg: string) {
  assertions++;
  assert.equal(cond, true, msg);
}
function eq<T>(a: T, b: T, msg: string) {
  assertions++;
  assert.deepStrictEqual(a, b, msg);
}

const all = loadFixtures();
ok(all.length >= 2, "fixture-id: at least two real fixtures load from tests/fixtures/extraction/");

// ── (2) broad substring returns ALL matches ───────────────────────────────
// Every fixture_id is "<case>/<envelope>.json", so ".json" matches all of them.
{
  const broad = applyFixtureId(all, ".json");
  eq(
    broad.map((f) => f.fixture_id).sort(),
    all.map((f) => f.fixture_id).sort(),
    "broad substring '.json' returns every fixture",
  );
}

// ── (1) narrow substring selects EXACTLY the expected fixture(s) ───────────
// A fixture's own full id is the narrowest substring: it must select exactly
// the fixtures whose id contains it (always at least that fixture itself).
{
  const target = all[0].fixture_id;
  const narrow = applyFixtureId(all, target);
  const expected = all.filter((f) => f.fixture_id.includes(target)).map((f) => f.fixture_id).sort();
  eq(narrow.map((f) => f.fixture_id).sort(), expected, "full-id substring selects exactly the expected fixture(s)");
  ok(narrow.some((f) => f.fixture_id === target), "narrow result includes the targeted fixture");
  ok(narrow.every((f) => f.fixture_id.includes(target)), "every narrow result contains the substring");
}

// A short substring drawn from a real fixture_id selects exactly the subset
// that contains it — and nothing that does not. This is the "target one case
// by name" use the flag exists for (e.g. `--fixture-id lena`).
{
  const ref = all[0].fixture_id;
  // Take a distinctive mid-slice of the first fixture's id as the needle.
  const start = Math.max(0, Math.floor(ref.length / 3));
  const needle = ref.slice(start, start + Math.max(3, Math.floor(ref.length / 4)));
  const selected = applyFixtureId(all, needle);
  const expected = all.filter((f) => f.fixture_id.includes(needle)).map((f) => f.fixture_id).sort();
  eq(selected.map((f) => f.fixture_id).sort(), expected, `substring "${needle}" selects exactly the fixtures that contain it`);
  ok(selected.every((f) => f.fixture_id.includes(needle)), "no non-matching fixture leaks into the selection");
}

// Substring match is case-sensitive: upper-casing a real id must not match
// (unless the id already contains that exact upper-case run, which fixtures
// here do not). Guard only runs when the id has an alphabetic char to flip.
{
  const ref = all[0].fixture_id;
  if (/[a-z]/.test(ref) && !all.some((f) => f.fixture_id.includes(ref.toUpperCase()))) {
    let threw = false;
    try {
      applyFixtureId(all, ref.toUpperCase());
    } catch {
      threw = true;
    }
    ok(threw, "substring match is case-sensitive (upper-cased id does not match)");
  }
}

// ── (3) zero matches → hard error that names the value and lists ids ───────
{
  const bogus = "no-such-fixture-zzz-4_2c";
  let threw = false;
  try {
    applyFixtureId(all, bogus);
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(`no fixture matches --fixture-id ${bogus}`), "zero-match error names the bad value");
    for (const f of all) {
      ok(msg.includes(f.fixture_id), `zero-match error lists available fixture_id ${f.fixture_id}`);
    }
  }
  ok(threw, "zero matches throws rather than silently returning []");
}

console.log(`fixture-id.test.ts: ${assertions} assertions passed`);
