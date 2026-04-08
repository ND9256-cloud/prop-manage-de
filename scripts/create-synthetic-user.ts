/**
 * Create Synthetic Monitor User — One-time setup script
 * Creates a viewer-role synthetic user for Playwright smoke tests.
 * Idempotent: exits cleanly if the user already exists.
 *
 * Run: DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/create-synthetic-user.ts
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const SYNTHETIC_EMAIL = 'synthetic-monitor@prop-manage-de.internal';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

async function main() {
  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { email: SYNTHETIC_EMAIL },
  });

  if (existing) {
    console.log(`✅ Synthetic user already exists: ${existing.id}`);
    console.log('   No changes made.');
    return;
  }

  // Find the org (Denn & Denn or fallback to first org)
  const org = await prisma.organization.findFirst({
    where: { name: { contains: 'Denn' } },
  });
  const targetOrg = org ?? await prisma.organization.findFirst();

  if (!targetOrg) {
    console.error('❌ No organization found in database.');
    process.exit(1);
  }

  // Generate a secure random password
  const password = crypto.randomBytes(32).toString('hex');
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create the synthetic user
  const user = await prisma.user.create({
    data: {
      email: SYNTHETIC_EMAIL,
      name: 'Synthetic Monitor',
      hashedPassword,
      role: 'PROPERTY_MANAGER', // lowest non-tenant role available in enum
      organizationId: targetOrg.id,
      isSynthetic: true,
    },
  });

  // Create membership with viewer role
  await prisma.membership.create({
    data: {
      userId: user.id,
      orgId: targetOrg.id,
      role: 'viewer',
    },
  });

  console.log(`✅ Synthetic user created: ${user.id}`);
  console.log(`   Email: ${SYNTHETIC_EMAIL}`);
  console.log(`   Org: ${targetOrg.name} (${targetOrg.id})`);
  console.log(`   Role: viewer`);
  console.log(`   Password: ${password}`);
  console.log('');
  console.log('⚠️  Save this password securely. It will NOT be shown again.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
