
'use client';

import { useState, useEffect } from 'react';
import { Folder, FileText, Upload, FolderPlus, Trash2, Download, MoreVertical, ChevronRight, Sparkles, Loader2, MessageSquare, Brain, Eye, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

interface FolderType {
    id: string;
    name: string;
    _count: { documents: number; children: number };
}

interface DocumentType {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    type: string | null;
    createdAt: Date;
    uploadedBy: { name: string | null; email: string } | null;
    isProcessedForAI?: boolean;
}

interface DocumentBrowserProps {
    propertyId: string;
    propertyName: string;
    folders: FolderType[];
    documents: DocumentType[];
    currentFolderId?: string;
    breadcrumbs: { id: string | null; name: string }[];
    onCreateFolder: (formData: FormData) => Promise<void>;
    onUploadDocument: (formData: FormData) => Promise<void>;
    onDeleteDocument: (documentId: string) => Promise<void>;
    onDownloadDocument: (documentId: string) => Promise<string>;
    onProcessForAI: (documentId: string) => Promise<{ chunksCreated: number }>;
    onNavigateToFolder: (folderId: string | null) => void;
}

export default function DocumentBrowser({
    propertyId,
    propertyName,
    folders,
    documents,
    currentFolderId,
    breadcrumbs,
    onCreateFolder,
    onUploadDocument,
    onDeleteDocument,
    onDownloadDocument,
    onProcessForAI,
    onNavigateToFolder,
}: DocumentBrowserProps) {
    const [isUploading, setIsUploading] = useState(false);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [processingDocId, setProcessingDocId] = useState<string | null>(null);
    const [processedDocs, setProcessedDocs] = useState<Set<string>>(
        new Set(documents.filter(d => d.isProcessedForAI).map(d => d.id))
    );
    const [previewDoc, setPreviewDoc] = useState<{ name: string; mimeType: string; url: string } | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);

    // Close preview on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && previewDoc) setPreviewDoc(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewDoc]);

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const getFileIcon = (mimeType: string) => {
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType === 'application/pdf') return '📄';
        if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
        if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
        return '📎';
    };

    const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setIsUploading(true);
        setUploadProgress({ current: 0, total: files.length });
        setUploadError(null);

        let successCount = 0;
        let errorCount = 0;

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                setUploadProgress({ current: i + 1, total: files.length });

                try {
                    const formData = new FormData();
                    formData.set('file', file);
                    formData.set('propertyId', propertyId);
                    if (currentFolderId) formData.set('folderId', currentFolderId);
                    await onUploadDocument(formData);
                    successCount++;
                } catch (err) {
                    console.error(`Failed to upload ${file.name}:`, err);
                    errorCount++;
                }
            }

            if (errorCount > 0) {
                setUploadError(`${successCount} hochgeladen, ${errorCount} fehlgeschlagen`);
            }
        } finally {
            setIsUploading(false);
            setUploadProgress(null);
            // Reset file input
            e.target.value = '';
        }
    };

    const handleCreateFolder = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        formData.set('propertyId', propertyId);
        if (currentFolderId) formData.set('parentId', currentFolderId);
        await onCreateFolder(formData);
        setIsCreatingFolder(false);
    };

    const handleDownload = async (documentId: string) => {
        const url = await onDownloadDocument(documentId);
        window.open(url, '_blank');
    };

    const handleProcessForAI = async (documentId: string) => {
        setProcessingDocId(documentId);
        try {
            await onProcessForAI(documentId);
            setProcessedDocs(prev => new Set([...prev, documentId]));
        } finally {
            setProcessingDocId(null);
        }
    };

    const handlePreview = async (doc: DocumentType) => {
        setIsLoadingPreview(true);
        try {
            const url = await onDownloadDocument(doc.id);
            setPreviewDoc({ name: doc.name, mimeType: doc.mimeType, url });
        } catch (err) {
            console.error('Preview failed:', err);
        } finally {
            setIsLoadingPreview(false);
        }
    };

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle className="flex items-center gap-2">
                        <Folder className="h-5 w-5" />
                        Dokumente - {propertyName}
                    </CardTitle>
                    {/* Breadcrumbs */}
                    <div className="flex items-center gap-1 mt-2 text-sm text-muted-foreground">
                        {breadcrumbs.map((crumb, index) => (
                            <span key={crumb.id || 'root'} className="flex items-center gap-1">
                                {index > 0 && <ChevronRight className="h-4 w-4" />}
                                <button
                                    onClick={() => onNavigateToFolder(crumb.id)}
                                    className="hover:underline"
                                >
                                    {crumb.name}
                                </button>
                            </span>
                        ))}
                    </div>
                </div>
                <div className="flex gap-2">
                    <Link href={`/dashboard/properties/${propertyId}/chat`}>
                        <Button variant="outline" size="sm">
                            <MessageSquare className="h-4 w-4 mr-2" />
                            KI-Chat
                        </Button>
                    </Link>

                    <Dialog open={isCreatingFolder} onOpenChange={setIsCreatingFolder}>
                        <DialogTrigger asChild>
                            <Button variant="outline" size="sm">
                                <FolderPlus className="h-4 w-4 mr-2" />
                                Neuer Ordner
                            </Button>
                        </DialogTrigger>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Neuen Ordner erstellen</DialogTitle>
                            </DialogHeader>
                            <form onSubmit={handleCreateFolder} className="space-y-4">
                                <div>
                                    <Label htmlFor="folderName">Ordnername</Label>
                                    <Input id="folderName" name="name" placeholder="Ordnername eingeben" required />
                                </div>
                                <Button type="submit">Ordner erstellen</Button>
                            </form>
                        </DialogContent>
                    </Dialog>

                    <Button size="sm" disabled={isUploading} asChild>
                        <label className="cursor-pointer flex items-center">
                            <Upload className="h-4 w-4 mr-2" />
                            {uploadProgress
                                ? `${uploadProgress.current}/${uploadProgress.total}`
                                : 'Dateien'}
                            <input
                                type="file"
                                className="hidden"
                                onChange={handleFileUpload}
                                disabled={isUploading}
                                multiple
                            />
                        </label>
                    </Button>
                    <Button size="sm" variant="outline" disabled={isUploading} asChild>
                        <label className="cursor-pointer flex items-center">
                            <Folder className="h-4 w-4 mr-2" />
                            {uploadProgress
                                ? `${uploadProgress.current}/${uploadProgress.total}`
                                : 'Ordner'}
                            <input
                                type="file"
                                className="hidden"
                                onChange={handleFileUpload}
                                disabled={isUploading}
                                {...{ webkitdirectory: '', directory: '' } as any}
                            />
                        </label>
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                {/* Upload Progress/Error */}
                {uploadProgress && (
                    <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                        <span className="text-sm text-blue-800">
                            Lade hoch: {uploadProgress.current} von {uploadProgress.total} Dateien...
                        </span>
                    </div>
                )}
                {uploadError && (
                    <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                        <span className="text-sm text-yellow-800">{uploadError}</span>
                    </div>
                )}
                <div className="space-y-2">
                    {/* Folders */}
                    {folders.map((folder) => (
                        <div
                            key={folder.id}
                            className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent cursor-pointer"
                            onClick={() => onNavigateToFolder(folder.id)}
                        >
                            <div className="flex items-center gap-3">
                                <Folder className="h-5 w-5 text-blue-500" />
                                <span className="font-medium">{folder.name}</span>
                                <span className="text-sm text-muted-foreground">
                                    {folder._count.documents} Dateien, {folder._count.children} Ordner
                                </span>
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                    ))}

                    {/* Documents */}
                    {documents.map((doc) => {
                        const isProcessed = processedDocs.has(doc.id) || doc.isProcessedForAI;
                        const isProcessing = processingDocId === doc.id;

                        return (
                            <div
                                key={doc.id}
                                className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">{getFileIcon(doc.mimeType)}</span>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => handlePreview(doc)}
                                                className="font-medium hover:underline text-left cursor-pointer"
                                            >
                                                {doc.name}
                                            </button>
                                            {isProcessed && (
                                                <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-700">
                                                    <Brain className="h-3 w-3 mr-1" />
                                                    KI
                                                </Badge>
                                            )}
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {formatFileSize(doc.sizeBytes)} • {new Date(doc.createdAt).toLocaleDateString('de-DE')}
                                            {doc.uploadedBy && ` • ${doc.uploadedBy.name || doc.uploadedBy.email}`}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {!isProcessed && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleProcessForAI(doc.id)}
                                            disabled={isProcessing}
                                        >
                                            {isProcessing ? (
                                                <>
                                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                    Verarbeitung...
                                                </>
                                            ) : (
                                                <>
                                                    <Sparkles className="h-4 w-4 mr-2" />
                                                    Für KI verarbeiten
                                                </>
                                            )}
                                        </Button>
                                    )}
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="sm">
                                                <MoreVertical className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handlePreview(doc)}>
                                                <Eye className="h-4 w-4 mr-2" />
                                                Vorschau
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => handleDownload(doc.id)}>
                                                <Download className="h-4 w-4 mr-2" />
                                                Herunterladen
                                            </DropdownMenuItem>
                                            {!isProcessed && (
                                                <DropdownMenuItem onClick={() => handleProcessForAI(doc.id)}>
                                                    <Sparkles className="h-4 w-4 mr-2" />
                                                    Für KI verarbeiten
                                                </DropdownMenuItem>
                                            )}
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                className="text-red-600"
                                                onClick={() => onDeleteDocument(doc.id)}
                                            >
                                                <Trash2 className="h-4 w-4 mr-2" />
                                                Löschen
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>
                        );
                    })}

                    {folders.length === 0 && documents.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground">
                            <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                            <p>Noch keine Dateien oder Ordner</p>
                            <p className="text-sm">Laden Sie Dateien hoch oder erstellen Sie Ordner</p>
                        </div>
                    )}
                </div>
            </CardContent>

            {/* Document Preview Modal */}
            {previewDoc && (
                <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 bg-gray-900 text-white">
                        <h3 className="text-lg font-medium truncate max-w-[60%]">{previewDoc.name}</h3>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-white hover:bg-white/20"
                                onClick={() => window.open(previewDoc.url, '_blank')}
                            >
                                <Download className="h-4 w-4 mr-2" />
                                Herunterladen
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-white hover:bg-white/20"
                                onClick={() => setPreviewDoc(null)}
                            >
                                <X className="h-5 w-5" />
                            </Button>
                        </div>
                    </div>
                    {/* Content */}
                    <div className="flex-1 overflow-auto flex items-center justify-center p-4">
                        {previewDoc.mimeType === 'application/pdf' ? (
                            <iframe
                                src={previewDoc.url}
                                className="w-full h-full rounded-lg"
                                title={previewDoc.name}
                            />
                        ) : previewDoc.mimeType.startsWith('image/') ? (
                            <img
                                src={previewDoc.url}
                                alt={previewDoc.name}
                                className="max-w-full max-h-full object-contain rounded-lg"
                            />
                        ) : (
                            <div className="text-center text-white space-y-4">
                                <FileText className="h-16 w-16 mx-auto opacity-50" />
                                <p>Vorschau für diesen Dateityp nicht verfügbar</p>
                                <Button
                                    variant="outline"
                                    className="text-white border-white hover:bg-white/20"
                                    onClick={() => window.open(previewDoc.url, '_blank')}
                                >
                                    <Download className="h-4 w-4 mr-2" />
                                    Datei herunterladen
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Preview loading indicator */}
            {isLoadingPreview && (
                <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
                    <div className="bg-white rounded-lg p-6 flex items-center gap-3">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>Vorschau wird geladen...</span>
                    </div>
                </div>
            )}
        </Card>
    );
}
