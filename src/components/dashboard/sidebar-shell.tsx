'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    Home,
    Inbox,
    ShieldCheck,
    Settings,
    PanelLeftClose,
    PanelLeftOpen,
    LogOut,
} from 'lucide-react';
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

interface UserInfo {
    name: string;
    email: string;
    lastSeenAt: string | null;
}

interface SidebarShellProps {
    reviewCount: number;
    role: string;
    userInfo: UserInfo;
    signOutSlot: React.ReactNode;
}

export function SidebarShell({ reviewCount, role, userInfo, signOutSlot }: SidebarShellProps) {
    const [collapsed, setCollapsed] = useState(true);
    const [mounted, setMounted] = useState(false);
    const [flyoutOpen, setFlyoutOpen] = useState(false);
    const flyoutRef = useRef<HTMLDivElement>(null);
    const gearRef = useRef<HTMLButtonElement>(null);
    const pathname = usePathname();

    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== null) {
            setCollapsed(stored === 'true');
        }
        setMounted(true);
    }, []);

    // Close flyout on outside click
    useEffect(() => {
        if (!flyoutOpen) return;
        function handleClick(e: MouseEvent) {
            if (
                flyoutRef.current && !flyoutRef.current.contains(e.target as Node) &&
                gearRef.current && !gearRef.current.contains(e.target as Node)
            ) {
                setFlyoutOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [flyoutOpen]);

    function toggle() {
        const next = !collapsed;
        setCollapsed(next);
        localStorage.setItem(STORAGE_KEY, String(next));
    }

    const visibleNav = navItems.filter((item) => item.roles.includes(role));

    // Viewer only sees Dashboard
    const filteredNav = role === 'viewer'
        ? visibleNav.filter((item) => item.href === '/dashboard/warehouse')
        : visibleNav;

    const isAdmin = ADMIN_ROLES.includes(role);

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

            {/* Bottom section — Settings gear */}
            <div className="border-t px-2 py-3 shrink-0 relative">
                {collapsed && mounted ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                ref={gearRef}
                                onClick={() => setFlyoutOpen((v) => !v)}
                                className={`flex items-center justify-center rounded-md py-2 w-full text-sm font-medium transition-colors ${
                                    flyoutOpen
                                        ? 'bg-blue-50 text-blue-700'
                                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                                }`}
                                aria-label="Einstellungen"
                            >
                                <Settings className="h-5 w-5 shrink-0" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                            Einstellungen
                        </TooltipContent>
                    </Tooltip>
                ) : collapsed ? (
                    <button
                        ref={gearRef}
                        onClick={() => setFlyoutOpen((v) => !v)}
                        className="flex items-center justify-center rounded-md py-2 w-full text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        aria-label="Einstellungen"
                    >
                        <Settings className="h-5 w-5 shrink-0" />
                    </button>
                ) : (
                    <button
                        ref={gearRef}
                        onClick={() => setFlyoutOpen((v) => !v)}
                        className={`flex items-center gap-3 rounded-md py-2 px-3 w-full text-sm font-medium transition-colors ${
                            flyoutOpen
                                ? 'bg-blue-50 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                        }`}
                    >
                        <Settings className="h-5 w-5 shrink-0" />
                        <span>Einstellungen</span>
                    </button>
                )}

                {/* Settings flyout */}
                {flyoutOpen && (
                    <div
                        ref={flyoutRef}
                        className="absolute bottom-0 left-full ml-2 w-72 bg-white rounded-lg border shadow-lg z-50 p-4 space-y-3"
                    >
                        {/* User info */}
                        <div className="space-y-0.5">
                            <p className="text-sm font-medium text-foreground truncate">
                                {userInfo.name || userInfo.email}
                            </p>
                            {userInfo.name && (
                                <p className="text-xs text-muted-foreground truncate">
                                    {userInfo.email}
                                </p>
                            )}
                        </div>

                        {/* Last login */}
                        {userInfo.lastSeenAt && (
                            <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                Letzter Login: {new Date(userInfo.lastSeenAt).toLocaleDateString('de-DE', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </p>
                        )}

                        <div className="border-t pt-2 space-y-1">
                            {/* Team verwalten link (admin only) */}
                            {isAdmin && (
                                <Link
                                    href="/dashboard/settings/users"
                                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-gray-100 transition-colors text-gray-700"
                                    onClick={() => setFlyoutOpen(false)}
                                >
                                    Team verwalten
                                </Link>
                            )}

                            {/* Sign out */}
                            <div className="flex items-center gap-2 text-sm text-red-600">
                                {signOutSlot}
                            </div>
                        </div>
                    </div>
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
