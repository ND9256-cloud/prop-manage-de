// scripts/seed-units.ts — Task 3.1b.
//
// Seeds the authoritative Unit inventory for KO132 + HHS55. Idempotent: keyed
// on (propertyId, unitNumber). Safe to re-run when Nils fills in size_sqm /
// rooms for the four units those are unknown for today.
//
// Run: DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/seed-units.ts
//
// JOIN INVARIANT (non-negotiable): unitNumber must hold canonical values
// (EG / 1.OG / DG) matching claim subjects (unit:<ref>). Any divergence here
// silently breaks Task 3.2's rentForUnit join and renders occupied units as
// vacancies.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const ORG_ID = "310131df-d6ed-4007-83c2-ac69a7e9df42";
const KO132_ID = "f37448e4-11ae-453c-ac3c-850385039c0b";
const HHS55_ID = "d2e8e9c7-957a-4e0f-8150-452c21bcae56";

interface UnitSeed {
  propertyId: string;
  unitNumber: string; // canonical
  legacyNames: string[]; // legacy German variants to upgrade from
  floor: number; // EG=0, 1.OG=1, 2.OG=2, DG=2 (top), Keller=-1 ...
  sizeSqm: number | null;
  rooms: number | null;
  shortCode: string;
}

const UNITS: UnitSeed[] = [
  { propertyId: KO132_ID, shortCode: "KO132", unitNumber: "EG",   legacyNames: ["Erdgeschoss"],     floor: 0, sizeSqm: null, rooms: null  },
  { propertyId: KO132_ID, shortCode: "KO132", unitNumber: "1.OG", legacyNames: ["1. Obergeschoss"], floor: 1, sizeSqm: 100,  rooms: 3.5   },
  { propertyId: KO132_ID, shortCode: "KO132", unitNumber: "DG",   legacyNames: ["Dachgeschoss"],    floor: 2, sizeSqm: null, rooms: null  },
  { propertyId: HHS55_ID, shortCode: "HHS55", unitNumber: "1.OG", legacyNames: [],                  floor: 1, sizeSqm: null, rooms: null  },
  { propertyId: HHS55_ID, shortCode: "HHS55", unitNumber: "DG",   legacyNames: [],                  floor: 2, sizeSqm: null, rooms: null  },
];

async function main() {
  console.log("Seeding authoritative Unit inventory (Task 3.1b)\n");

  for (const u of UNITS) {
    // Look up an existing row under the canonical name OR any legacy variant.
    const candidates = [u.unitNumber, ...u.legacyNames];
    const existing = await prisma.unit.findFirst({
      where: {
        propertyId: u.propertyId,
        unitNumber: { in: candidates },
      },
    });

    if (existing) {
      const renamed = existing.unitNumber !== u.unitNumber;
      await prisma.unit.update({
        where: { id: existing.id },
        data: {
          unitNumber: u.unitNumber,
          floor: u.floor,
          sizeSqm: u.sizeSqm,
          rooms: u.rooms,
        },
      });
      console.log(
        `  ${u.shortCode} ${u.unitNumber}: updated` +
          (renamed ? ` (renamed from "${existing.unitNumber}")` : "") +
          `  [size=${u.sizeSqm ?? "NULL"}, rooms=${u.rooms ?? "NULL"}, floor=${u.floor}]`
      );
    } else {
      await prisma.unit.create({
        data: {
          propertyId: u.propertyId,
          unitNumber: u.unitNumber,
          floor: u.floor,
          sizeSqm: u.sizeSqm,
          rooms: u.rooms,
        },
      });
      console.log(
        `  ${u.shortCode} ${u.unitNumber}: created  [size=${u.sizeSqm ?? "NULL"}, rooms=${u.rooms ?? "NULL"}, floor=${u.floor}]`
      );
    }
  }

  // Verify the JOIN INVARIANT: every claim subject of the form unit:<ref>
  // must have a Unit row with unitNumber == <ref>.
  console.log("\nVerifying join invariant against warehouse.claims …");
  const orphanSubjects = await prisma.$queryRaw<{ subject: string }[]>`
    SELECT DISTINCT c.subject
    FROM warehouse.claims c
    JOIN "Property" p ON p.id = c.property_id
    WHERE c.subject LIKE 'unit:%'
      AND p."organizationId" = ${ORG_ID}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM "Unit" u
        WHERE u."propertyId" = c.property_id
          AND ('unit:' || u."unitNumber") = c.subject
      )
  `;
  if (orphanSubjects.length > 0) {
    console.error("\n  ⚠  JOIN INVARIANT VIOLATED — claim subjects without a Unit row:");
    for (const o of orphanSubjects) console.error(`     ${o.subject}`);
    process.exit(1);
  }
  console.log("  ✓ every unit:* claim subject resolves to a Unit row");

  // Sanity-check counts.
  for (const propId of [KO132_ID, HHS55_ID]) {
    const rows = await prisma.unit.findMany({
      where: { propertyId: propId },
      select: { unitNumber: true, sizeSqm: true, rooms: true, floor: true },
      orderBy: { floor: "asc" },
    });
    console.log(
      `\n  ${propId === KO132_ID ? "KO132" : "HHS55"} now has ${rows.length} units: ` +
        rows.map((r) => r.unitNumber).join(", ")
    );
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-units failed:", err);
  process.exit(1);
});
