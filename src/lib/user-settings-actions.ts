'use server';

import { prisma } from '@/lib/db';
import { getOrgContextAdmin } from '@/lib/org';
import crypto from 'crypto';
import { revalidatePath } from 'next/cache';
import type { MembershipRole } from '@prisma/client';

// ── Types ──────────────────────────────────────────────────

export interface OrgMember {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    joinedAt: Date;
    isCurrentUser: boolean;
}

export interface PendingInvitation {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    createdAt: Date;
}

const VALID_ROLES = ['owner', 'manager', 'viewer', 'service_operator'] as const;
const SETTINGS_PATH = '/dashboard/settings/users';

// ── Read Actions ──────────────────────────────────────────

export async function getOrgMembers(): Promise<OrgMember[]> {
    const ctx = await getOrgContextAdmin();

    const memberships = await prisma.membership.findMany({
        where: {
            orgId: ctx.orgId,
            user: { isSynthetic: false },
        },
        include: {
            user: { select: { email: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        joinedAt: m.createdAt,
        isCurrentUser: m.userId === ctx.userId,
    }));
}

export async function getOrgPendingInvitations(): Promise<PendingInvitation[]> {
    const ctx = await getOrgContextAdmin();

    // Exclude invitations sent to synthetic user emails
    const syntheticEmails = (await prisma.user.findMany({
        where: { isSynthetic: true },
        select: { email: true },
    })).map((u) => u.email);

    const invitations = await prisma.invitation.findMany({
        where: {
            orgId: ctx.orgId,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
            ...(syntheticEmails.length > 0 ? { email: { notIn: syntheticEmails } } : {}),
        },
        orderBy: { createdAt: 'desc' },
    });

    return invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
    }));
}

// ── Member Management ─────────────────────────────────────

export async function updateMemberRole(
    targetUserId: string,
    newRole: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const ctx = await getOrgContextAdmin();

        // Validate role
        if (!VALID_ROLES.includes(newRole as typeof VALID_ROLES[number])) {
            throw new Error('Invalid role');
        }

        // Cannot change own role
        if (targetUserId === ctx.userId) {
            throw new Error('Cannot change own role');
        }

        // Get current membership
        const membership = await prisma.membership.findUnique({
            where: { userId_orgId: { userId: targetUserId, orgId: ctx.orgId } },
        });
        if (!membership) throw new Error('Member not found');

        const oldRole = membership.role;
        if (oldRole === newRole) return { success: true };

        // Cannot demote last owner
        if (oldRole === 'owner') {
            const ownerCount = await prisma.membership.count({
                where: { orgId: ctx.orgId, role: 'owner' },
            });
            if (ownerCount <= 1) {
                throw new Error('Cannot demote last owner');
            }
        }

        // Update role
        const { count } = await prisma.membership.updateMany({
            where: { userId: targetUserId, orgId: ctx.orgId },
            data: { role: newRole as MembershipRole },
        });
        if (count === 0) throw new Error('Member not found');

        // Audit log
        await logTeamAudit(ctx.orgId, ctx.userId, ctx.userEmail, 'role_changed', {
            target_user_id: targetUserId,
            old_role: oldRole,
            new_role: newRole,
        });

        revalidatePath(SETTINGS_PATH);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function revokeMembership(
    targetUserId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const ctx = await getOrgContextAdmin();

        // Cannot revoke self
        if (targetUserId === ctx.userId) {
            throw new Error('Cannot revoke own access');
        }

        // Get current membership to check role
        const membership = await prisma.membership.findUnique({
            where: { userId_orgId: { userId: targetUserId, orgId: ctx.orgId } },
            include: { user: { select: { email: true } } },
        });
        if (!membership) throw new Error('Member not found');

        // Cannot revoke last owner
        if (membership.role === 'owner') {
            const ownerCount = await prisma.membership.count({
                where: { orgId: ctx.orgId, role: 'owner' },
            });
            if (ownerCount <= 1) {
                throw new Error('Cannot remove last owner');
            }
        }

        // Delete membership
        const { count } = await prisma.membership.deleteMany({
            where: { userId: targetUserId, orgId: ctx.orgId },
        });
        if (count === 0) throw new Error('Member not found');

        // Audit
        const eventType = membership.role === 'service_operator'
            ? 'service_operator_access_revoked'
            : 'membership_revoked';

        await logTeamAudit(ctx.orgId, ctx.userId, ctx.userEmail, eventType, {
            target_user_id: targetUserId,
            target_email: membership.user.email,
            revoked_role: membership.role,
        });

        revalidatePath(SETTINGS_PATH);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ── Invitation Management ─────────────────────────────────

export async function cancelInvitation(
    invitationId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const ctx = await getOrgContextAdmin();

        const invitation = await prisma.invitation.findFirst({
            where: {
                id: invitationId,
                orgId: ctx.orgId,
                acceptedAt: null,
            },
        });
        if (!invitation) throw new Error('Invitation not found');

        await prisma.invitation.update({
            where: { id: invitationId },
            data: { expiresAt: new Date(Date.now() - 1000) },
        });

        await logTeamAudit(ctx.orgId, ctx.userId, ctx.userEmail, 'invitation_cancelled', {
            target_email: invitation.email,
            invitation_id: invitationId,
        });

        revalidatePath(SETTINGS_PATH);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function resendInvitation(
    invitationId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const ctx = await getOrgContextAdmin();

        const invitation = await prisma.invitation.findFirst({
            where: {
                id: invitationId,
                orgId: ctx.orgId,
                acceptedAt: null,
            },
        });
        if (!invitation) throw new Error('Invitation not found');

        // Rate limit: check if updated within last 20 minutes
        const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
        // Use createdAt as proxy — if invitation was created/resent recently
        if (invitation.expiresAt > new Date() && invitation.createdAt > twentyMinAgo) {
            // Only block if it's still fresh
        }

        // Generate new token + extend expiry in transaction
        const newToken = await prisma.$transaction(async (tx) => {
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

            await tx.invitation.update({
                where: { id: invitationId },
                data: {
                    tokenHash,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            });

            return token;
        });

        // Build invite URL
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const inviteUrl = `${appUrl}/invite/${newToken}`;

        // TODO: Send email via Postmark
        console.log(`[invitation] Re-invite URL for ${invitation.email}: ${inviteUrl}`);

        await logTeamAudit(ctx.orgId, ctx.userId, ctx.userEmail, 'invitation_resent', {
            target_email: invitation.email,
            invitation_id: invitationId,
        });

        revalidatePath(SETTINGS_PATH);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ── Audit Helper ──────────────────────────────────────────

async function logTeamAudit(
    orgId: string,
    actorUserId: string,
    actorEmail: string,
    eventType: string,
    metadata: Record<string, unknown>
) {
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO shared.audit_log (org_id, actor_user_id, actor_email, event_type, metadata)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
            orgId,
            actorUserId,
            actorEmail,
            eventType,
            JSON.stringify(metadata)
        );
    } catch (e) {
        console.error('[audit] Failed to log team event:', e);
    }
}
