-- Task 3.1b — Authoritative Unit inventory.
--
-- The Unit model already has unitNumber (text), floor (int, nullable),
-- sizeSqm (double, NOT NULL), and rooms (double, nullable). Only one schema
-- change is required: relax sizeSqm so unknown values can be stored as NULL
-- (the spec forbids fabricating m²). No new columns needed.
--
-- A compound unique on ("propertyId", "unitNumber") makes the seed script's
-- (propertyId, unit_ref) upsert idempotent and prevents accidental duplicates.

ALTER TABLE public."Unit" ALTER COLUMN "sizeSqm" DROP NOT NULL;

ALTER TABLE public."Unit"
  ADD CONSTRAINT "Unit_propertyId_unitNumber_key"
  UNIQUE ("propertyId", "unitNumber");
