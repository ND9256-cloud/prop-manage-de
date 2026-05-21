import assert from "node:assert/strict";
import { fuzzyTenantMatch } from "../../lib/claim-store/fuzzy-tenant-match.ts";

let passed = 0;

function check(label: string, actual: string, expected: string) {
  assert.equal(actual, expected, label);
  passed++;
  console.log(`  ✓ ${passed}. ${label}`);
}

async function run() {
  console.log("fuzzy-tenant-match tests\n");

  // 30. Reversed order → exact_match
  check(
    '"Max Müller" vs "Müller, Max" → exact_match',
    fuzzyTenantMatch("Max Müller", "Müller, Max"),
    "exact_match"
  );

  // 31. Subset match (smaller is subset of larger)
  check(
    '"Müller, Max" vs "Max Heinrich Müller" → exact_match',
    fuzzyTenantMatch("Müller, Max", "Max Heinrich Müller"),
    "exact_match"
  );

  // 32. Similar but different → no_match
  check(
    '"Bauer" vs "Baumer" → no_match',
    fuzzyTenantMatch("Bauer", "Baumer"),
    "no_match"
  );

  // 33. Anrede stripped
  check(
    '"Herr Dr. Max Müller" vs "Max Müller" → exact_match',
    fuzzyTenantMatch("Herr Dr. Max Müller", "Max Müller"),
    "exact_match"
  );

  // 34. Frau Anrede stripped
  check(
    '"Frau Anna Schmidt" vs "Schmidt, Anna" → exact_match',
    fuzzyTenantMatch("Frau Anna Schmidt", "Schmidt, Anna"),
    "exact_match"
  );

  // 35. Partial overlap
  check(
    '"Max Müller" vs "Anna Müller" → partial_match',
    fuzzyTenantMatch("Max Müller", "Anna Müller"),
    "partial_match"
  );

  // 36. Umlauts preserved, no transliteration
  check(
    '"Müller" vs "Mueller" → no_match',
    fuzzyTenantMatch("Müller", "Mueller"),
    "no_match"
  );

  // 37. Empty first arg
  check(
    '"" vs "Max Müller" → no_match',
    fuzzyTenantMatch("", "Max Müller"),
    "no_match"
  );

  // 38. Empty second arg
  check(
    '"Max Müller" vs "" → no_match',
    fuzzyTenantMatch("Max Müller", ""),
    "no_match"
  );

  // 39. Case-insensitive
  check(
    '"max müller" vs "Max Müller" → exact_match',
    fuzzyTenantMatch("max müller", "Max Müller"),
    "exact_match"
  );

  // 40. Similar surnames, one common token = partial
  check(
    '"Schmidt, Anna" vs "Schmitt, Anna" → partial_match',
    fuzzyTenantMatch("Schmidt, Anna", "Schmitt, Anna"),
    "partial_match"
  );

  // 41. Multiple Anrede stripped
  check(
    '"Dr. Prof. Max Müller" vs "Max Müller" → exact_match',
    fuzzyTenantMatch("Dr. Prof. Max Müller", "Max Müller"),
    "exact_match"
  );

  console.log(`\n✓ ${passed} fuzzy-tenant-match assertions passed`);
  if (passed < 12) {
    throw new Error(`Expected ≥12 assertions but only ${passed} passed`);
  }
}

run().catch((err) => {
  console.error(`\nFAILED after ${passed} assertions:`, err.message);
  process.exit(1);
});
