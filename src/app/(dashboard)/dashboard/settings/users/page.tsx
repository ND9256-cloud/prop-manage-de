import { redirect } from 'next/navigation';
import { getOrgContextAdmin } from '@/lib/org';
import { getOrgMembers, getOrgPendingInvitations } from '@/lib/user-settings-actions';
import { prisma } from '@/lib/db';
import { TeamClient } from './team-client';

export default async function TeamSettingsPage() {
    const ctx = await getOrgContextAdmin().catch(() => null);
    if (!ctx) redirect('/dashboard/warehouse');

    // Fetch data in parallel
    const [members, invitations, org] = await Promise.all([
        getOrgMembers(),
        getOrgPendingInvitations(),
        prisma.organization.findUnique({
            where: { id: ctx.orgId },
            select: { name: true },
        }),
    ]);

    return (
        <main className="p-6 max-w-4xl">
            <div className="mb-8">
                <h1 className="text-2xl font-bold">Team</h1>
                <p className="text-muted-foreground">{org?.name ?? 'Organisation'}</p>
            </div>

            <TeamClient
                members={members.map((m) => ({
                    ...m,
                    joinedAt: m.joinedAt.toISOString(),
                }))}
                invitations={invitations.map((inv) => ({
                    ...inv,
                    expiresAt: inv.expiresAt.toISOString(),
                    createdAt: inv.createdAt.toISOString(),
                }))}
            />
        </main>
    );
}
