'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { switchOrg } from '@/lib/org-actions';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Check, ChevronsUpDown, Building2 } from 'lucide-react';
import { getRoleLabel } from '@/lib/role-labels';

interface OrgOption {
    orgId: string;
    orgName: string;
    role: string;
}

interface OrgSwitcherProps {
    orgs: OrgOption[];
    activeOrgId: string;
}

export function OrgSwitcher({ orgs, activeOrgId }: OrgSwitcherProps) {
    const router = useRouter();
    const [switching, setSwitching] = useState(false);

    const activeOrg = orgs.find((o) => o.orgId === activeOrgId);

    // Single org — show label only, no dropdown
    if (orgs.length <= 1) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-sm">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium truncate">
                    {activeOrg?.orgName ?? 'Organisation'}
                </span>
            </div>
        );
    }

    async function handleSwitch(orgId: string) {
        if (orgId === activeOrgId) return;
        setSwitching(true);
        try {
            await switchOrg(orgId);
            router.refresh();
        } finally {
            setSwitching(false);
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    className="w-full justify-between px-3 h-9 text-sm"
                    disabled={switching}
                >
                    <div className="flex items-center gap-2 truncate">
                        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="truncate font-medium">
                            {activeOrg?.orgName ?? 'Organisation'}
                        </span>
                    </div>
                    <ChevronsUpDown className="h-4 w-4 text-muted-foreground shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="start">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Organisationen
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {orgs.map((org) => (
                    <DropdownMenuItem
                        key={org.orgId}
                        onClick={() => handleSwitch(org.orgId)}
                        className="flex items-center justify-between"
                    >
                        <div className="flex flex-col">
                            <span className="text-sm font-medium">{org.orgName}</span>
                            <span className="text-xs text-muted-foreground">
                                {getRoleLabel(org.role, 'de')}
                            </span>
                        </div>
                        {org.orgId === activeOrgId && (
                            <Check className="h-4 w-4 text-primary" />
                        )}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
