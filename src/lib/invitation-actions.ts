'use server';

import { prisma } from '@/lib/db';
import { getOrgContextAdmin } from '@/lib/org';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// ── Invite a user to the current organization ──────────────

export async function inviteUser(
    email: string,
    role: 'viewer' | 'manager' | 'owner' = 'manager'
): Promise<{ success: boolean; error?: string }> {
    try {
        // Only owner and service_operator can invite
        const ctx = await getOrgContextAdmin();

        // Normalize email
        const emailNorm = email.toLowerCase().trim();

        // Check if already a member
        const existingUser = await prisma.user.findUnique({
            where: { email: emailNorm },
            include: {
                memberships: {
                    where: { orgId: ctx.orgId },
                },
            },
        });
        if (existingUser && existingUser.memberships.length > 0) {
            throw new Error('User is already a member');
        }

        // Expire previous pending invites for this email+org
        await prisma.invitation.updateMany({
            where: {
                emailNorm,
                orgId: ctx.orgId,
                acceptedAt: null,
            },
            data: {
                expiresAt: new Date(), // expire immediately
            },
        });

        // Generate token
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Create invitation (7 day expiry)
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await prisma.invitation.create({
            data: {
                orgId: ctx.orgId,
                email: emailNorm,
                emailNorm,
                role,
                tokenHash,
                invitedBy: ctx.userId,
                expiresAt,
            },
        });

        // Build invite URL
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const inviteUrl = `${appUrl}/invite/${token}`;

        // TODO: Send email via Postmark
        // For now, log the invite URL
        console.log(`[invitation] Invite URL for ${emailNorm}: ${inviteUrl}`);

        return { success: true };
    } catch (error) {
        console.error('Failed to invite user:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ── Validate an invitation token ───────────────────────────

export async function validateInviteToken(token: string): Promise<{
    valid: boolean;
    email?: string;
    orgName?: string;
    error?: string;
}> {
    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const invitation = await prisma.invitation.findUnique({
            where: { tokenHash },
            include: { organization: { select: { name: true } } },
        });

        if (!invitation) {
            return { valid: false, error: 'Invalid invitation' };
        }
        if (invitation.acceptedAt) {
            return { valid: false, error: 'Invitation already used' };
        }
        if (invitation.expiresAt < new Date()) {
            return { valid: false, error: 'Invitation expired' };
        }

        return {
            valid: true,
            email: invitation.email,
            orgName: invitation.organization.name,
        };
    } catch {
        return { valid: false, error: 'Invalid invitation' };
    }
}

// ── Accept invitation and create account ───────────────────

export async function acceptInviteAndSetPassword(
    token: string,
    name: string,
    password: string
): Promise<{ success: boolean; orgId?: string; error?: string }> {
    try {
        const result = await prisma.$transaction(async (tx) => {
            // 1. Hash token
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

            // 2. Find invitation
            const invitation = await tx.invitation.findUnique({
                where: { tokenHash },
            });

            if (!invitation) throw new Error('Invalid or expired invitation');
            if (invitation.acceptedAt) throw new Error('Invitation already used');
            if (invitation.expiresAt < new Date()) throw new Error('Invitation expired');

            // 3. Hash password
            const hashedPassword = await bcrypt.hash(password, 12);

            // 4. Upsert user
            const user = await tx.user.upsert({
                where: { email: invitation.email },
                create: {
                    email: invitation.email,
                    name,
                    hashedPassword,
                },
                update: {
                    name,
                    hashedPassword,
                },
            });

            // 5. Create membership (upsert for idempotency)
            await tx.membership.upsert({
                where: {
                    userId_orgId: {
                        userId: user.id,
                        orgId: invitation.orgId,
                    },
                },
                create: {
                    userId: user.id,
                    orgId: invitation.orgId,
                    role: invitation.role,
                },
                update: {}, // already member = ok
            });

            // 6. Mark invitation accepted
            await tx.invitation.update({
                where: { id: invitation.id },
                data: { acceptedAt: new Date() },
            });

            return { orgId: invitation.orgId };
        });

        return { success: true, orgId: result.orgId };
    } catch (error) {
        console.error('Failed to accept invitation:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
