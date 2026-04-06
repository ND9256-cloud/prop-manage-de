'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { renameDocument, softDeleteDocument, uploadWarehouseDocument } from '@/lib/warehouse-actions';
import { CATEGORIES } from '@/lib/warehouse-categories';
import { StatusBadge } from '@/components/warehouse/ui/status-badge';
import { TriageOverlay } from '@/components/warehouse/triage-overlay';
import {
    ArrowLeft,
    Upload,
    Pencil,
    Trash2,
    X,
    Check,
    FolderOpen,
} from 'lucide-react';

type Doc = {
    id: string;
    file_name: string;
    display_name: string | null;
    doc_type: string | null;
    status: string;
    source: string;
    mime_type: string;
    file_size_bytes: number;
    retention_until: string | null;
    created_at: string;
    amount: string | null;
    vendorName: string | null;
    extractedDate: string | null;
    summary: string | null;
    entityName: string | null;
    unitRef: string | null;
};

type PropertyInfo = {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
};

type Props = {
    documents: Doc[];
    property: PropertyInfo;
    category: string;
};

function formatDateDE(iso: string | null): string {
    if (!iso) return '\u2014';
    // Parse YYYY-MM-DD directly to avoid timezone shift from new Date()
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        return `${match[3]}.${match[2]}.${match[1]}`;
    }
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatAmount(amount: string | null): string {
    if (!amount) return '\u2014';
    const num = parseFloat(amount);
    if (isNaN(num)) return amount;
    return num.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export default function CategoryDocuments({ documents: initialDocs, property, category }: Props) {
    const router = useRouter();
    const [docs, setDocs] = useState(initialDocs);
    const [filter, setFilter] = useState('all');
    const [sort, setSort] = useState('newest');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
    const [triageDocId, setTriageDocId] = useState<string | null>(null);

    const catInfo = CATEGORIES.find(c => c.key === category) || { de: category, en: '', icon: '\u{1F4C1}' };

    const filtered = useMemo(() => {
        let list = [...docs];
        if (filter !== 'all') list = list.filter(d => d.status === filter);
        list.sort((a, b) => {
            switch (sort) {
                case 'oldest': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
                case 'amount_high': {
                    const aAmt = a.amount ? parseFloat(a.amount) : -Infinity;
                    const bAmt = b.amount ? parseFloat(b.amount) : -Infinity;
                    return bAmt - aAmt;
                }
                case 'amount_low': {
                    const aAmt = a.amount ? parseFloat(a.amount) : Infinity;
                    const bAmt = b.amount ? parseFloat(b.amount) : Infinity;
                    return aAmt - bAmt;
                }
                case 'vendor_az': return (a.vendorName || '').localeCompare(b.vendorName || '');
                case 'vendor_za': return (b.vendorName || '').localeCompare(a.vendorName || '');
                default: return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            }
        });
        return list;
    }, [docs, filter, sort]);

    const startRename = (doc: Doc) => {
        setEditingId(doc.id);
        setEditValue(doc.display_name || doc.file_name);
    };

    const saveRename = async () => {
        if (!editingId || !editValue.trim()) return;
        const result = await renameDocument(editingId, editValue.trim());
        if (result.error) {
            setNotification({ msg: result.error, type: 'error' });
        } else {
            setDocs(prev => prev.map(d => d.id === editingId ? { ...d, display_name: editValue.trim() } : d));
            setNotification({ msg: 'Umbenannt', type: 'success' });
            setTimeout(() => setNotification(null), 3000);
        }
        setEditingId(null);
    };

    const confirmDelete = async () => {
        if (!deleteId) return;
        const result = await softDeleteDocument(deleteId);
        if (result.error) {
            setNotification({ msg: result.error, type: 'error' });
        } else {
            setDocs(prev => prev.filter(d => d.id !== deleteId));
            setNotification({ msg: 'Gel\u00f6scht', type: 'success' });
            setTimeout(() => setNotification(null), 3000);
        }
        setDeleteId(null);
    };

    const onFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('propertyId', property.id);
        const result = await uploadWarehouseDocument(formData);
        if (result.error) {
            setNotification({ msg: result.error, type: 'error' });
        } else {
            setNotification({ msg: `${file.name} wird verarbeitet...`, type: 'success' });
            setTimeout(() => setNotification(null), 4000);
            router.refresh();
        }
    }, [property.id, router]);

    return (
        <div className="space-y-4">
            {notification && (
                <div className={`p-3 rounded-md text-sm font-medium ${notification.type === 'success'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                    {notification.msg}
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <span>{catInfo.icon}</span>
                        <span>{catInfo.de}</span>
                    </h1>
                    <p className="text-sm text-muted-foreground">{property.address}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => document.getElementById('cat-upload')?.click()}>
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        Hochladen
                    </Button>
                    <input id="cat-upload" type="file" className="hidden" onChange={onFileSelect} accept=".pdf,.jpg,.jpeg,.png,.gif,.webp" />
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/warehouse/${property.id}`)}>
                        <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                        Zurück
                    </Button>
                </div>
            </div>

            {/* Filter + Sort bar */}
            <div className="flex gap-3 flex-wrap">
                <Select value={filter} onValueChange={setFilter}>
                    <SelectTrigger className="w-44">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">Alle</SelectItem>
                        <SelectItem value="needs_review">Pr&uuml;fung n&ouml;tig</SelectItem>
                        <SelectItem value="applied">Verbucht</SelectItem>
                        <SelectItem value="failed">Fehlgeschlagen</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="newest">Neueste</SelectItem>
                        <SelectItem value="oldest">&Auml;lteste</SelectItem>
                        <SelectItem value="amount_high">Betrag (h&ouml;chster)</SelectItem>
                        <SelectItem value="amount_low">Betrag (niedrigster)</SelectItem>
                        <SelectItem value="vendor_az">Anbieter A-Z</SelectItem>
                        <SelectItem value="vendor_za">Anbieter Z-A</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Document table */}
            {filtered.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <FolderOpen className="mx-auto h-12 w-12 text-muted-foreground/40 mb-3" />
                        <p className="font-medium">Keine Dokumente in dieser Kategorie</p>
                        <Button variant="outline" className="mt-4" onClick={() => document.getElementById('cat-upload')?.click()}>
                            <Upload className="mr-2 h-4 w-4" />
                            Hochladen
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">DOKUMENT</TableHead>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">KATEGORIE</TableHead>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">STATUS</TableHead>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">ABSENDER</TableHead>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground text-right">BETRAG</TableHead>
                                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">DATUM</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filtered.map(doc => {
                                const catLabel = CATEGORIES.find(c => c.key === category);

                                return (
                                    <TableRow
                                        key={doc.id}
                                        className="group cursor-pointer hover:bg-muted/50"
                                        onClick={() => setTriageDocId(doc.id)}
                                    >
                                        {/* Document */}
                                        <TableCell className="py-3 px-4 max-w-xs">
                                            {editingId === doc.id ? (
                                                <div className="flex items-center gap-1">
                                                    <Input
                                                        value={editValue}
                                                        onChange={e => setEditValue(e.target.value)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') saveRename();
                                                            if (e.key === 'Escape') setEditingId(null);
                                                        }}
                                                        className="h-7 text-sm"
                                                        autoFocus
                                                        onClick={e => e.stopPropagation()}
                                                    />
                                                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); saveRename(); }} className="h-7 w-7 p-0">
                                                        <Check className="h-3.5 w-3.5 text-green-600" />
                                                    </Button>
                                                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setEditingId(null); }} className="h-7 w-7 p-0">
                                                        <X className="h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div>
                                                    <p className="truncate text-sm font-medium text-foreground">{doc.file_name}</p>
                                                    {(doc.entityName || doc.unitRef) && (
                                                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                                                            {[doc.entityName, doc.unitRef].filter(Boolean).join(' \u00b7 ')}
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </TableCell>

                                        {/* Category */}
                                        <TableCell className="py-3 px-4">
                                            <p className="text-sm text-foreground/80">{catLabel?.de ?? category}</p>
                                        </TableCell>

                                        {/* Status */}
                                        <TableCell className="py-3 px-4">
                                            <StatusBadge status={doc.status} />
                                        </TableCell>

                                        {/* Absender */}
                                        <TableCell className="py-3 px-4 text-sm text-foreground truncate max-w-[180px]">
                                            {doc.vendorName ?? '\u2014'}
                                        </TableCell>

                                        {/* Betrag */}
                                        <TableCell className="py-3 px-4 text-sm text-foreground font-mono whitespace-nowrap text-right">
                                            {formatAmount(doc.amount)}
                                        </TableCell>

                                        {/* Datum */}
                                        <TableCell className="py-3 px-4 text-sm text-muted-foreground whitespace-nowrap" suppressHydrationWarning>
                                            {formatDateDE(doc.extractedDate ?? doc.created_at)}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}

            {/* Delete confirmation dialog */}
            {deleteId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <Card className="w-full max-w-sm mx-4">
                        <CardContent className="p-6 space-y-4">
                            <div className="flex items-center gap-3">
                                <Trash2 className="h-6 w-6 text-red-500" />
                                <div>
                                    <p className="font-medium">Dokument l&ouml;schen?</p>
                                    <p className="text-sm text-muted-foreground">
                                        Das Dokument wird als gel&ouml;scht markiert (GoBD-konform).
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" size="sm" onClick={() => setDeleteId(null)}>Abbrechen</Button>
                                <Button variant="destructive" size="sm" onClick={confirmDelete}>L&ouml;schen</Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Triage overlay */}
            {triageDocId && (
                <TriageOverlay
                    documentId={triageDocId}
                    onClose={() => setTriageDocId(null)}
                    onApplied={() => {
                        setTriageDocId(null);
                        router.refresh();
                    }}
                />
            )}
        </div>
    );
}
