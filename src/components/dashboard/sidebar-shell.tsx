'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    Home,
    Inbox,
    ShieldCheck,
    Settings,
    PanelLeftClose,
    PanelLeftOpen,
} from 'lucide-react';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from '@/components/ui/tooltip';

const STORAGE_KEY = 'sidebar-collapsed';

const WRITE_ROLES = ['owner', 'manager', 'service_operator'];
const ADMIN_ROLES = ['owner', 'service_operator'];

const navItems = [
    { name: 'Dashboard', href: '/dashboard/warehouse', icon: Home, roles: WRITE_ROLES },
    { name: 'Alle Dokumente', href: '/dashboard/warehouse/inbox', icon: Inbox, showBadge: true, roles: WRITE_ROLES },
    { name: 'Protokoll', href: '/dashboard/warehouse/audit', icon: ShieldCheck, roles: WRITE_ROLES },
];

const settingsItem = { name: 'Einstellungen', href: '/dashboard/settings/users', icon: Settings, roles: ADMIN_ROLES };

interface SidebarShellProps {
    reviewCount: number;
    role: string;
    orgs: { orgId: string; orgName: string; role: string }[];
    activeOrgId: string;
    signOutSlot: React.ReactNode;
    signOutCollapsedSlot: React.ReactNode;
}

export function SidebarShell({ reviewCount, role, orgs, activeOrgId, signOutSlot, signOutCollapsedSlot }: SidebarShellProps) {
    const [collapsed, setCollapsed] = useState(true);
    const [mounted, setMounted] = useState(false);
    const pathname = usePathname();

    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== null) {
            setCollapsed(stored === 'true');
        }
        setMounted(true);
    }, []);

    function toggle() {
        const next = !collapsed;
        setCollapsed(next);
        localStorage.setItem(STORAGE_KEY, String(next));
    }

    const visibleNav = navItems.filter((item) => item.roles.includes(role));
    const showSettings = settingsItem.roles.includes(role);

    // Viewer only sees Dashboard
    const filteredNav = role === 'viewer'
        ? visibleNav.filter((item) => item.href === '/dashboard/warehouse')
        : visibleNav;

    return (
        <div
            className={`flex h-full flex-col border-r bg-white transition-[width] duration-200 ${
                collapsed ? 'w-[60px]' : 'w-64'
            }`}
        >
            {/* Logo */}
            <div className={`flex items-center ${collapsed ? 'justify-center px-2' : 'px-4'} h-14 shrink-0`}>
                <Link href="/dashboard/warehouse" className="flex items-center gap-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white font-bold text-sm">
                        P
                    </div>
                    {!collapsed && (
                        <span className="text-lg font-bold text-gray-900">PropManager</span>
                    )}
                </Link>
            </div>

            {/* Toggle */}
            <div className={`flex ${collapsed ? 'justify-center' : 'justify-end px-2'} pb-2 shrink-0`}>
                <button
                    onClick={toggle}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    aria-label={collapsed ? 'Sidebar ausklappen' : 'Sidebar einklappen'}
                >
                    {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </button>
            </div>

            {/* Org switcher - only when expanded */}
            {!collapsed && orgs.length > 1 && (
                <div className="border-b px-2 pb-3 shrink-0">
                    <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />
                </div>
            )}

            {/* Navigation */}
            <nav className="flex-1 space-y-1 px-2 py-3 overflow-y-auto">
                {filteredNav.map((item) => (
                    <NavItem
                        key={item.name}
                        item={item}
                        collapsed={collapsed}
                        mounted={mounted}
                        pathname={pathname}
                        reviewCount={reviewCount}
                        role={role}
                    />
                ))}
            </nav>

            {/* Bottom section */}
            <div className="border-t px-2 py-3 space-y-1 shrink-0">
                {showSettings && (
                    <NavItem
                        item={settingsItem}
                        collapsed={collapsed}
                        mounted={mounted}
                        pathname={pathname}
                        reviewCount={0}
                        role={role}
                    />
                )}

                {/* Sign out */}
                {collapsed && mounted ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div>{signOutCollapsedSlot}</div>
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                            Abmelden
                        </TooltipContent>
                    </Tooltip>
                ) : collapsed ? (
                    <div>{signOutCollapsedSlot}</div>
                ) : (
                    <div>{signOutSlot}</div>
                )}
            </div>
        </div>
    );
}

function NavItem({
    item,
    collapsed,
    mounted,
    pathname,
    reviewCount,
    role,
}: {
    item: { name: string; href: string; icon: React.ComponentType<{ className?: string }>; showBadge?: boolean; roles: string[] };
    collapsed: boolean;
    mounted: boolean;
    pathname: string;
    reviewCount: number;
    role: string;
}) {
    const Icon = item.icon;
    const isActive =
        item.href === '/dashboard/warehouse'
            ? pathname === '/dashboard/warehouse'
            : pathname.startsWith(item.href);

    const linkContent = (
        <Link
            href={item.href}
            className={`relative flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors ${
                isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            } ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        >
            <Icon className="h-5 w-5 shrink-0" />
            {!collapsed && <span>{item.name}</span>}
            {item.showBadge && reviewCount > 0 && role !== 'viewer' && (
                <>
                    {collapsed ? (
                        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
                    ) : (
                        <span className="ml-auto flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-xs font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full">
                                {reviewCount}
                            </span>
                        </span>
                    )}
                </>
            )}
        </Link>
    );

    if (collapsed && mounted) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                    {item.name}
                    {item.showBadge && reviewCount > 0 && ` (${reviewCount})`}
                </TooltipContent>
            </Tooltip>
        );
    }

    return linkContent;
}

