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
import { Download, Activity, ExternalLink, Search } from 'lucide-react';
import { AuditDetailSheet } from '@/components/warehouse/audit-detail-sheet';
import type { AuditEvent } from '@/lib/warehouse-actions';
import { getAuditEvents } from '@/lib/warehouse-actions';

// ─── Event badge colors ───────────────────────────────────────
const EVENT_COLORS: Record<string, string> = {
    uploaded: 'bg-blue-50 text-blue-700 border-blue-200',
    applied: 'bg-green-50 text-green-700 border-green-200',
    quarantined: 'bg-amber-50 text-amber-700 border-amber-200',
    unquarantined: 'bg-gray-50 text-gray-700 border-gray-200',
    dismissed: 'bg-gray-50 text-gray-700 border-gray-200',
    downloaded: 'bg-blue-50 text-blue-700 border-blue-200',
    invited: 'bg-blue-50 text-blue-700 border-blue-200',
    role_changed: 'bg-amber-50 text-amber-700 border-amber-200',
    apply_failed: 'bg-red-50 text-red-700 border-red-200',
    processing_failed: 'bg-red-50 text-red-700 border-red-200',
};

const EVENT_LABELS: Record<string, string> = {
    uploaded: 'Hochgeladen',
    applied: 'Verbucht',
    quarantined: 'Aussortiert',
    unquarantined: 'Freigegeben',
    dismissed: 'Verworfen',
    downloaded: 'Heruntergeladen',
    invited: 'Eingeladen',
    role_changed: 'Rolle geändert',
    apply_failed: 'Fehler',
    processing_failed: 'Fehler',
};

// ─── Relative time ────────────────────────────────────────────
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

// ─── Detail summary from metadata ────────────────────────────
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
            return (m.file_name as string) ?? '—';
        case 'invited':
            return (m.invited_email as string) ?? '—';
        case 'role_changed':
            return `${m.old_role ?? '?'} → ${m.new_role ?? '?'}`;
        case 'apply_failed':
        case 'processing_failed':
            return 'Fehler';
        default:
            return '—';
    }
}

