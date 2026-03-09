'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { cookies } from 'next/headers';

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
};

/**
 * Switch the current user's active organization.
 * This is a Next.js server action — CSRF-safe by default.
 * NOT exposed as an API route.
 */
export async function switchOrg(orgId: string): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth();
        const userId = session?.user?.id;
        if (!userId) throw new Error('Unauthorized');

        // Verify user has membership in this org
        const membership = await prisma.membership.findUnique({
            where: { userId_orgId: { userId, orgId } },
            select: { orgId: true, role: true },
        });

        if (!membership) throw new Error('Not a member of this organization');

        // Set cookies
        const cookieStore = await cookies();
        cookieStore.set('x-active-org', membership.orgId, COOKIE_OPTIONS);
        cookieStore.set('x-active-role', membership.role, COOKIE_OPTIONS);

        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Get all organizations the current user belongs to.
 * Used by the org switcher UI.
 */
export async function getUserOrgs(): Promise<{
    orgs: Array<{ orgId: string; orgName: string; role: string }>;
    activeOrgId: string | null;
}> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { orgs: [], activeOrgId: null };

    const memberships = await prisma.membership.findMany({
        where: { userId },
        include: { organization: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
    });

    const cookieStore = await cookies();
    const activeOrgId = cookieStore.get('x-active-org')?.value ?? null;

    return {
        orgs: memberships.map((m) => ({
            orgId: m.orgId,
            orgName: m.organization.name,
            role: m.role,
        })),
        activeOrgId,
    };
}
