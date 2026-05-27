# Paul Mieterhöhung supersession fixture

Property: KO132 (Korbacher Straße 132), unit EG
Tenant: Paul, Friedrich
Lease start: 2022-03-01
Rent history: €525 → €575 effective 2024-01-01 (§558)

Tests supersession chain: Mietvertrag emits kaltmiete=€525; Mieterhöhung emits
new kaltmiete=€575 + kaltmiete_amended event + close_overlapping_only intent
that sets valid_to=2023-12-31 on the original claim.
