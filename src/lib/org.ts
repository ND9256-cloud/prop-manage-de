'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { cookies } from 'next/headers';

export interface OrgContext {
    userId: string;
    orgId: string;
    userEmail: string;
    role: string;
}

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
};

/**
 * Returns the current user's organization ID from their active org cookie / membership.
 * Falls back to first membership if cookie is missing or invalid.
 * Auto-sets the cookie on fallback.
 * Returns null if no session or no membership.
 */
export async function getOrgId(): Promise<string | null> {
    try {
        const session = await auth();
        const userId = session?.user?.id;
        if (!userId) return null;

        const cookieStore = await cookies();
        const activeOrgId = cookieStore.get('x-active-org')?.value;

        // Try cookie value first
        if (activeOrgId) {
            const membership = await prisma.membership.findUnique({
                where: { userId_orgId: { userId, orgId: activeOrgId } },
                select: { orgId: true, role: true },
            });
            if (membership) {
                return membership.orgId;
            }
            // Cookie is stale/invalid — fall through to fallback
        }

        // Fallback: first membership by createdAt ASC
        const firstMembership = await prisma.membership.findFirst({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            select: { orgId: true, role: true },
        });

        if (!firstMembership) return null;

        // Auto-set cookie on fallback
        cookieStore.set('x-active-org', firstMembership.orgId, COOKIE_OPTIONS);
        cookieStore.set('x-active-role', firstMembership.role, COOKIE_OPTIONS);

        return firstMembership.orgId;
    } catch {
        return null;
    }
}

/**
 * Returns the current user's organization ID.
 * Throws if no session or no membership — use in server actions that require auth.
 */
export async function getOrgIdOrThrow(): Promise<string> {
    const orgId = await getOrgId();
    if (!orgId) throw new Error('Unauthorized');
    return orgId;
}

/**
 * Returns org ID and throws if user is a viewer (read-only).
 * Drop-in replacement for getOrgId() in mutating server actions.
 */
export async function getOrgIdWritable(): Promise<string> {
    const ctx = await getOrgContext();
    if (ctx.role === 'viewer') throw new Error('Forbidden');
    return ctx.orgId;
}

/**
 * Returns full context for org-scoped operations.
 * Falls back to first membership if cookie is missing/invalid.
 * Auto-sets cookies on fallback. Throws if no session or no membership.
 */
export async function getOrgContext(): Promise<OrgContext> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error('Unauthorized');

    const cookieStore = await cookies();
    const activeOrgId = cookieStore.get('x-active-org')?.value;

    let membership: { orgId: string; role: string } | null = null;

    // Try cookie value first
    if (activeOrgId) {
        membership = await prisma.membership.findUnique({
            where: { userId_orgId: { userId, orgId: activeOrgId } },
            select: { orgId: true, role: true },
        });
    }

    // Fallback: first membership by createdAt ASC
    if (!membership) {
        membership = await prisma.membership.findFirst({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            select: { orgId: true, role: true },
        });

        if (membership) {
            // Auto-set cookies on fallback
            cookieStore.set('x-active-org', membership.orgId, COOKIE_OPTIONS);
            cookieStore.set('x-active-role', membership.role, COOKIE_OPTIONS);
        }
    }

    if (!membership) throw new Error('Unauthorized');

    // Update last_seen_at (fire-and-forget, throttled to once per 5 min)
    prisma.$executeRaw`
        UPDATE memberships SET last_seen_at = now()
        WHERE "userId" = ${userId}::uuid AND "orgId" = ${membership.orgId}::uuid
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')
    `.catch(() => {});

    return {
        userId,
        orgId: membership.orgId,
        userEmail: session.user.email ?? '',
        role: membership.role,
    };
}

/**
 * Returns OrgContext and throws if role is 'viewer'.
 * Use in all mutating server actions (upload, triage, apply, manage users).
 */
export async function getOrgContextWritable(): Promise<OrgContext> {
    const ctx = await getOrgContext();
    if (ctx.role === 'viewer') throw new Error('Forbidden');
    return ctx;
}

/**
 * Returns OrgContext and throws if role is not 'owner' or 'service_operator'.
 * Use in admin-only actions (invite users, change roles, delete org).
 */
export async function getOrgContextAdmin(): Promise<OrgContext> {
    const ctx = await getOrgContext();
    if (ctx.role !== 'owner' && ctx.role !== 'service_operator') {
        throw new Error('Forbidden');
    }
    return ctx;
}
