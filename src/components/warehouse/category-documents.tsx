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
import { renameDocument, softDeleteDocument, uploadWarehouseDocument } from '@/lib/warehouse-actions';
import { CATEGORIES } from '@/lib/warehouse-categories';
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

function formatSize(bytes: number): string {
    if (!bytes) return '\u2014';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateDE(iso: string | null): string {
    if (!iso) return '\u2014';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatAmount(amount: string | null): string {
    if (!amount) return '\u2014';
    const num = parseFloat(amount);
    if (isNaN(num)) return amount;
    return num.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

const docTypeBadge: Record<string, string> = {
    invoice: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    lease: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    inspection_report: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    other: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

const statusBadge: Record<string, string> = {
    queued: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    needs_review: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    applied: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    processing_failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    apply_failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const STATUS_LABELS: Record<string, string> = {
    queued: 'Warteschlange',
    processing: 'Verarbeitung',
    needs_review: 'Pr\u00fcfung n\u00f6tig',
    applied: 'Verbucht',
    failed: 'Fehlgeschlagen',
    processing_failed: 'Fehlgeschlagen',
    apply_failed: 'Fehlgeschlagen',
};

const sourceIcon: Record<string, string> = {
    email: '\u{1F4E7}',
    telegram: '\u{1F4F1}',
    ui: '\u{1F5A5}\uFE0F',
};

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

    const isRetentionSoon = (iso: string | null) => {
        if (!iso) return false;
        const oneYear = new Date();
        oneYear.setFullYear(oneYear.getFullYear() + 1);
        return new Date(iso) < oneYear;
    };

    return (
        <div className="space-y-4">
            {notification && (
                <div className={`p-3 rounded-md text-sm font-medium ${notification.type === 'success'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                    {notification.msg}
                </div>
            )}

            {/* Header with breadcrumb */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/warehouse/${property.id}`)}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <button onClick={() => router.push('/dashboard/warehouse')} className="hover:text-foreground">Dokumentenarchiv</button>
                        <span>&rarr;</span>
                        <button onClick={() => router.push(`/dashboard/warehouse/${property.id}`)} className="hover:text-foreground">
                            {property.shortCode || property.address}
                        </button>
                        <span>&rarr;</span>
                        <span className="text-foreground font-medium">{catInfo.de}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => document.getElementById('cat-upload')?.click()}>
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        Hochladen
                    </Button>
                    <input id="cat-upload" type="file" className="hidden" onChange={onFileSelect} accept=".pdf,.jpg,.jpeg,.png,.gif,.webp" />
                </div>
            </div>

            {/* Title */}
            <div>
                <h1 className="text-xl font-bold flex items-center gap-2">
                    <span>{catInfo.icon}</span>
                    <span>{catInfo.de}</span>
                </h1>
                <p className="text-sm text-muted-foreground">{property.address}</p>
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
                <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                            <tr>
                                <th className="text-left p-3 font-medium">Dokument</th>
                                <th className="text-left p-3 font-medium">Anbieter</th>
                                <th className="text-right p-3 font-medium">Betrag</th>
                                <th className="text-left p-3 font-medium">Typ</th>
                                <th className="text-left p-3 font-medium">Status</th>
                                <th className="text-right p-3 font-medium">Gr&ouml;&szlig;e</th>
                                <th className="text-left p-3 font-medium">Aufbew.</th>
                                <th className="text-left p-3 font-medium">Datum</th>
                                <th className="text-center p-3 font-medium">Quelle</th>
                                <th className="text-right p-3 font-medium">Aktionen</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(doc => (
                                <tr key={doc.id} className="border-t hover:bg-muted/30 group cursor-pointer" onClick={() => setTriageDocId(doc.id)}>
                                    {/* Name */}
                                    <td className="p-3 max-w-[280px]">
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
                                                <p className="font-medium truncate">{doc.display_name || doc.file_name}</p>
                                                {doc.vendorName && (
                                                    <p className="text-xs text-muted-foreground truncate">{doc.vendorName}</p>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    {/* Vendor */}
                                    <td className="p-3 text-muted-foreground max-w-[160px]">
                                        <span className="truncate block">{doc.vendorName || '\u2014'}</span>
                                    </td>
                                    {/* Amount */}
                                    <td className="p-3 text-right font-medium tabular-nums">
                                        {formatAmount(doc.amount)}
                                    </td>
                                    {/* Doc type */}
                                    <td className="p-3">
                                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${docTypeBadge[doc.doc_type || 'other'] || docTypeBadge.other}`}>
                                            {doc.doc_type || 'other'}
                                        </span>
                                    </td>
                                    {/* Status */}
                                    <td className="p-3">
                                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusBadge[doc.status] || statusBadge.queued}`}>
                                            {STATUS_LABELS[doc.status] ?? doc.status}
                                        </span>
                                    </td>
                                    {/* Size */}
                                    <td className="p-3 text-right text-muted-foreground">
                                        {formatSize(doc.file_size_bytes)}
                                    </td>
                                    {/* Retention */}
                                    <td className={`p-3 ${isRetentionSoon(doc.retention_until) ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                                        {formatDateDE(doc.retention_until)}
                                    </td>
                                    {/* Date */}
                                    <td className="p-3 text-muted-foreground">
                                        {formatDateDE(doc.created_at)}
                                    </td>
                                    {/* Source */}
                                    <td className="p-3 text-center">
                                        {sourceIcon[doc.source] || '\u{1F4C4}'}
                                    </td>
                                    {/* Actions */}
                                    <td className="p-3 text-right">
                                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Umbenennen" onClick={(e) => { e.stopPropagation(); startRename(doc); }}>
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-700" title="L&ouml;schen" onClick={(e) => { e.stopPropagation(); setDeleteId(doc.id); }}>
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
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
