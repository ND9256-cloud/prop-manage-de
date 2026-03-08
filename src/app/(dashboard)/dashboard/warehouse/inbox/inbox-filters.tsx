'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { X } from 'lucide-react';
import { bilingual, t } from '@/lib/i18n/warehouse';

interface Property {
    id: string;
    name: string;
    shortCode: string | null;
}

interface InboxFiltersProps {
    properties: Property[];
}

export function InboxFilters({ properties }: InboxFiltersProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const updateParam = useCallback(
        (key: string, value: string | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value && value !== 'all') {
                params.set(key, value);
            } else {
                params.delete(key);
            }
            // Reset to page 1 on filter change
            params.delete('page');
            router.push(`?${params.toString()}`);
        },
        [router, searchParams]
    );

    const clearFilters = useCallback(() => {
        router.push('?');
    }, [router]);

    const hasFilters =
        searchParams.has('status') ||
        searchParams.has('property') ||
        searchParams.has('docType') ||
        searchParams.has('source') ||
        searchParams.has('dateRange') ||
        searchParams.has('search');

    return (
        <div className="flex flex-wrap items-center gap-3">
            {/* Search */}
            <Input
                placeholder={bilingual('search')}
                defaultValue={searchParams.get('search') ?? ''}
                className="w-56"
                onChange={(e) => {
                    // Debounce would be nice but keep it simple — update on blur or enter
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        updateParam('search', (e.target as HTMLInputElement).value || null);
                    }
                }}
                onBlur={(e) => {
                    updateParam('search', e.target.value || null);
                }}
            />

            {/* Status */}
            <Select
                value={searchParams.get('status') ?? 'all'}
                onValueChange={(v) => updateParam('status', v)}
            >
                <SelectTrigger className="w-44">
                    <SelectValue placeholder={bilingual('allStatuses')} />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{bilingual('allStatuses')}</SelectItem>
                    <SelectItem value="queued">{t.queued.de}</SelectItem>
                    <SelectItem value="processing">{t.processing.de}</SelectItem>
                    <SelectItem value="needs_review">{t.needsReview.de}</SelectItem>
                    <SelectItem value="applied">{t.applied.de}</SelectItem>
                    <SelectItem value="failed">{t.failed.de}</SelectItem>
                    <SelectItem value="quarantined">{t.quarantined.de}</SelectItem>
                </SelectContent>
            </Select>

            {/* Property */}
            <Select
                value={searchParams.get('property') ?? 'all'}
                onValueChange={(v) => updateParam('property', v)}
            >
                <SelectTrigger className="w-44">
                    <SelectValue placeholder={bilingual('allProperties')} />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{bilingual('allProperties')}</SelectItem>
                    {properties.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                            {p.shortCode ? `[${p.shortCode}] ` : ''}{p.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* Doc Type */}
            <Select
                value={searchParams.get('docType') ?? 'all'}
                onValueChange={(v) => updateParam('docType', v)}
            >
                <SelectTrigger className="w-36">
                    <SelectValue placeholder={bilingual('allTypes')} />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{bilingual('allTypes')}</SelectItem>
                    <SelectItem value="invoice">Rechnung / Invoice</SelectItem>
                    <SelectItem value="lease">Mietvertrag / Lease</SelectItem>
                    <SelectItem value="inspection">Inspektion / Inspection</SelectItem>
                    <SelectItem value="other">Sonstige / Other</SelectItem>
                </SelectContent>
            </Select>

            {/* Source */}
            <Select
                value={searchParams.get('source') ?? 'all'}
                onValueChange={(v) => updateParam('source', v)}
            >
                <SelectTrigger className="w-36">
                    <SelectValue placeholder={bilingual('allSources')} />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{bilingual('allSources')}</SelectItem>
                    <SelectItem value="email">E-Mail</SelectItem>
                    <SelectItem value="telegram">Telegram</SelectItem>
                    <SelectItem value="ui">Web Upload</SelectItem>
                </SelectContent>
            </Select>

            {/* Date Range */}
            <Select
                value={searchParams.get('dateRange') ?? 'all'}
                onValueChange={(v) => updateParam('dateRange', v)}
            >
                <SelectTrigger className="w-44">
                    <SelectValue placeholder={bilingual('allTime')} />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">{bilingual('allTime')}</SelectItem>
                    <SelectItem value="this_week">{bilingual('thisWeek')}</SelectItem>
                    <SelectItem value="this_month">{bilingual('thisMonth')}</SelectItem>
                    <SelectItem value="last_3_months">{bilingual('last3Months')}</SelectItem>
                </SelectContent>
            </Select>

            {/* Clear filters */}
            {hasFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1.5 text-muted-foreground">
                    <X className="h-3.5 w-3.5" />
                    {bilingual('clearFilters')}
                </Button>
            )}
        </div>
    );
}
