import { getOpenReviewCount } from '@/lib/warehouse-actions';
import { getUserOrgs } from '@/lib/org-actions';
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

    const { orgs, activeOrgId } = await getUserOrgs();

    const ctx = await getOrgContext().catch(() => null);
    const role = ctx?.role ?? 'viewer';

    return (
        <SidebarShell
            reviewCount={reviewCount}
            role={role}
            orgs={orgs}
            activeOrgId={activeOrgId ?? ''}
            signOutSlot={<SignOut variant="sidebar" />}
            signOutCollapsedSlot={<SignOut variant="sidebar" iconOnly />}
        />
    );
}
