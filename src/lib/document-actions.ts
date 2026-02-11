
'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { uploadFile, deleteFile, getSignedUrl } from '@/lib/storage';
import { revalidatePath } from 'next/cache';

/**
 * Create a new folder
 */
export async function createFolder(formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const name = formData.get('name') as string;
    const propertyId = formData.get('propertyId') as string | null;
    const unitId = formData.get('unitId') as string | null;
    const parentId = formData.get('parentId') as string | null;

    const folder = await prisma.folder.create({
        data: {
            name,
            propertyId: propertyId || undefined,
            unitId: unitId || undefined,
            parentId: parentId || undefined,
            organizationId: user.organizationId,
        },
    });

    if (propertyId) {
        revalidatePath(`/dashboard/properties/${propertyId}/documents`);
    }

    return folder;
}

/**
 * Upload a document
 */
export async function uploadDocument(formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const file = formData.get('file') as File;
    const propertyId = formData.get('propertyId') as string | null;
    const unitId = formData.get('unitId') as string | null;
    const folderId = formData.get('folderId') as string | null;
    const type = formData.get('type') as string | null;
    const description = formData.get('description') as string | null;

    if (!file) throw new Error('No file provided');

    console.log(`[Upload] Starting upload for: ${file.name} (${file.size} bytes, ${file.type})`);

    try {
        // Upload to Supabase Storage
        const { path } = await uploadFile(
            file,
            user.organizationId,
            propertyId || undefined,
            unitId || undefined
        );

        console.log(`[Upload] Storage upload successful: ${path}`);

        // Create document record in database
        const document = await prisma.document.create({
            data: {
                name: file.name,
                storagePath: path,
                mimeType: file.type || 'application/octet-stream',
                sizeBytes: file.size,
                type: type || undefined,
                description: description || undefined,
                propertyId: propertyId || undefined,
                unitId: unitId || undefined,
                folderId: folderId || undefined,
                organizationId: user.organizationId,
                uploadedById: user.id,
            },
        });

        console.log(`[Upload] Database record created: ${document.id}`);

        if (propertyId) {
            revalidatePath(`/dashboard/properties/${propertyId}/documents`);
        }

        return document;
    } catch (error) {
        console.error('[Upload] Failed:', error);
        throw error;
    }
}

/**
 * Get documents for a property
 */
export async function getPropertyDocuments(propertyId: string, folderId?: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const documents = await prisma.document.findMany({
        where: {
            propertyId,
            folderId: folderId || null,
            organizationId: user.organizationId,
            isLatest: true,
        },
        orderBy: { createdAt: 'desc' },
        include: {
            uploadedBy: { select: { name: true, email: true } },
        },
    });

    return documents;
}

/**
 * Get folders for a property
 */
export async function getPropertyFolders(propertyId: string, parentId?: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const folders = await prisma.folder.findMany({
        where: {
            propertyId,
            parentId: parentId || null,
            organizationId: user.organizationId,
        },
        orderBy: { name: 'asc' },
        include: {
            _count: {
                select: { documents: true, children: true },
            },
        },
    });

    return folders;
}

/**
 * Delete a document
 */
export async function deleteDocument(documentId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    // Find document
    const document = await prisma.document.findFirst({
        where: {
            id: documentId,
            organizationId: user.organizationId,
        },
    });

    if (!document) throw new Error('Document not found');

    // Delete from storage
    await deleteFile(document.storagePath);

    // Delete from database
    await prisma.document.delete({ where: { id: documentId } });

    if (document.propertyId) {
        revalidatePath(`/dashboard/properties/${document.propertyId}/documents`);
    }
}

/**
 * Get a signed download URL for a document
 */
export async function getDocumentDownloadUrl(documentId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });

    if (!user?.organizationId) throw new Error('User not in organization');

    const document = await prisma.document.findFirst({
        where: {
            id: documentId,
            organizationId: user.organizationId,
        },
    });

    if (!document) throw new Error('Document not found');

    const signedUrl = await getSignedUrl(document.storagePath);
    return signedUrl;
}
