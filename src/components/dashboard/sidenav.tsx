import { getOpenReviewCount } from '@/lib/warehouse-actions';
import { getOrgContext } from '@/lib/org';
import { SignOut } from '@/components/sign-out';
import { SidebarShell } from '@/components/dashboard/sidebar-shell';

export default async function SideNav() {
    let reviewCount = 0;
    try {
        reviewCount = await getOpenReviewCount();
    } catch {
        // Fail silently — badge just won't show
    }

    const ctx = await getOrgContext().catch(() => null);
    const role = ctx?.role ?? 'viewer';

    return (
        <SidebarShell
            reviewCount={reviewCount}
            role={role}
            signOutSlot={<SignOut variant="sidebar" />}
            signOutCollapsedSlot={<SignOut variant="sidebar" iconOnly />}
        />
    );
}
