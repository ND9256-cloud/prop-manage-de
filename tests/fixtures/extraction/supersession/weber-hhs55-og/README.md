# Weber Mieterhöhung supersession fixture — the original bug case

Property: HHS55 (Heinrich-Heine-Straße 55), unit OG
Tenant: Weber, Anna
Lease start: 2018-06-01
Rent history: €900 → €1,000 effective 2024-04-01 (§558)

This is the case that motivated the v2 architecture. In v1, the new rent
overwrote the old one; historical queries returned the wrong amount. With v2,
the old claim persists with valid_to set, and the resolver respects as_of_date.
