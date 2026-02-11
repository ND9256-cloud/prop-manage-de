
import 'dotenv/config';
import { PrismaClient, PropertyType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('Seeding database...');

    // --- Organization ---
    const org = await prisma.organization.upsert({
        where: { slug: 'demo-mgmt' },
        update: {},
        create: {
            name: 'Demo Property Management GmbH',
            slug: 'demo-mgmt',
        },
    });
    console.log(`Organization: ${org.name}`);

    // --- Admin User ---
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const admin = await prisma.user.upsert({
        where: { email: 'admin@demo.com' },
        update: { hashedPassword },
        create: {
            name: 'Admin',
            email: 'admin@demo.com',
            hashedPassword,
            role: 'ORG_ADMIN',
            organizationId: org.id,
        },
    });
    console.log(`Admin user: ${admin.email}`);

    // --- Property: Korbacher Straße 132 ---
    const property = await prisma.property.create({
        data: {
            name: 'Elgershausen, Korbacher Straße 132',
            address: 'Korbacher Straße 132',
            city: 'Schauenburg',
            zip: '34270',
            country: 'DE',
            type: PropertyType.APARTMENT_BUILDING,
            organizationId: org.id,
        },
    });
    console.log(`Property: ${property.name}`);

    // --- Units ---
    const unitEG = await prisma.unit.create({
        data: {
            unitNumber: 'Erdgeschoss',
            floor: 0,
            sizeSqm: 100,
            propertyId: property.id,
        },
    });

    const unit1OG = await prisma.unit.create({
        data: {
            unitNumber: '1. Obergeschoss',
            floor: 1,
            sizeSqm: 100,
            propertyId: property.id,
        },
    });

    const unitDG = await prisma.unit.create({
        data: {
            unitNumber: 'Dachgeschoss',
            floor: 2,
            sizeSqm: 80,
            propertyId: property.id,
        },
    });
    console.log('Created 3 units');

    // --- Persons (Tenants) ---
    const paul = await prisma.person.create({
        data: {
            firstName: 'Julija',
            lastName: 'Paul',
            organizationId: org.id,
        },
    });

    const everding = await prisma.person.create({
        data: {
            firstName: 'Lena',
            lastName: 'Everding',
            organizationId: org.id,
        },
    });

    const kuru = await prisma.person.create({
        data: {
            firstName: 'Saniye',
            lastName: 'Kuru',
            organizationId: org.id,
        },
    });
    console.log('Created 3 persons');

    // --- Leases ---
    // Excel date serial 44713 = 2022-06-01, 45748 = 2025-04-01, 43770 = 2019-11-01
    // Excel date serial 45717 = 2025-03-01 (last rent increase)
    await prisma.lease.create({
        data: {
            startDate: new Date('2022-06-01'),
            status: 'ACTIVE',
            coldRent: 575.0,
            utilityAdvance: 230.0,
            deposit: 1100.0,
            rentIncreaseRule: '§ 558 BGB',
            lastRentIncreaseAt: new Date('2025-03-01'),
            cpiAtIncrease: 121.2, // VPI März 2025 (Destatis 61111-0002, Basis 2020=100)
            cpiCurrent: 122.7,    // VPI Dezember 2025
            unitId: unitEG.id,
            mainTenantId: paul.id,
        },
    });

    await prisma.lease.create({
        data: {
            startDate: new Date('2025-04-01'),
            status: 'ACTIVE',
            coldRent: 650.0,
            utilityAdvance: 270.0,
            deposit: 1950.0,
            rentIncreaseRule: 'VPI-Index',
            cpiCurrent: 122.7,    // VPI Dezember 2025
            unitId: unit1OG.id,
            mainTenantId: everding.id,
        },
    });

    await prisma.lease.create({
        data: {
            startDate: new Date('2019-11-01'),
            status: 'ACTIVE',
            coldRent: 470.0,
            utilityAdvance: 130.0,
            deposit: 900.0,
            rentIncreaseRule: '§ 558 BGB',
            lastRentIncreaseAt: new Date('2025-03-01'),
            cpiAtIncrease: 121.2, // VPI März 2025
            cpiCurrent: 122.7,    // VPI Dezember 2025
            unitId: unitDG.id,
            mainTenantId: kuru.id,
        },
    });
    console.log('Created 3 leases');

    console.log('\nSeed complete!');
    await prisma.$disconnect();
    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
