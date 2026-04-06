'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TriageOverlay } from '@/components/warehouse/triage-overlay';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Eye, Check, MoreHorizontal, Inbox } from 'lucide-react';
import { StatusBadge } from '@/components/warehouse/ui/status-badge';
import { ConfidenceBar } from '@/components/warehouse/ui/confidence-bar';
import { SourceIcon } from '@/components/warehouse/ui/source-icon';
import { EmptyState } from '@/components/warehouse/ui/empty-state';
import { LoadingRows } from '@/components/warehouse/ui/loading-rows';
import { t } from '@/lib/i18n/warehouse';
import { softDeleteDocument, type InboxDocument } from '@/lib/warehouse-actions';
import { CATEGORIES } from '@/lib/warehouse-categories';

type SortKey = 'document' | 'property' | 'category' | 'status' | 'confidence' | 'date';
type SortDir = 'asc' | 'desc';

interface InboxTableProps {
    documents: InboxDocument[];
    total: number;
    page: number;
    pageSize: number;
    isLoading?: boolean;
    readOnly?: boolean;
}

function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    });
}

function getCategoryLabel(key: string | null): { de: string; sub?: string } {
    if (!key) return { de: '—' };
    const cat = CATEGORIES.find((c) => c.key === key);
    return { de: cat?.de ?? key };
}

function SortableHeader({
    label,
    sortKey,
    activeSortKey,
    sortDir,
    onSort,
}: {
    label: string;
    sortKey: SortKey;
    activeSortKey: SortKey;
    sortDir: SortDir;
    onSort: (key: SortKey) => void;
}) {
    const isActive = sortKey === activeSortKey;
    return (
        <TableHead
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors"
            onClick={() => onSort(sortKey)}
        >
            <span className="inline-flex items-center gap-1">
                {label}
                {isActive && (
                    <span className="text-foreground">{sortDir === 'asc' ? '▲' : '▼'}</span>
                )}
            </span>
        </TableHead>
    );
}

