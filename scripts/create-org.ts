/**
 * Create Customer Org — Operator-only script
 * Creates a new org, adds operator as service_operator, generates viewer invite link.
 *
 * Run: npx tsx -r dotenv/config scripts/create-org.ts --name "Kunde A GmbH" --slug "kunde-a" --invite "owner@kunde-a.de"
 */
import crypto, { timingSafeEqual } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

// ── Audit logging (non-fatal) ──────────────────────────────

async function logAudit(orgId: string, eventType: string, actorUserId: string, actorEmail: string, metadata: Record<string, unknown>) {
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO shared.audit_log (org_id, action, actor_user_id, actor_email, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            orgId,
            eventType,
            actorUserId,
            actorEmail,
            JSON.stringify(metadata),
        );
    } catch (err) {
        console.warn('⚠️  Audit log write failed (non-fatal):', err instanceof Error ? err.message : err);
    }
}

// ── Main ───────────────────────────────────────────────────

async function createOrg(name: string, slug: string, inviteEmail: string) {
    const operatorEmail = process.env.OPERATOR_EMAIL;
    if (!operatorEmail) {
        console.error('❌ OPERATOR_EMAIL env var not set. Aborting.');
        process.exit(1);
    }

    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // ── Step 1: Validate slug format ───────────────────────
    const SLUG_REGEX = /^[a-z0-9-]+$/;
    if (!SLUG_REGEX.test(slug)) {
        console.error(`❌ Invalid slug "${slug}". Must match /^[a-z0-9-]+$/ (lowercase letters, numbers, hyphens only).`);
        process.exit(1);
    }

    // ── Step 2: Check slug not taken ───────────────────────
    const existing = await prisma.organization.findFirst({ where: { slug } });
    if (existing) {
        console.error(`❌ Slug "${slug}" already taken (org: ${existing.id}).`);
        process.exit(1);
    }

    // ── Step 3: Find operator user ─────────────────────────
    const operator = await prisma.user.findUnique({
        where: { email: operatorEmail },
        select: { id: true, email: true },
    });
    if (!operator) {
        console.error(`❌ Operator user not found: ${operatorEmail}`);
        process.exit(1);
    }

    console.log(`👤 Operator: ${operator.email} (${operator.id})`);
    console.log(`🏢 Creating org: "${name}" (slug: ${slug})`);
    console.log(`📧 Invite to: ${inviteEmail} (role: viewer)\n`);

    // ── Step 4: Create org ─────────────────────────────────
    const org = await prisma.organization.create({
        data: { name, slug },
    });
    console.log(`✅ Org created: ${org.id}`);

    // ── Step 5: Add operator as service_operator ───────────
    await prisma.membership.create({
        data: {
            userId: operator.id,
            orgId: org.id,
            role: 'service_operator',
        },
    });
    console.log('✅ You added as service_operator');

    // ── Step 6: Generate invitation for customer ───────────

    // Idempotency: check for existing pending invite
    const existingInvite = await prisma.invitation.findFirst({
        where: {
            emailNorm: inviteEmail.toLowerCase().trim(),
            orgId: org.id,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
        },
    });

    if (existingInvite) {
        console.log('⚠️  Pending invite already exists for', inviteEmail);
        console.log('   Expires:', existingInvite.expiresAt.toISOString());
        console.log('   Use --force to replace it');
        if (!args.includes('--force')) {
            process.exit(0);
        }
        // If --force: expire existing invite
        await prisma.invitation.update({
            where: { id: existingInvite.id },
            data: { expiresAt: new Date(Date.now() - 1000) },
        });
        console.log('   Previous invite expired.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.invitation.create({
        data: {
            orgId: org.id,
            email: inviteEmail,
            emailNorm: inviteEmail.toLowerCase().trim(),
            role: 'viewer',
            tokenHash,
            invitedBy: operator.id,
            expiresAt,
        },
    });

    // ── Step 7: Print results ──────────────────────────────
    if (args.includes('--print-link')) {
        console.log('🔗 Invite link:');
        console.log(`   ${appUrl}/invite/${token}`);
    } else {
        console.log('✅ Invite created for:', inviteEmail);
        console.log('   Expires:', expiresAt.toISOString());
        console.log('   Re-run with --print-link to get the invite URL');
    }

    // ── Step 8: Audit log ──────────────────────────────────
    await logAudit(org.id, 'service_operator_access_granted', operator.id, operator.email, {
        org_name: name,
        org_slug: slug,
        invited_email: inviteEmail,
    });

    console.log('📋 Audit logged: service_operator_access_granted');
}

// ── CLI entry ──────────────────────────────────────────────

const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const slugIdx = args.indexOf('--slug');
const inviteIdx = args.indexOf('--invite');

const name = nameIdx > -1 ? args[nameIdx + 1]?.trim() : null;
const slug = slugIdx > -1 ? args[slugIdx + 1]?.trim() : null;
const inviteEmail = inviteIdx > -1 ? args[inviteIdx + 1]?.trim() : null;

if (!name || !slug || !inviteEmail) {
    console.error(
        'Usage: npx tsx -r dotenv/config scripts/create-org.ts'
        + ' --secret $OPERATOR_SECRET'
        + ' --name "Kunde A GmbH"'
        + ' --slug "kunde-a"'
        + ' --invite "owner@kunde-a.de"',
    );
    process.exit(1);
}

// ── Secret arg + constant-time verify ──────────────────────
const secretIdx = args.indexOf('--secret');
const providedSecret = secretIdx > -1 ? args[secretIdx + 1]?.trim() : null;

if (!providedSecret) {
    console.error('❌ --secret <value> required');
    process.exit(1);
}

function verifySecret(provided: string): boolean {
    const expected = process.env.OPERATOR_SECRET;
    if (!expected) return false;
    try {
        return timingSafeEqual(
            Buffer.from(provided),
            Buffer.from(expected),
        );
    } catch {
        return false;
    }
}

if (!verifySecret(providedSecret)) {
    console.error('❌ Invalid secret');
    process.exit(1);
}

// Secret checks
if (!process.env.IMPORT_SECRET) {
    console.error('❌ IMPORT_SECRET env var not set. Aborting.');
    process.exit(1);
}
if (!process.env.OPERATOR_SECRET) {
    console.error('❌ OPERATOR_SECRET env var not set. Aborting.');
    process.exit(1);
}
// (--secret value already verified above via constant-time compare)

// Email format validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!EMAIL_REGEX.test(inviteEmail)) {
    console.error(`❌ Invalid --invite email: "${inviteEmail}"`);
    process.exit(1);
}

createOrg(name, slug, inviteEmail)
    .then(() => {
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Failed:', err.message);
        process.exit(1);
    })
    .finally(async () => {
        await pool.end();
    });
