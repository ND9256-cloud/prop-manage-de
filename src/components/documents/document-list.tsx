'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileText, Trash2, Download, File, Image, Loader2 } from 'lucide-react';
import { uploadDocument, deleteDocument, getDocumentUrl } from '@/lib/document-actions';

interface Doc {
    id: string;
    name: string;
    type: string;
    fileSize: number;
    mimeType: string;
    createdAt: string;
}

const DOC_TYPES = [
    { value: 'contract', label: 'Mietvertrag' },
    { value: 'invoice', label: 'Rechnung' },
    { value: 'notice', label: 'Kündigung' },
    { value: 'protocol', label: 'Protokoll' },
    { value: 'other', label: 'Sonstige' },
];

function typeLabel(type: string) {
    return DOC_TYPES.find((t) => t.value === type)?.label ?? type;
}

function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimeType: string) {
    if (mimeType.startsWith('image/')) return <Image className="h-5 w-5 text-blue-500" />;
    if (mimeType === 'application/pdf') return <FileText className="h-5 w-5 text-red-500" />;
    return <File className="h-5 w-5 text-muted-foreground" />;
}

export default function DocumentList({
    propertyId,
    documents: initialDocs,
}: {
    propertyId: string;
    documents: Doc[];
}) {
    const [docs, setDocs] = useState(initialDocs);
    const [uploading, setUploading] = useState(false);
    const [selectedType, setSelectedType] = useState('contract');
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    async function handleUpload(files: FileList | null) {
        if (!files || files.length === 0) return;
        setUploading(true);
        try {
            for (const file of Array.from(files)) {
                const fd = new FormData();
                fd.set('propertyId', propertyId);
                fd.set('type', selectedType);
                fd.set('file', file);
                await uploadDocument(fd);
            }
            window.location.reload();
        } catch (e) {
            alert(`Upload fehlgeschlagen: ${(e as Error).message}`);
        } finally {
            setUploading(false);
        }
    }

    async function handleDelete(docId: string, name: string) {
        if (!confirm(`„${name}" wirklich löschen?`)) return;
        try {
            await deleteDocument(docId);
            setDocs((prev) => prev.filter((d) => d.id !== docId));
        } catch (e) {
            alert(`Löschen fehlgeschlagen: ${(e as Error).message}`);
        }
    }

    async function handleDownload(docId: string) {
        try {
            const url = await getDocumentUrl(docId);
            window.open(url, '_blank');
        } catch (e) {
            alert(`Download fehlgeschlagen: ${(e as Error).message}`);
        }
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Dokumente</CardTitle>
                <div className="flex items-center gap-2">
                    <select
                        value={selectedType}
                        onChange={(e) => setSelectedType(e.target.value)}
                        className="text-sm border rounded-md px-2 py-1.5 bg-background"
                    >
                        {DOC_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={uploading}
                        onClick={() => inputRef.current?.click()}
                    >
                        {uploading ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                            <Upload className="h-4 w-4 mr-2" />
                        )}
                        Hochladen
                    </Button>
                    <input
                        ref={inputRef}
                        type="file"
                        className="hidden"
                        multiple
                        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
                        onChange={(e) => handleUpload(e.target.files)}
                    />
                </div>
            </CardHeader>
            <CardContent>
                {/* Drop zone */}
                <div
                    className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors mb-4 ${dragOver
                            ? 'border-primary bg-primary/5'
                            : 'border-muted-foreground/20'
                        }`}
                    onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        handleUpload(e.dataTransfer.files);
                    }}
                >
                    <p className="text-sm text-muted-foreground">
                        Dateien hierher ziehen oder oben auf &quot;Hochladen&quot; klicken
                    </p>
                </div>

                {/* Document list */}
                {docs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                        Noch keine Dokumente hinterlegt.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {docs.map((doc) => (
                            <div
                                key={doc.id}
                                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors group"
                            >
                                {fileIcon(doc.mimeType)}
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{doc.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {typeLabel(doc.type)} · {formatSize(doc.fileSize)} ·{' '}
                                        {new Date(doc.createdAt).toLocaleDateString('de-DE')}
                                    </p>
                                </div>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleDownload(doc.id)}
                                    >
                                        <Download className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-red-500 hover:text-red-600"
                                        onClick={() => handleDelete(doc.id, doc.name)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
