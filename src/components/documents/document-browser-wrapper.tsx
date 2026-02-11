
'use client';

import { useRouter } from 'next/navigation';
import DocumentBrowser from '@/components/documents/document-browser';

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

interface DocumentBrowserWrapperProps {
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
}

export default function DocumentBrowserWrapper({
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
}: DocumentBrowserWrapperProps) {
    const router = useRouter();

    const handleNavigateToFolder = (folderId: string | null) => {
        if (folderId) {
            router.push(`/dashboard/properties/${propertyId}/documents?folderId=${folderId}`);
        } else {
            router.push(`/dashboard/properties/${propertyId}/documents`);
        }
    };

    return (
        <DocumentBrowser
            propertyId={propertyId}
            propertyName={propertyName}
            folders={folders}
            documents={documents}
            currentFolderId={currentFolderId}
            breadcrumbs={breadcrumbs}
            onCreateFolder={onCreateFolder}
            onUploadDocument={onUploadDocument}
            onDeleteDocument={onDeleteDocument}
            onDownloadDocument={onDownloadDocument}
            onProcessForAI={onProcessForAI}
            onNavigateToFolder={handleNavigateToFolder}
        />
    );
}
