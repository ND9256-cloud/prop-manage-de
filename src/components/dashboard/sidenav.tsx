import Link from 'next/link';
import {
    Home,
    Building,
    Users,
    Landmark,
    Inbox,
    ShieldCheck,
    LogOut
} from 'lucide-react';
import { SignOut } from '@/components/sign-out';
import { getOpenReviewCount } from '@/lib/warehouse-actions';

export default async function SideNav() {
    let reviewCount = 0;
    try {
        reviewCount = await getOpenReviewCount();
    } catch {
        // Fail silently — badge just won't show
    }

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
            <div className="flex grow flex-row justify-between space-x-2 md:flex-col md:space-x-0 md:space-y-2">
                <NavLinks reviewCount={reviewCount} />
                <div className="hidden h-auto w-full grow rounded-md bg-gray-50 md:block"></div>
                <div className="flex h-[48px] w-full grow items-center justify-center gap-2 rounded-md bg-gray-50 p-3 text-sm font-medium hover:bg-sky-100 hover:text-blue-600 md:flex-none md:justify-start md:p-2 md:px-3">
                    <LogOut className="w-6" />
                    <SignOut />
                </div>
            </div>
        </div>
    );
}

const links = [
    { name: 'Dashboard', href: '/dashboard', icon: Home },
    {
        name: 'Immobilien',
        href: '/dashboard/properties',
        icon: Building,
    },
    { name: 'Rent Roll', href: '/dashboard/rent-roll', icon: Users },
    { name: 'Konten', href: '/dashboard/banking', icon: Landmark },
    { name: 'Inbox', href: '/dashboard/warehouse/inbox', icon: Inbox, showBadge: true },
    { name: 'Properties', href: '/dashboard/warehouse', icon: Building },
    { name: 'Protokoll', href: '/dashboard/warehouse/audit', icon: ShieldCheck },
];

function NavLinks({ reviewCount }: { reviewCount: number }) {
    return (
        <>
            {links.map((link) => {
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
