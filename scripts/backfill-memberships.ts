/**
 * Backfill memberships from existing User.organizationId
 * Run: npx tsx -r dotenv/config scripts/backfill-memberships.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

async function main() {
    const users = await prisma.user.findMany({
        where: { organizationId: { not: null } },
        select: { id: true, organizationId: true, email: true },
    });

    console.log(`Found ${users.length} users with organizationId.`);

    for (const user of users) {
        await prisma.membership.upsert({
            where: {
                userId_orgId: {
                    userId: user.id,
                    orgId: user.organizationId!,
                },
            },
            create: {
                userId: user.id,
                orgId: user.organizationId!,
                role: 'owner',
            },
            update: {}, // no-op if exists
        });
        console.log(`  ✅ ${user.email} → owner`);
    }

    console.log(`\nBackfilled ${users.length} memberships.`);

    // Verify
    const memberships = await prisma.membership.findMany({
        include: { user: { select: { email: true } }, organization: { select: { name: true } } },
    });
    console.log('\n📋 Memberships:');
    for (const m of memberships) {
        console.log(`  ${m.user.email} → ${m.organization.name} (${m.role})`);
    }
}

main()
    .catch(console.error)
    .finally(async () => { await pool.end(); });
