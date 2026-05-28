# Hofmann case fixture — Phase 2 gate

Property: HHS55 (Heinrich-Heine-Straße 55), unit DG
Tenant: Dr. Hellen Hofmann, €900/month Kaltmiete, since 2021-03-01
Ownership transfer (Nov 2025): Cornelia Bernhardt → Denn Immobilienverwaltung eGbR

The original v1 bug: an Eigentümerwechsel-Übergabeprotokoll was misclassified
and silently closed Hofmann's tenant + rent claims, dropping HHS55's monthly
total from €1,900 to €1,000.

## What this fixture verifies

Positive: processing the Eigentümerwechsel transfers ownership (new owner
claim, previous owner closed) but leaves Hofmann's tenant_active and
kaltmiete claims ACTIVE. rentForUnit(HHS55, DG) still returns €900.

Negative control: processing an Auszug for the same unit DOES close the
rent + tenant claims. rentForUnit then returns null.

If both hold, the Hofmann bug is structurally fixed (BGB §566: Kauf bricht
nicht Miete — sale does not break the lease).
