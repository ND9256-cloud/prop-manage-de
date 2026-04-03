import { getOpenReviewCount } from '@/lib/warehouse-actions';
import { getOrgContext } from '@/lib/org';
import { SignOut } from '@/components/sign-out';
import { SidebarShell } from '@/components/dashboard/sidebar-shell';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export default async function SideNav() {
    let reviewCount = 0;
    try {
        reviewCount = await getOpenReviewCount();
    } catch {
        // Fail silently — badge just won't show
    }

    const ctx = await getOrgContext().catch(() => null);
    const role = ctx?.role ?? 'viewer';

    // Fetch user info for settings flyout
    const session = await auth();
    let lastSeenAt: string | null = null;
    if (ctx) {
        const membership = await prisma.membership.findUnique({
            where: { userId_orgId: { userId: ctx.userId, orgId: ctx.orgId } },
            select: { lastSeenAt: true },
        }).catch(() => null);
        lastSeenAt = membership?.lastSeenAt?.toISOString() ?? null;
    }

    const userInfo = {
        name: session?.user?.name ?? '',
        email: session?.user?.email ?? ctx?.userEmail ?? '',
        lastSeenAt,
    };

    return (
        <SidebarShell
            reviewCount={reviewCount}
            role={role}
            userInfo={userInfo}
            signOutSlot={<SignOut variant="sidebar" />}
        />
    );
}
