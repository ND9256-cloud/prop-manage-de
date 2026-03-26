'use client';

import { useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Activity, ExternalLink, Search } from 'lucide-react';
import { AuditDetailSheet } from '@/components/warehouse/audit-detail-sheet';
import type { AuditEvent } from '@/lib/warehouse-actions';
import Link from 'next/link';

// ─── Event badge colors ───────────────────────────────────────
const EVENT_COLORS: Record<string, string> = {
    uploaded: 'bg-blue-50 text-blue-700 border-blue-200',
    applied: 'bg-green-50 text-green-700 border-green-200',
    quarantined: 'bg-amber-50 text-amber-700 border-amber-200',
    unquarantined: 'bg-gray-50 text-gray-700 border-gray-200',
    downloaded: 'bg-blue-50 text-blue-700 border-blue-200',
};

const EVENT_LABELS: Record<string, string> = {
    uploaded: 'Hochgeladen',
    applied: 'Verbucht',
    quarantined: 'Quarantäne',
    unquarantined: 'Freigegeben',
    downloaded: 'Heruntergeladen',
};

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'gerade eben';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `vor ${mins} Min.`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `vor ${hrs} Std.`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `vor ${days} Tag${days > 1 ? 'en' : ''}`;
    const months = Math.floor(days / 30);
    return `vor ${months} Monat${months > 1 ? 'en' : ''}`;
}

function detailSummary(evt: AuditEvent): string {
    const m = evt.metadata;
    switch (evt.event_type) {
        case 'applied':
            return [m.vendor_name, m.amount ? `${m.amount}` : ''].filter(Boolean).join(' · ') || '—';
        case 'uploaded':
            return (m.file_name as string) ?? '—';
        case 'quarantined':
            return (m.reason as string) ?? '—';
        case 'downloaded':
            return (m.display_name as string) ?? '—';
        default:
            return '—';
    }
}

// ─── Type filter options (property-level only) ────────────────
const TYPE_GROUPS = [
    { value: 'uploaded', label: 'Hochgeladen' },
    { value: 'applied', label: 'Verbucht' },
    { value: 'quarantined', label: 'Quarantäne' },
    { value: 'downloaded', label: 'Heruntergeladen' },
    { value: 'unquarantined', label: 'Freigegeben' },
];

// ─── Props ────────────────────────────────────────────────────
interface PropertyAuditProps {
    events: AuditEvent[];
    total: number;
    page: number;
    propertyId: string;
    actors: { id: string; email: string }[];
    properties: { id: string; name: string; address: string; shortCode: string | null }[];
    currentFilters: {
        types: string[];
        actorId: string;
        range: string;
        q: string;
    };
}

