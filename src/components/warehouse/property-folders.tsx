'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { uploadWarehouseDocument } from '@/lib/warehouse-actions';
import {
    FileText,
    AlertTriangle,
    CheckCircle2,
    Clock,
    Upload,
    X,
    FolderOpen,
    Building2,
} from 'lucide-react';

type Folder = {
    key: string;
    de: string;
    en: string;
    icon: string;
    count: number;
    needsReview: number;
    totalSize: number;
    mostRecent: string | null;
};

type PropertyInfo = {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
};

type Stats = {
    total: number;
    needsReview: number;
    appliedThisMonth: number;
    oldestUnreviewed: string | null;
};

type Props = {
    property: PropertyInfo;
    folders: Folder[];
    stats: Stats;
    unassignedCount: number;
    readOnly?: boolean;
    unitCount?: number;
};

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateDE(iso: string | null): string {
    if (!iso) return 'Keine Dokumente';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export default function PropertyFolders({ property, folders, stats, unassignedCount, readOnly, unitCount }: Props) {
    const router = useRouter();
    const [dragging, setDragging] = useState(false);
    const [showUpload, setShowUpload] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(true);
    }, []);
    const onDragLeave = useCallback(() => setDragging(false), []);
    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) { setSelectedFile(file); setShowUpload(true); }
    }, []);
    const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) { setSelectedFile(file); setShowUpload(true); }
    }, []);

    const handleUpload = async () => {
        if (!selectedFile) return;
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', selectedFile);
            formData.append('propertyId', property.id);
            const result = await uploadWarehouseDocument(formData);
            if (result.error) {
                setNotification({ msg: result.error, type: 'error' });
            } else {
                setNotification({ msg: `${selectedFile.name} wird verarbeitet...`, type: 'success' });
                setTimeout(() => setNotification(null), 4000);
                setShowUpload(false);
                setSelectedFile(null);
                router.refresh();
            }
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-6">
            {notification && (
                <div className={`p-3 rounded-md text-sm font-medium ${notification.type === 'success'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                    {notification.msg}
                </div>
            )}

            {/* Upload button */}
            <div className="flex justify-end">
                <div>
                    <Button
                        variant="outline"
                        onClick={() => document.getElementById('prop-file-upload')?.click()}
                    >
                        <Upload className="mr-2 h-4 w-4" />
                        Hochladen
                    </Button>
                    <input
                        id="prop-file-upload"
                        type="file"
                        className="hidden"
                        onChange={onFileSelect}
                        accept=".pdf,.jpg,.jpeg,.png,.gif,.webp"
                    />
                </div>
            </div>

            {/* Property stats row */}
            <div className={`grid gap-4 ${readOnly ? 'grid-cols-2' : stats.needsReview > 0 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1'}`}>
                <Card>
                    <CardContent className="p-4 flex items-center gap-3">
                        <FileText className="h-5 w-5 text-blue-500" />
                        <div>
                            <p className="text-2xl font-bold">{stats.total}</p>
                            <p className="text-xs text-muted-foreground">Dokumente</p>
                        </div>
                    </CardContent>
                </Card>
                {readOnly ? (
                    <Card>
                        <CardContent className="p-4 flex items-center gap-3">
                            <Building2 className="h-5 w-5 text-indigo-500" />
                            <div>
                                <p className="text-2xl font-bold">{unitCount ?? 0}</p>
                                <p className="text-xs text-muted-foreground">Einheiten</p>
                            </div>
                        </CardContent>
                    </Card>
                ) : stats.needsReview > 0 ? (
                    <>
                        <Card>
                            <CardContent className="p-4 flex items-center gap-3">
                                <AlertTriangle className="h-5 w-5 text-amber-500" />
                                <div>
                                    <p className="text-2xl font-bold">{stats.needsReview}</p>
                                    <p className="text-xs text-muted-foreground">Prüfung nötig</p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="p-4 flex items-center gap-3">
                                <CheckCircle2 className="h-5 w-5 text-green-500" />
                                <div>
                                    <p className="text-2xl font-bold">{stats.appliedThisMonth}</p>
                                    <p className="text-xs text-muted-foreground">Angewendet (Monat)</p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="p-4 flex items-center gap-3">
                                <Clock className="h-5 w-5 text-orange-500" />
                                <div>
                                    <p className="text-sm font-bold">
                                        {stats.oldestUnreviewed ? formatDateDE(stats.oldestUnreviewed) : '—'}
                                    </p>
                                    <p className="text-xs text-muted-foreground">Älteste offene Prüfung</p>
                                </div>
                            </CardContent>
                        </Card>
                    </>
                ) : null}
            </div>

            {/* Document category cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {folders.filter((f) => f.count > 0 && f.key !== 'medien').map((folder) => (
                    <Card
                        key={folder.key}
                        className="cursor-pointer hover:shadow-md transition-shadow relative"
                        onClick={() => router.push(`/dashboard/warehouse/${property.id}/${folder.key}`)}
                    >
                        {!readOnly && folder.needsReview > 0 && (
                            <Badge className="absolute top-3 right-3 bg-amber-500 text-white hover:bg-amber-600">
                                {folder.needsReview}
                            </Badge>
                        )}
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base flex items-center gap-2 pr-8">
                                <span className="text-lg">{folder.icon}</span>
                                <span>{folder.de}</span>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0 space-y-1 text-sm text-muted-foreground">
                            <p className="text-2xl font-bold text-foreground">{folder.count}</p>
                            <p>{formatDateDE(folder.mostRecent)}</p>
                            <p>{formatSize(folder.totalSize)}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* Fotos & Medien section */}
            {folders.filter((f) => f.key === 'medien' && f.count > 0).map((folder) => (
                <div key={folder.key} className="space-y-3">
                    <div className="border-t pt-4">
                        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Fotos & Medien</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        <Card
                            className="cursor-pointer hover:shadow-md transition-shadow relative"
                            onClick={() => router.push(`/dashboard/warehouse/${property.id}/${folder.key}`)}
                        >
                            {!readOnly && folder.needsReview > 0 && (
                                <Badge className="absolute top-3 right-3 bg-amber-500 text-white hover:bg-amber-600">
                                    {folder.needsReview}
                                </Badge>
                            )}
                            <CardHeader className="pb-2">
                                <CardTitle className="text-base flex items-center gap-2 pr-8">
                                    <span className="text-lg">{folder.icon}</span>
                                    <span>{folder.de}</span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-0 space-y-1 text-sm text-muted-foreground">
                                <p className="text-2xl font-bold text-foreground">{folder.count}</p>
                                <p>{formatDateDE(folder.mostRecent)}</p>
                                <p>{formatSize(folder.totalSize)}</p>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            ))}

            {/* Unassigned documents warning */}
            {unassignedCount > 0 && (
                <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30">
                    <CardContent className="p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <AlertTriangle className="h-5 w-5 text-amber-600" />
                            <div>
                                <p className="font-medium text-amber-800 dark:text-amber-200">
                                    ⚠️ Nicht kategorisiert
                                </p>
                                <p className="text-sm text-amber-700 dark:text-amber-300">
                                    {unassignedCount} Dokument{unassignedCount !== 1 ? 'e' : ''} ohne Kategorie
                                </p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => router.push('/dashboard/warehouse/review')}
                            className="border-amber-400 text-amber-800 hover:bg-amber-100"
                        >
                            Jetzt zuweisen
                        </Button>
                    </CardContent>
                </Card>
            )}

            {/* Drag & drop zone */}
            <div
                className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${dragging
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                    }`}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onClick={() => document.getElementById('prop-file-upload')?.click()}
            >
                <Upload className="mx-auto h-6 w-6 text-muted-foreground mb-1" />
                <p className="text-sm font-medium">Dokument hochladen</p>
            </div>

            {/* Upload confirmation modal */}
            {showUpload && selectedFile && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <Card className="w-full max-w-md mx-4">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-lg">Dokument hochladen</CardTitle>
                            <Button variant="ghost" size="sm" onClick={() => { setShowUpload(false); setSelectedFile(null); }}>
                                <X className="h-4 w-4" />
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="p-3 bg-muted rounded-md text-sm">
                                <FileText className="inline h-4 w-4 mr-2" />
                                {selectedFile.name}
                            </div>
                            <div className="p-3 bg-muted rounded-md text-sm flex items-center gap-2">
                                <FolderOpen className="h-4 w-4" />
                                <span className="font-medium">{property.address}</span>
                                {property.shortCode && (
                                    <Badge variant="secondary" className="text-xs">{property.shortCode}</Badge>
                                )}
                            </div>
                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" onClick={() => { setShowUpload(false); setSelectedFile(null); }}>
                                    Abbrechen
                                </Button>
                                <Button onClick={handleUpload} disabled={uploading}>
                                    {uploading ? 'Wird hochgeladen...' : 'Bestätigen'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}
