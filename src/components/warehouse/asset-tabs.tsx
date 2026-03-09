'use client';

import Link from 'next/link';

const TABS = [
    { key: 'dokumente', label: 'Dokumente' },
    { key: 'kosten', label: 'Kosten' },
    { key: 'protokoll', label: 'Protokoll' },
    { key: 'stammdaten', label: 'Stammdaten' },
];

interface AssetTabsProps {
    propertyId: string;
    activeTab: string;
}

export function AssetTabs({ propertyId, activeTab }: AssetTabsProps) {
    return (
        <nav className="flex gap-0 border-b border-border" aria-label="Asset 360 Tabs">
            {TABS.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                    <Link
                        key={tab.key}
                        href={`/dashboard/warehouse/${propertyId}?tab=${tab.key}`}
                        className={`px-4 py-2.5 text-sm font-medium transition-colors -mb-px ${isActive
                                ? 'border-b-2 border-primary text-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                        aria-current={isActive ? 'page' : undefined}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
