'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
import { Download, Receipt, Info } from 'lucide-react';
import { TriageOverlay } from '@/components/warehouse/triage-overlay';
import type { CostRow, CostKpis } from '@/lib/warehouse-actions';

// ─── Constants ────────────────────────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
    kosten_rechnungen: 'Rechnungen',
    vertraege: 'Verträge',
    finanzen: 'Finanzen',
    versicherungen: 'Versicherungen',
    steuern: 'Steuern',
    kommunikation: 'Kommunikation',
    sonstiges: 'Sonstiges',
};

function fmtEur(n: number): string {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtDateDE(iso: string): string {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return new Date(iso).toLocaleDateString('de-DE');
}

// ─── Props ────────────────────────────────────────────────────
interface PropertyCostsProps {
    propertyId: string;
    year: number;
    kpis: CostKpis;
    rows: CostRow[];
    total: number;
    currentFilters: {
        category: string;
        vendor: string;
    };
    readOnly?: boolean;
}

export function PropertyCosts({
    propertyId,
    year,
    kpis,
    rows,
    total,
    currentFilters,
    readOnly,
}: PropertyCostsProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [vendorInput, setVendorInput] = useState(currentFilters.vendor);
    const [page, setPage] = useState(1);
    const pageSize = 25;

    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear - 1, currentYear - 2];

    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.ceil(total / pageSize);

    const updateFilter = useCallback(
        (key: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value && value !== 'all' && value !== '') {
                params.set(key, value);
            } else {
                params.delete(key);
            }
            params.set('tab', 'kosten');
            router.push(`/dashboard/warehouse/${propertyId}?${params.toString()}`);
        },
        [router, searchParams, propertyId],
    );

    // Debounced vendor search
    useEffect(() => {
        const timer = setTimeout(() => {
            if (vendorInput !== currentFilters.vendor) {
                updateFilter('vendor', vendorInput);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [vendorInput, currentFilters.vendor, updateFilter]);

    // CSV export
    const handleExport = useCallback(() => {
        const header = 'datum,anbieter,betrag,kategorie,dokument,applied_at';
        const csvRows = rows.map((r) =>
            [
                r.displayDate,
                r.vendorName ?? 'Unbekannt',
                r.amount != null ? String(r.amount) : '',
                CATEGORY_LABELS[r.category ?? ''] ?? r.category ?? '',
                r.displayName,
                r.appliedAt ?? '',
            ]
                .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                .join(','),
        );
        const csv = [header, ...csvRows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kosten-${propertyId.slice(0, 8)}-${year}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }, [rows, propertyId, year]);

    return (
        <>
            <div className="space-y-6">
                {/* ── KPI Strip ── */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {/* Total */}
                    <Card className="bg-card border border-border">
                        <CardContent className="p-4">
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <div>
                                            <p className="text-2xl font-bold text-foreground">{fmtEur(kpis.totalAmount)}</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Betriebskosten {year}
                                            </p>
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        Basierend auf verbuchten Rechnungen
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        </CardContent>
                    </Card>

                    {/* Invoice count */}
                    <Card className="bg-card border border-border">
                        <CardContent className="p-4">
                            <p className="text-2xl font-bold text-foreground">{kpis.invoiceCount}</p>
                            <p className="text-xs text-muted-foreground mt-1">Rechnungen</p>
                        </CardContent>
                    </Card>

                    {/* Average */}
                    <Card className="bg-card border border-border">
                        <CardContent className="p-4">
                            <p className="text-2xl font-bold text-foreground">{fmtEur(kpis.averageAmount)}</p>
                            <p className="text-xs text-muted-foreground mt-1">Ø pro Rechnung</p>
                        </CardContent>
                    </Card>

                    {/* Top categories */}
                    <Card className="bg-card border border-border">
                        <CardContent className="p-4">
                            <p className="text-xs text-muted-foreground mb-2">Top Kategorien</p>
                            {kpis.topCategories.length === 0 ? (
                                <p className="text-sm text-muted-foreground">—</p>
                            ) : (
                                <div className="space-y-1">
                                    {kpis.topCategories.map((tc) => (
                                        <div key={tc.category} className="flex justify-between text-sm">
                                            <span className="text-foreground truncate">
                                                {CATEGORY_LABELS[tc.category] ?? tc.category}
                                            </span>
                                            <span className="font-medium text-foreground">{fmtEur(tc.amount)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                {/* Info note */}
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="h-3 w-3" />
                    Basierend auf verbuchten Dokumenten · Betriebskosten ohne Erwerbskosten
                </p>

                {/* ── Filter bar ── */}
                <div className="flex flex-wrap items-center gap-3">
                    <Select value={String(year)} onValueChange={(v) => updateFilter('year', v)}>
                        <SelectTrigger className="w-[120px] text-sm" aria-label="Jahr / Year">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {years.map((y) => (
                                <SelectItem key={y} value={String(y)}>
                                    {y}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select
                        value={currentFilters.category || 'all'}
                        onValueChange={(v) => updateFilter('costCat', v)}
                    >
                        <SelectTrigger className="w-[180px] text-sm" aria-label="Kategorie filtern / Filter by category">
                            <SelectValue placeholder="Alle Kategorien..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Alle Kategorien</SelectItem>
                            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                                <SelectItem key={key} value={key}>
                                    {label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Input
                        className="w-[200px] text-sm"
                        placeholder="Anbieter suchen..."
                        aria-label="Anbieter suchen / Search vendors"
                        value={vendorInput}
                        onChange={(e) => setVendorInput(e.target.value)}
                    />

                    <div className="ml-auto">
                        <Button variant="outline" size="sm" onClick={handleExport}>
                            <Download className="h-4 w-4 mr-2" />
                            CSV Export
                        </Button>
                    </div>
                </div>

                {/* ── Cost table ── */}
                <div className="border border-border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border bg-muted/50">
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Datum
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Anbieter
                                </th>
                                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Betrag
                                </th>
                                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Kategorie
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedRows.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="text-center py-16">
                                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                            <Receipt className="h-8 w-8" />
                                            <p className="text-sm font-medium">
                                                Keine Kosten erfasst
                                            </p>
                                            <p className="text-xs max-w-xs">
                                                Laden Sie Rechnungen hoch und verbuchen Sie diese, um Kosten zu erfassen.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                <>
                                    {pagedRows.map((row) => (
                                        <tr
                                            key={row.documentId}
                                            className="border-b border-border last:border-0 hover:bg-muted cursor-pointer transition-colors"
                                            onClick={() => setSelectedDocId(row.documentId)}
                                        >
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <TooltipProvider>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <span className="text-sm text-foreground" suppressHydrationWarning>
                                                                {fmtDateDE(row.displayDate)}
                                                            </span>
                                                        </TooltipTrigger>
                                                        <TooltipContent suppressHydrationWarning>
                                                            {fmtDateDE(row.displayDate)}
                                                            {row.invoiceDate
                                                                ? ' (Rechnungsdatum)'
                                                                : ' (Verbuchungsdatum)'}
                                                        </TooltipContent>
                                                    </Tooltip>
                                                </TooltipProvider>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-foreground">
                                                {row.vendorName ?? 'Unbekannt'}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                {row.amount != null ? (
                                                    <span
                                                        className={`font-medium ${row.amount > 1000
                                                            ? 'text-red-600'
                                                            : 'text-foreground'
                                                            }`}
                                                    >
                                                        {fmtEur(row.amount)}
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground">—</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3">
                                                {row.category ? (
                                                    <Badge variant="outline" className="text-xs">
                                                        {CATEGORY_LABELS[row.category] ?? row.category}
                                                    </Badge>
                                                ) : (
                                                    <span className="text-muted-foreground text-xs">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}

                                    {/* Totals row */}
                                    <tr className="bg-muted/30 border-t border-border">
                                        <td className="px-4 py-3 text-sm font-semibold text-foreground">
                                            Gesamt
                                        </td>
                                        <td></td>
                                        <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">
                                            {fmtEur(kpis.totalAmount)}
                                        </td>
                                    </tr>
                                </>
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
                            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                                Zurück
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page >= totalPages}
                                onClick={() => setPage(page + 1)}
                            >
                                Weiter
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* Triage overlay */}
            {selectedDocId && (
                <TriageOverlay
                    documentId={selectedDocId}
                    onClose={() => setSelectedDocId(null)}
                    onApplied={() => {
                        setSelectedDocId(null);
                        router.refresh();
                    }}
                    readOnly={readOnly}
                />
            )}
        </>
    );
}
