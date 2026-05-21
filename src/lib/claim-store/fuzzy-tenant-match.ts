// Fuzzy tenant-name matching for closure intent verification.
//
// Architecture §5.5.6: token-subset match, no Levenshtein (false positives on
// short German names like Bauer/Baumer).
//
// Rules (in order):
//   1. Both names lowercased
//   2. Anrede (Herr, Frau, Dr.) stripped
//   3. Tokenize on whitespace + commas
//   4. If smaller token-set is a subset of larger → exact_match
//   5. If overlap but not subset → partial_match (caller decides whether to proceed)
//   6. No overlap → no_match
//
// Umlauts preserved (not transliterated). "Müller" ≠ "Mueller" by design — if
// extraction normalizes one way and the document writes another, that's a real
// ambiguity that should surface as partial_match.

const ANREDE = new Set(["herr", "frau", "dr", "prof", "dr.", "prof."]);

export type MatchResult = "exact_match" | "partial_match" | "no_match";

export function fuzzyTenantMatch(a: string, b: string): MatchResult {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) {
    return "no_match";
  }

  const [smaller, larger] = tokensA.size <= tokensB.size
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  let allInLarger = true;
  let anyInLarger = false;
  for (const t of smaller) {
    if (larger.has(t)) {
      anyInLarger = true;
    } else {
      allInLarger = false;
    }
  }

  if (allInLarger) return "exact_match";
  if (anyInLarger) return "partial_match";
  return "no_match";
}

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0 && !ANREDE.has(t))
  );
}