// ─── CSV export ───────────────────────────────────────────────
async function exportCsv(filters: {
    types?: string[];
    actorId?: string;
    from?: string;
    to?: string;
    query?: string;
}) {
    const { events } = await getAuditEvents({
        ...filters,
        page: 1,
        pageSize: 10000,
    });

    const header = 'timestamp,event_type,actor_email,document_name,trigger_type,vendor_name,amount,reason,notes';
    const rows = events.map((e) => {
        const m = e.metadata;
        return [
            e.created_at,
            e.event_type,
            e.actor_email ?? 'System',
            (m.file_name as string) ?? '',
            (m.trigger_type as string) ?? '',
            (m.vendor_name as string) ?? '',
            (m.amount as string) ?? '',
            (m.reason as string) ?? '',
            (m.notes as string) ?? '',
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── Type filter options ──────────────────────────────────────
const TYPE_GROUPS = [
    { value: 'uploaded', label: 'Hochgeladen' },
    { value: 'applied', label: 'Verbucht' },
    { value: 'quarantined', label: 'Aussortiert' },
    { value: 'downloaded', label: 'Heruntergeladen' },
    { value: 'apply_failed,processing_failed', label: 'Fehlgeschlagen' },
    { value: 'invited', label: 'Eingeladen' },
    { value: 'role_changed', label: 'Rolle geändert' },
];

// ─── Main component ──────────────────────────────────────────
interface AuditTableProps {
    events: AuditEvent[];
    total: number;
    page: number;
    actors: { id: string; email: string }[];
    properties: { id: string; name: string; address: string; shortCode: string | null }[];
    currentFilters: {
        types: string[];
        actorId: string;
        range: string;
        q: string;
    };
}

export function AuditTable({ events, total, page, actors, properties, currentFilters }: AuditTableProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
    const [exporting, setExporting] = useState(false);
    const [searchInput, setSearchInput] = useState(currentFilters.q);

    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);

    // Update URL params
    const updateFilter = useCallback(
        (key: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value && value !== 'all') {
                params.set(key, value);
            } else {
                params.delete(key);
            }
            params.delete('page'); // Reset to page 1
            router.push(`/dashboard/warehouse/audit?${params.toString()}`);
        },
        [router, searchParams],
    );

    const handleSearch = useCallback(() => {
        updateFilter('q', searchInput);
    }, [updateFilter, searchInput]);

    const handleExport = useCallback(async () => {
        setExporting(true);
        try {
            // Compute from/to based on current range
            let from: string | undefined;
            const now = new Date();
            const range = currentFilters.range;
            if (range === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            else if (range === '7d') from = new Date(now.getTime() - 7 * 86400000).toISOString();
            else if (range === '30d') from = new Date(now.getTime() - 30 * 86400000).toISOString();
            else if (range === '90d') from = new Date(now.getTime() - 90 * 86400000).toISOString();

            await exportCsv({
                types: currentFilters.types.length > 0 ? currentFilters.types : undefined,
                actorId: currentFilters.actorId || undefined,
                from,
                query: currentFilters.q || undefined,
            });
        } finally {
            setExporting(false);
        }
    }, [currentFilters]);

    const goToPage = (p: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('page', String(p));
        router.push(`/dashboard/warehouse/audit?${params.toString()}`);
    };

    return (
        <>
            {/* ── Filter bar ── */}
            <div className="flex flex-wrap items-center gap-3">
                {/* Date range */}
                <Select value={currentFilters.range || 'all'} onValueChange={(v) => updateFilter('range', v)}>
                    <SelectTrigger className="w-[200px] text-sm" aria-label="Zeitraum filtern">
                        <SelectValue placeholder="Zeitraum..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="today">Heute</SelectItem>
                        <SelectItem value="7d">Letzte 7 Tage</SelectItem>
                        <SelectItem value="30d">Letzter Monat</SelectItem>
                        <SelectItem value="90d">Letzte 90 Tage</SelectItem>
                        <SelectItem value="all">Gesamter Zeitraum</SelectItem>
                    </SelectContent>
                </Select>

                {/* Event type */}
                <Select
                    value={currentFilters.types.join(',') || 'all'}
                    onValueChange={(v) => updateFilter('types', v)}
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
                    onValueChange={(v) => updateFilter('actor', v)}
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
                        placeholder="Dokument suchen..."
                        aria-label="Dokument suchen"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    />
                    <Button variant="ghost" size="sm" onClick={handleSearch}>
                        <Search className="h-4 w-4" />
                    </Button>
                </div>

                {/* Spacer + Export */}
                <div className="ml-auto">
                    <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
                        <Download className="h-4 w-4 mr-2" />
                        {exporting ? 'Exportiert...' : 'CSV Export'}
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
                            events.map((evt) => {
                                const propMatch = properties.find((p) => p.id === evt.property_id);
                                return (
                                    <tr
                                        key={evt.id}
                                        className="border-b border-border last:border-0 hover:bg-muted cursor-pointer transition-colors"
                                        onClick={() => setSelectedEvent(evt)}
                                    >
                                        {/* Time */}
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

                                        {/* Action badge */}
                                        <td className="px-4 py-3">
                                            <Badge
                                                variant="outline"
                                                className={`text-xs ${EVENT_COLORS[evt.event_type] ?? 'bg-gray-50 text-gray-700 border-gray-200'}`}
                                            >
                                                {EVENT_LABELS[evt.event_type] ?? evt.event_type}
                                            </Badge>
                                        </td>

                                        {/* Actor */}
                                        <td className="px-4 py-3 text-sm text-foreground">
                                            {evt.actor_email ?? 'System'}
                                        </td>

                                        {/* Target */}
                                        <td className="px-4 py-3">
                                            {evt.document_id ? (
                                                <span className="flex items-center gap-1 text-sm text-foreground">
                                                    <span className="truncate max-w-[180px]">
                                                        {(evt.metadata.file_name as string) ??
                                                            evt.document_id.slice(0, 8)}
                                                    </span>
                                                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                                                </span>
                                            ) : propMatch ? (
                                                <Badge variant="outline" className="text-xs">
                                                    {propMatch.shortCode ?? propMatch.name}
                                                </Badge>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>

                                        {/* Details */}
                                        <td className="px-4 py-3 text-sm text-muted-foreground truncate max-w-[200px]">
                                            {detailSummary(evt)}
                                        </td>
                                    </tr>
                                );
                            })
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
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= totalPages}
                            onClick={() => goToPage(page + 1)}
                        >
                            Weiter
                        </Button>
                    </div>
                </div>
            )}

            {/* ── Detail Sheet ── */}
            <AuditDetailSheet
                event={selectedEvent}
                onClose={() => setSelectedEvent(null)}
                properties={properties}
            />
        </>
    );
}
