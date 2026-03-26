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
import { FileText, Search, Mail, Upload as UploadIcon, Globe } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────
export interface PropertyDoc {
    id: string;
    displayName: string;
    category: string | null;
    status: string;
    source: string | null;
    mimeType: string | null;
    createdAt: string;
    amount: string | null;
    vendorName: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
    kosten_rechnungen: 'Rechnungen',
    vertraege: 'Verträge',
    finanzen: 'Finanzen',
    versicherungen: 'Versicherungen',
    steuern: 'Steuern',
    kommunikation: 'Kommunikation',
    sonstiges: 'Sonstiges',
};

const STATUS_COLORS: Record<string, string> = {
    needs_review: 'bg-amber-50 text-amber-700 border-amber-200',
    applied: 'bg-green-50 text-green-700 border-green-200',
    quarantined: 'bg-red-50 text-red-700 border-red-200',
    processing: 'bg-blue-50 text-blue-700 border-blue-200',
    uploaded: 'bg-gray-50 text-gray-700 border-gray-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
};

const STATUS_LABELS: Record<string, string> = {
    needs_review: 'Prüfung',
    applied: 'Verbucht',
    quarantined: 'Quarantäne',
    processing: 'Verarbeitung',
    uploaded: 'Hochgeladen',
    failed: 'Fehlgeschlagen',
};

function sourceIcon(source: string | null) {
    if (source === 'email') return <Mail className="h-3.5 w-3.5 text-muted-foreground" />;
    if (source === 'api') return <Globe className="h-3.5 w-3.5 text-muted-foreground" />;
    return <UploadIcon className="h-3.5 w-3.5 text-muted-foreground" />;
}

// ─── Props ────────────────────────────────────────────────────
interface PropertyDocumentTableProps {
    docs: PropertyDoc[];
    total: number;
    page: number;
    propertyId: string;
    currentFilters: {
        search: string;
        category: string;
        status: string;
        sort: string;
    };
    onDocumentClick: (docId: string) => void;
}

export function PropertyDocumentTable({
    docs,
    total,
    page,
    propertyId,
    currentFilters,
    onDocumentClick,
}: PropertyDocumentTableProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [searchInput, setSearchInput] = useState(currentFilters.search);
    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);

    const updateFilter = useCallback(
        (key: string, value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value && value !== 'all' && value !== '') {
                params.set(key, value);
            } else {
                params.delete(key);
            }
            params.set('tab', 'dokumente');
            params.delete('docPage');
            router.push(`/dashboard/warehouse/${propertyId}?${params.toString()}`);
        },
        [router, searchParams, propertyId],
    );

    const handleSearch = useCallback(() => {
        updateFilter('q', searchInput);
    }, [updateFilter, searchInput]);

    const goToPage = (p: number) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('docPage', String(p));
        params.set('tab', 'dokumente');
        router.push(`/dashboard/warehouse/${propertyId}?${params.toString()}`);
    };

    return (
        <div className="space-y-4">
            {/* Section header */}
            <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Alle Dokumente
                </h3>
                <span className="text-xs text-muted-foreground">{total} Dokumente</span>
            </div>

            {/* Filter bar */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1">
                    <Input
                        className="w-[200px] text-sm"
                        placeholder="Dokument suchen..."
                        aria-label="Dokument suchen"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    />
                    <Button variant="ghost" size="sm" onClick={handleSearch} aria-label="Suchen">
                        <Search className="h-4 w-4" />
                    </Button>
                </div>

                <Select
                    value={currentFilters.category || 'all'}
                    onValueChange={(v) => updateFilter('cat', v)}
                >
                    <SelectTrigger className="w-[180px] text-sm" aria-label="Kategorie filtern">
                        <SelectValue placeholder="Alle Kategorien..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">Alle Kategorien</SelectItem>
                        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                            <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select
                    value={currentFilters.status || 'all'}
                    onValueChange={(v) => updateFilter('docStatus', v)}
                >
                    <SelectTrigger className="w-[160px] text-sm" aria-label="Status filtern">
                        <SelectValue placeholder="Alle Status..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">Alle Status</SelectItem>
                        <SelectItem value="needs_review">Prüfung</SelectItem>
                        <SelectItem value="applied">Verbucht</SelectItem>
                        <SelectItem value="quarantined">Quarantäne</SelectItem>
                    </SelectContent>
                </Select>

                <Select
                    value={currentFilters.sort || 'newest'}
                    onValueChange={(v) => updateFilter('sort', v)}
                >
                    <SelectTrigger className="w-[160px] text-sm" aria-label="Sortierung">
                        <SelectValue placeholder="Sortierung..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="newest">Neueste zuerst</SelectItem>
                        <SelectItem value="oldest">Älteste zuerst</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Table */}
            <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border bg-muted/50">
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Dokument
                            </th>
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Kategorie
                            </th>
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Status
                            </th>
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Betrag
                            </th>
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Datum
                            </th>
                            <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide w-8">
                                <span className="sr-only">Quelle</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {docs.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="text-center py-16">
                                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                        <FileText className="h-8 w-8" />
                                        <p className="text-sm">Keine Dokumente</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            docs.map((doc) => (
                                <tr
                                    key={doc.id}
                                    className="border-b border-border last:border-0 hover:bg-muted cursor-pointer transition-colors"
                                    onClick={() => onDocumentClick(doc.id)}
                                >
                                    <td className="px-4 py-3">
                                        <div className="flex flex-col">
                                            <span className="text-sm text-foreground font-medium truncate max-w-[250px]">
                                                {doc.displayName}
                                            </span>
                                            {doc.vendorName && (
                                                <span className="text-xs text-muted-foreground">{doc.vendorName}</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        {doc.category ? (
                                            <Badge variant="outline" className="text-xs">
                                                {CATEGORY_LABELS[doc.category] ?? doc.category}
                                            </Badge>
                                        ) : (
                                            <span className="text-muted-foreground text-xs">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Badge
                                            variant="outline"
                                            className={`text-xs ${STATUS_COLORS[doc.status] ?? 'bg-gray-50 text-gray-700 border-gray-200'}`}
                                        >
                                            {STATUS_LABELS[doc.status] ?? doc.status}
                                        </Badge>
                                    </td>
                                    <td className="px-4 py-3 text-sm text-foreground font-mono">
                                        {doc.amount ?? '—'}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                                        {new Date(doc.createdAt).toLocaleDateString('de-DE')}
                                    </td>
                                    <td className="px-4 py-3">
                                        {sourceIcon(doc.source)}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                        Zeige {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} von {total}
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
        </div>
    );
}