export function PropertyAudit({
    events,
    total,
    page,
    propertyId,
    actors,
    properties,
    currentFilters,
}: PropertyAuditProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
    const [searchInput, setSearchInput] = useState(currentFilters.q);

    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);

    const updateFilter = useCallback(
        (key: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value && value !== 'all') {
                params.set(key, value);
            } else {
                params.delete(key);
            }
            params.set('tab', 'protokoll');
            params.delete('auditPage');
            router.push(`/dashboard/warehouse/${propertyId}?${params.toString()}`);
        },
        [router, searchParams, propertyId],
    );

    const handleSearch = useCallback(() => {
        updateFilter('q', searchInput);
    }, [updateFilter, searchInput]);

    const goToPage = (p: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('auditPage', String(p));
        params.set('tab', 'protokoll');
        router.push(`/dashboard/warehouse/${propertyId}?${params.toString()}`);
    };

    return (
        <>
            <div className="space-y-4">
                {/* ── Filter bar ── */}
                <div className="flex flex-wrap items-center gap-3">
                    {/* Date range */}
                    <Select value={currentFilters.range || '30d'} onValueChange={(v) => updateFilter('auditRange', v)}>
                        <SelectTrigger className="w-[200px] text-sm" aria-label="Zeitraum filtern">
                            <SelectValue placeholder="Zeitraum..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="7d">Letzte 7 Tage</SelectItem>
                            <SelectItem value="30d">Letzte 30 Tage</SelectItem>
                            <SelectItem value="90d">Letzte 90 Tage</SelectItem>
                            <SelectItem value="all">Alles</SelectItem>
                        </SelectContent>
                    </Select>

                    {/* Event type */}
                    <Select
                        value={currentFilters.types.join(',') || 'all'}
                        onValueChange={(v) => updateFilter('auditTypes', v)}
                    >
                        <SelectTrigger className="w-[220px] text-sm" aria-label="Nach Aktion filtern">
                            <SelectValue placeholder="Alle Aktionen..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Alle Aktionen</SelectItem>
                            {TYPE_GROUPS.map((g) => (
                                <SelectItem key={g.value} value={g.value}>
                                    {g.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    {/* Actor */}
                    <Select
                        value={currentFilters.actorId || 'all'}
                        onValueChange={(v) => updateFilter('auditActor', v)}
                    >
                        <SelectTrigger className="w-[220px] text-sm" aria-label="Nach Nutzer filtern">
                            <SelectValue placeholder="Alle Nutzer..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Alle Nutzer</SelectItem>
                            {actors.map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                    {a.email}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    {/* Search */}
                    <div className="flex items-center gap-1">
                        <Input
                            className="w-[200px] text-sm"
                            placeholder="Suchen..."
                            aria-label="Protokoll durchsuchen"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        />
                        <Button variant="ghost" size="sm" onClick={handleSearch} aria-label="Suchen">
                            <Search className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {/* ── Table ── */}
                <div className="border border-border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border bg-muted/50">
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Zeit
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Aktion
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Akteur
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Ziel
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Details
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {events.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="text-center py-16">
                                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                            <Activity className="h-8 w-8" />
                                            <p className="text-sm">Keine Aktivitäten</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                events.map((evt) => (
                                    <tr
                                        key={evt.id}
                                        className="border-b border-border last:border-0 hover:bg-muted cursor-pointer transition-colors"
                                        onClick={() => setSelectedEvent(evt)}
                                    >
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            <TooltipProvider>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="text-sm text-foreground">
                                                            {relativeTime(evt.created_at)}
                                                        </span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        {new Date(evt.created_at).toLocaleString('de-DE')}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Badge
                                                variant="outline"
                                                className={`text-xs ${EVENT_COLORS[evt.event_type] ?? 'bg-gray-50 text-gray-700 border-gray-200'}`}
                                            >
                                                {EVENT_LABELS[evt.event_type] ?? evt.event_type}
                                            </Badge>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-foreground">
                                            {evt.actor_email ?? 'System'}
                                        </td>
                                        <td className="px-4 py-3">
                                            {evt.document_id ? (
                                                <span className="flex items-center gap-1 text-sm text-foreground">
                                                    <span className="truncate max-w-[180px]">
                                                        {(evt.metadata.display_name as string) ??
                                                            (evt.metadata.file_name as string) ??
                                                            evt.document_id.slice(0, 8)}
                                                    </span>
                                                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                                                </span>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-muted-foreground truncate max-w-[200px]">
                                            {detailSummary(evt)}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* ── Pagination ── */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                            Zeige {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} von {total} Einträgen
                        </p>
                        <div className="flex gap-2">
                            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                                Zurück
                            </Button>
                            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                                Weiter
                            </Button>
                        </div>
                    </div>
                )}

                {/* ── Link to full audit log ── */}
                <div className="pt-2">
                    <Link
                        href="/dashboard/warehouse/audit"
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Vollständiges Protokoll exportieren → /dashboard/warehouse/audit
                    </Link>
                </div>
            </div>

            {/* Detail sheet */}
            <AuditDetailSheet
                event={selectedEvent}
                onClose={() => setSelectedEvent(null)}
                properties={properties}
            />
        </>
    );
}
