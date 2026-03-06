'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    RefreshCw,
    Upload,
    AlertCircle,
    CheckCircle2,
    Clock,
    FileText,
    ArrowRight,
} from 'lucide-react';

interface WarehouseDocument {
    id: string;
    file_name: string;
    doc_type: string | null;
    source: string;
    status: string;
    mime_type: string;
    file_size_bytes: number;
    created_at: string;
}

interface WarehouseStats {
    needs_review: number;
    processing: number;
    applied: number;
    queued: number;
}

interface Props {
    initialDocuments: WarehouseDocument[];
    initialStats: WarehouseStats;
}

function sourceIcon(source: string) {
    switch (source) {
        case 'email': return '📧';
        case 'telegram': return '✈️';
        case 'ui': return '🖥️';
        default: return '📄';
    }
}

function statusBadge(status: string) {
    const config: Record<string, { label: string; className: string }> = {
        queued: { label: 'Queued', className: 'bg-gray-100 text-gray-700 border-gray-200' },
        processing: { label: 'Processing', className: 'bg-blue-100 text-blue-700 border-blue-200' },
        needs_review: { label: 'Needs Review', className: 'bg-amber-100 text-amber-700 border-amber-200' },
        applied: { label: 'Applied', className: 'bg-green-100 text-green-700 border-green-200' },
        failed: { label: 'Failed', className: 'bg-red-100 text-red-700 border-red-200' },
        duplicate: { label: 'Duplicate', className: 'bg-gray-100 text-gray-500 border-gray-200' },
    };
    const c = config[status] || { label: status, className: 'bg-gray-100 text-gray-600' };
    return <Badge variant="outline" className={c.className}>{c.label}</Badge>;
}

function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function WarehouseDocumentList({ initialDocuments, initialStats }: Props) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [stats, setStats] = useState(initialStats);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    useEffect(() => {
        if (toastMessage) {
            const timer = setTimeout(() => setToastMessage(null), 4000);
            return () => clearTimeout(timer);
        }
    }, [toastMessage]);

    const refresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const { getWarehouseDocuments, getWarehouseStats } = await import('@/lib/warehouse-actions');
            const [docResult, statsResult] = await Promise.all([
                getWarehouseDocuments(),
                getWarehouseStats(),
            ]);
            if (docResult.documents) setDocuments(docResult.documents);
            setStats(statsResult);
        } finally {
            setIsRefreshing(false);
        }
    }, []);

    const handleUpload = useCallback(async (file: File) => {
        setIsUploading(true);
        try {
            const { uploadWarehouseDocument } = await import('@/lib/warehouse-actions');
            const formData = new FormData();
            formData.append('file', file);
            const result = await uploadWarehouseDocument(formData);
            if (result.error) {
                setToastMessage(`❌ ${result.error}`);
            } else {
                setToastMessage('✅ Document uploaded and queued for processing');
                await refresh();
            }
        } catch {
            setToastMessage('❌ Upload failed. Please try again.');
        } finally {
            setIsUploading(false);
        }
    }, [refresh]);

    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const onDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            handleUpload(files[0]);
        }
    }, [handleUpload]);

    const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) {
            handleUpload(files[0]);
        }
        e.target.value = '';
    }, [handleUpload]);

    return (
        <main className="p-6">
            {/* Toast notification */}
            {toastMessage && (
                <div className="fixed top-4 right-4 z-50 bg-white border rounded-lg shadow-lg px-4 py-3 text-sm max-w-md animate-in fade-in slide-in-from-top-2">
                    {toastMessage}
                </div>
            )}

            {/* Header */}
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Warehouse</h1>
                    <p className="text-muted-foreground">Document Intake & Processing</p>
                </div>
                <div className="flex gap-2">
                    <Link href="/dashboard/warehouse/review">
                        <Button variant="outline">
                            <AlertCircle className="h-4 w-4 mr-2" />
                            Review Queue
                            {stats.needs_review > 0 && (
                                <Badge className="ml-2 bg-amber-500 text-white">{stats.needs_review}</Badge>
                            )}
                        </Button>
                    </Link>
                    <Button variant="outline" onClick={refresh} disabled={isRefreshing}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid gap-4 md:grid-cols-4 mb-6">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Needs Review</CardTitle>
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats.needs_review}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Processing</CardTitle>
                        <Clock className="h-4 w-4 text-blue-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats.processing + stats.queued}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Applied</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats.applied}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Documents</CardTitle>
                        <FileText className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{documents.length}</div>
                    </CardContent>
                </Card>
            </div>

            {/* Drop Zone */}
            <div
                className={`mb-6 border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${isDragging
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
                    } ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onClick={() => document.getElementById('file-input')?.click()}
            >
                <Upload className={`h-8 w-8 mx-auto mb-2 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
                <p className="text-sm font-medium">
                    {isUploading
                        ? 'Uploading...'
                        : isDragging
                            ? 'Drop file here'
                            : 'Drag & drop a document here, or click to browse'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                    PDF, Word, JPEG, PNG, HEIC, WebP — max 50MB
                </p>
                <input
                    id="file-input"
                    type="file"
                    className="hidden"
                    accept=".pdf,.docx,.jpg,.jpeg,.png,.heic,.webp"
                    onChange={onFileSelect}
                />
            </div>

            {/* Document Table */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                        Documents
                        <Link href="/dashboard/warehouse/review">
                            <Button variant="ghost" size="sm">
                                Review queue <ArrowRight className="h-4 w-4 ml-1" />
                            </Button>
                        </Link>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {documents.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                            No documents yet. Upload one above or send via email/Telegram.
                        </p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>File</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Source</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Date</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {documents.map((doc) => (
                                    <TableRow key={doc.id}>
                                        <TableCell className="font-medium max-w-[300px] truncate" title={doc.file_name}>
                                            {doc.file_name}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="secondary">
                                                {doc.doc_type || 'unknown'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <span title={doc.source}>
                                                {sourceIcon(doc.source)} {doc.source}
                                            </span>
                                        </TableCell>
                                        <TableCell>{statusBadge(doc.status)}</TableCell>
                                        <TableCell className="text-muted-foreground text-sm">
                                            {formatDate(doc.created_at)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </main>
    );
}
