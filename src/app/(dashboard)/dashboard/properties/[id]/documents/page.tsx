
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import DocumentBrowserWrapper from '@/components/documents/document-browser-wrapper';
import {
    createFolder,
    uploadDocument,
    deleteDocument,
    getDocumentDownloadUrl,
    getPropertyDocuments,
    getPropertyFolders,
} from '@/lib/document-actions';
import { processDocumentForAI } from '@/lib/ai-actions';

interface PageProps {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ folderId?: string }>;
}

export default async function PropertyDocumentsPage({ params, searchParams }: PageProps) {
    const { id: propertyId } = await params;
    const { folderId } = await searchParams;

    const session = await auth();
    if (!session?.user?.email) {
        notFound();
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) {
        notFound();
    }

    // Get property
    const property = await prisma.property.findFirst({
        where: {
            id: propertyId,
            organizationId: user.organizationId,
        },
    });

    if (!property) {
        notFound();
    }

    // Get folders and documents
    const folders = await getPropertyFolders(propertyId, folderId);
    const rawDocuments = await getPropertyDocuments(propertyId, folderId);

    // Check AI processing status for each document
    const documentsWithAIStatus = await Promise.all(
        rawDocuments.map(async (doc) => {
            const chunkCount = await prisma.documentChunk.count({
                where: { documentId: doc.id },
            });
            return {
                ...doc,
                isProcessedForAI: chunkCount > 0,
            };
        })
    );

    // Build breadcrumbs
    const breadcrumbs: { id: string | null; name: string }[] = [{ id: null, name: 'Stammordner' }];

    if (folderId) {
        // Build folder path
        let currentFolder = await prisma.folder.findUnique({
            where: { id: folderId },
            select: { id: true, name: true, parentId: true },
        });

        const path: { id: string | null; name: string }[] = [];
        while (currentFolder) {
            path.unshift({ id: currentFolder.id, name: currentFolder.name });
            if (currentFolder.parentId) {
                currentFolder = await prisma.folder.findUnique({
                    where: { id: currentFolder.parentId },
                    select: { id: true, name: true, parentId: true },
                });
            } else {
                currentFolder = null;
            }
        }
        breadcrumbs.push(...path);
    }

    // Server action wrappers for client component
    async function handleCreateFolder(formData: FormData) {
        'use server';
        await createFolder(formData);
    }

    async function handleUploadDocument(formData: FormData) {
        'use server';
        await uploadDocument(formData);
    }

    async function handleDeleteDocument(documentId: string) {
        'use server';
        await deleteDocument(documentId);
    }

    async function handleDownloadDocument(documentId: string) {
        'use server';
        return await getDocumentDownloadUrl(documentId);
    }

    async function handleProcessForAI(documentId: string) {
        'use server';
        return await processDocumentForAI(documentId);
    }

    return (
        <main className="p-6">
            <div className="mb-6">
                <h1 className="text-2xl font-bold">{property.name}</h1>
                <p className="text-muted-foreground">{property.address}, {property.zip} {property.city}</p>
            </div>

            <DocumentBrowserWrapper
                propertyId={propertyId}
                propertyName={property.name}
                folders={folders}
                documents={documentsWithAIStatus}
                currentFolderId={folderId}
                breadcrumbs={breadcrumbs}
                onCreateFolder={handleCreateFolder}
                onUploadDocument={handleUploadDocument}
                onDeleteDocument={handleDeleteDocument}
                onDownloadDocument={handleDownloadDocument}
                onProcessForAI={handleProcessForAI}
            />
        </main>
    );
}
