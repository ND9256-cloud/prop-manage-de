import Link from 'next/link';
import {
    Home,
    Building,
    Users,
    Landmark,
    Inbox,
    ShieldCheck,
    UserCog,
    LogOut
} from 'lucide-react';
import { SignOut } from '@/components/sign-out';
import { getOpenReviewCount } from '@/lib/warehouse-actions';
import { getUserOrgs } from '@/lib/org-actions';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import { getOrgContext } from '@/lib/org';

export default async function SideNav() {
    let reviewCount = 0;
    try {
        reviewCount = await getOpenReviewCount();
    } catch {
        // Fail silently — badge just won't show
    }

    // Fetch orgs for switcher (safe — returns empty if not authenticated)
    const { orgs, activeOrgId } = await getUserOrgs();

    // Get role for nav filtering (fail-safe to viewer)
    const ctx = await getOrgContext().catch(() => null);
    const role = ctx?.role ?? 'viewer';

    return (
        <div className="flex h-full flex-col px-3 py-4 md:px-2">
            <Link
                className="mb-2 flex h-20 items-end justify-start rounded-md bg-blue-600 p-4 md:h-40"
                href="/"
            >
                <div className="w-32 text-white md:w-40">
                    <span className="text-xl font-bold">PropManager</span>
                </div>
            </Link>
            <div className="mb-4 border-b pb-4">
                <OrgSwitcher
                    orgs={orgs}
                    activeOrgId={activeOrgId ?? ''}
                />
            </div>
            <div className="flex grow flex-row justify-between space-x-2 md:flex-col md:space-x-0 md:space-y-2">
                <NavLinks reviewCount={reviewCount} role={role} />
                <div className="hidden h-auto w-full grow rounded-md bg-gray-50 md:block"></div>
                <div className="flex h-[48px] w-full grow items-center justify-center gap-2 rounded-md bg-gray-50 p-3 text-sm font-medium hover:bg-sky-100 hover:text-blue-600 md:flex-none md:justify-start md:p-2 md:px-3">
                    <LogOut className="w-6" />
                    <SignOut />
                </div>
            </div>
        </div>
    );
}

// Role visibility
const WRITE_ROLES = ['owner', 'manager', 'service_operator'];
const ADMIN_ROLES = ['owner', 'service_operator'];

const links = [
    { name: 'Dashboard', href: '/dashboard', icon: Home, roles: WRITE_ROLES },
    {
        name: 'Immobilien',
        href: '/dashboard/properties',
        icon: Building,
        roles: WRITE_ROLES,
    },
    { name: 'Rent Roll', href: '/dashboard/rent-roll', icon: Users, roles: WRITE_ROLES },
    { name: 'Konten', href: '/dashboard/banking', icon: Landmark, roles: WRITE_ROLES },
    { name: 'Inbox', href: '/dashboard/warehouse/inbox', icon: Inbox, showBadge: true, roles: WRITE_ROLES },
    { name: 'Properties', href: '/dashboard/warehouse', icon: Building },
    { name: 'Protokoll', href: '/dashboard/warehouse/audit', icon: ShieldCheck, roles: WRITE_ROLES },
    { name: 'Team', href: '/dashboard/settings/users', icon: UserCog, roles: ADMIN_ROLES },
];

function NavLinks({ reviewCount, role }: { reviewCount: number; role: string }) {
    return (
        <>
            {links
                .filter((link) => !link.roles || link.roles.includes(role))
                .map((link) => {
                    const LinkIcon = link.icon;
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            className="relative flex h-[48px] grow items-center justify-center gap-2 rounded-md bg-gray-50 p-3 text-sm font-medium hover:bg-sky-100 hover:text-blue-600 md:flex-none md:justify-start md:p-2 md:px-3"
                        >
                            <LinkIcon className="w-6" />
                            <p className="hidden md:block">{link.name}</p>
                            {link.showBadge && reviewCount > 0 && (
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 md:relative md:right-auto md:top-auto md:translate-y-0 md:ml-auto">
                                    <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                                    <span className="hidden md:inline text-xs font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full">
                                        {reviewCount}
                                    </span>
                                </span>
                            )}
                        </Link>
                    );
                })}
        </>
    );
}