export function InboxTable({
    documents,
    total,
    page,
    pageSize,
    isLoading,
    readOnly,
}: InboxTableProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [triageDocId, setTriageDocId] = useState<string | null>(null);
    const [sortKey, setSortKey] = useState<SortKey>('date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const toggleSort = useCallback((key: SortKey) => {
        setSortKey((prev) => {
            if (prev === key) {
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
            } else {
                setSortDir(key === 'confidence' || key === 'date' ? 'desc' : 'asc');
            }
            return key;
        });
    }, []);

    const sortedDocuments = useMemo(() => {
        const docs = [...documents];
        const dir = sortDir === 'asc' ? 1 : -1;
        docs.sort((a, b) => {
            switch (sortKey) {
                case 'document': {
                    const av = (a.file_name ?? '').toLowerCase();
                    const bv = (b.file_name ?? '').toLowerCase();
                    return av.localeCompare(bv, 'de') * dir;
                }
                case 'property': {
                    const av = (a.property_short_code ?? '').toLowerCase();
                    const bv = (b.property_short_code ?? '').toLowerCase();
                    return av.localeCompare(bv, 'de') * dir;
                }
                case 'category': {
                    const av = getCategoryLabel(a.category).de.toLowerCase();
                    const bv = getCategoryLabel(b.category).de.toLowerCase();
                    return av.localeCompare(bv, 'de') * dir;
                }
                case 'status': {
                    return a.status.localeCompare(b.status, 'de') * dir;
                }
                case 'confidence': {
                    const av = a.confidence_score ?? -1;
                    const bv = b.confidence_score ?? -1;
                    return (av - bv) * dir;
                }
                case 'date': {
                    return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
                }
                default:
                    return 0;
            }
        });
        return docs;
    }, [documents, sortKey, sortDir]);

    const toggleSelect = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleAll = useCallback(() => {
        if (selected.size === documents.length) {
            setSelected(new Set());
        } else {
            setSelected(new Set(documents.map((d) => d.id)));
        }
    }, [selected.size, documents]);

    const navigateToPage = useCallback(
        (p: number) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set('page', String(p));
            router.push(`?${params.toString()}`);
        },
        [router, searchParams]
    );

    const handleDelete = useCallback(async () => {
        if (!deleteId) return;
        setDeleting(true);
        await softDeleteDocument(deleteId);
        setDeleting(false);
        setDeleteId(null);
        router.refresh();
    }, [deleteId, router]);

    const handleCopyFilename = useCallback((fileName: string) => {
        navigator.clipboard.writeText(fileName);
    }, []);

    const totalPages = Math.ceil(total / pageSize);
    const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const showingTo = Math.min(page * pageSize, total);

    if (!isLoading && documents.length === 0) {
        return (
            <EmptyState
                icon={Inbox}
                title={t.noDocuments.de}
                subtitle={t.noDocumentsYet.de}
            />
        );
    }

    return (
        <div className="space-y-4">
            {/* Bulk action bar */}
            {selected.size > 0 && (
                <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <span className="text-sm font-medium text-foreground">
                        {selected.size} {t.documents.de} {t.selected.de}
                    </span>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm">
                            {t.assignProperty.de}
                        </Button>
                        <Button variant="outline" size="sm" className="text-amber-600 border-amber-200 hover:bg-amber-50">
                            {t.quarantine.de}
                        </Button>
                        <Button variant="outline" size="sm">
                            {t.export.de}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => {
                                // Bulk delete would need a separate server action
                            }}
                        >
                            {t.delete.de}
                        </Button>
                    </div>
                </div>
            )}

            {/* Table */}
            <div className="rounded-lg border border-border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10 px-4">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-border"
                                    checked={selected.size === documents.length && documents.length > 0}
                                    onChange={toggleAll}
                                />
                            </TableHead>
                            <SortableHeader label={t.document.de.toUpperCase()} sortKey="document" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                            <SortableHeader label={t.property.de.toUpperCase()} sortKey="property" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                            <SortableHeader label={t.category.de.toUpperCase()} sortKey="category" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                            <SortableHeader label={t.status.de.toUpperCase()} sortKey="status" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                            <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">ABSENDER</TableHead>
                            <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground text-right">BETRAG</TableHead>
                            <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">DATUM</TableHead>
                            <SortableHeader label={t.confidence.de.toUpperCase()} sortKey="confidence" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                            <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {t.source.de.toUpperCase()}
                            </TableHead>
                            <TableHead className="w-10" />
                        </TableRow>
                    </TableHeader>

                    {isLoading ? (
                        <LoadingRows rows={5} cols={7} />
                    ) : (
                        <TableBody>
                            {sortedDocuments.map((doc) => {
                                const isSelected = selected.has(doc.id);
                                const catLabel = getCategoryLabel(doc.category);
                                const displayName = doc.file_name;

                                return (
                                    <TableRow
                                        key={doc.id}
                                        className={`group cursor-pointer ${isSelected
                                            ? 'bg-primary/5 border-l-2 border-l-primary'
                                            : 'hover:bg-muted/50'
                                            }`}
                                        onClick={() => setTriageDocId(doc.id)}
                                    >
                                        {/* Checkbox */}
                                        <TableCell className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4 rounded border-border"
                                                checked={isSelected}
                                                onChange={() => toggleSelect(doc.id)}
                                            />
                                        </TableCell>

                                        {/* Document */}
                                        <TableCell className="py-3 px-4 max-w-xs">
                                            <p className="truncate text-sm font-medium text-foreground">
                                                {displayName}
                                            </p>
                                        </TableCell>

                                        {/* Property */}
                                        <TableCell className="py-3 px-4">
                                            {doc.property_short_code ? (
                                                <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                                                    {doc.property_short_code}
                                                </span>
                                            ) : (
                                                <span className="text-sm text-amber-600">—</span>
                                            )}
                                        </TableCell>

                                        {/* Category */}
                                        <TableCell className="py-3 px-4">
                                            <p className="text-sm text-foreground/80">{catLabel.de}</p>
                                        </TableCell>

                                        {/* Status */}
                                        <TableCell className="py-3 px-4">
                                            <StatusBadge status={doc.status} />
                                        </TableCell>

                                        {/* Absender */}
                                        <TableCell className="py-3 px-4 text-sm text-foreground truncate max-w-[180px]">
                                            {doc.vendorName ?? '—'}
                                        </TableCell>

                                        {/* Betrag */}
                                        <TableCell className="py-3 px-4 text-sm text-foreground font-mono whitespace-nowrap text-right">
                                            {doc.amount ? parseFloat(String(doc.amount).replace(',', '.')).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '—'}
                                        </TableCell>

                                        {/* Datum (extracted) */}
                                        <TableCell className="py-3 px-4 text-sm text-muted-foreground whitespace-nowrap" suppressHydrationWarning>
                                            {doc.extractedDate
                                                ? (/^\d{4}-\d{2}-\d{2}/.test(doc.extractedDate)
                                                    ? doc.extractedDate.slice(8, 10) + '.' + doc.extractedDate.slice(5, 7) + '.' + doc.extractedDate.slice(0, 4)
                                                    : doc.extractedDate)
                                                : '—'}
                                        </TableCell>

                                        {/* Confidence */}
                                        <TableCell className="py-3 px-4">
                                            {doc.confidence_score !== null ? (
                                                <ConfidenceBar score={doc.confidence_score * 100} />
                                            ) : (
                                                <span className="text-sm text-muted-foreground">—</span>
                                            )}
                                        </TableCell>

                                        {/* Source */}
                                        <TableCell className="py-3 px-4">
                                            <SourceIcon source={doc.source} />
                                        </TableCell>

                                        {/* Actions */}
                                        <TableCell className="py-3 px-4">
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 w-8 p-0"
                                                    title={t.viewDocument.de}
                                                >
                                                    <Eye className="h-4 w-4" />
                                                </Button>

                                                {doc.status === 'needs_review' && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0"
                                                        title={t.needsReview.de}
                                                        onClick={() =>
                                                            router.push('/dashboard/warehouse/review')
                                                        }
                                                    >
                                                        <Check className="h-4 w-4" />
                                                    </Button>
                                                )}

                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 w-8 p-0"
                                                        >
                                                            <MoreHorizontal className="h-4 w-4" />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        <DropdownMenuItem>
                                                            {t.viewDocument.de}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem
                                                            onClick={() => handleCopyFilename(doc.file_name)}
                                                        >
                                                            {t.copyFilename.de}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem>
                                                            {t.download.de}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem className="text-amber-600">
                                                            {t.quarantine.de}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem
                                                            className="text-red-600"
                                                            onClick={() => setDeleteId(doc.id)}
                                                        >
                                                            {t.delete.de}
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    )}
                </Table>
            </div>

            {/* Pagination */}
            {total > 0 && (
                <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                        {t.showing.de} {showingFrom}–{showingTo} {t.of.de} {total} {t.documents.de}
                    </p>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page <= 1}
                            onClick={() => navigateToPage(page - 1)}
                        >
                            {t.previous.de}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= totalPages}
                            onClick={() => navigateToPage(page + 1)}
                        >
                            {t.next.de}
                        </Button>
                    </div>
                </div>
            )}

            {/* Delete confirmation dialog */}
            <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t.confirmDelete.de}</DialogTitle>
                        <DialogDescription>
                            {t.confirmDeleteMessage.de}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteId(null)}>
                            {t.cancel.de}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={deleting}
                        >
                            {t.delete.de}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Triage overlay */}
            {triageDocId && (
                <TriageOverlay
                    documentId={triageDocId}
                    onClose={() => setTriageDocId(null)}
                    onApplied={() => {
                        setTriageDocId(null);
                        router.refresh();
                    }}
                    readOnly={readOnly}
                />
            )}
        </div>
    );
}
