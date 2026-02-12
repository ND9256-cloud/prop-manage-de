'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getSupabaseAdmin } from '@/lib/supabase';
import { revalidatePath } from 'next/cache';
import { extractServiceProvider, extractTextFromPdf } from '@/lib/extract-service-provider';

const BUCKET = 'documents';

// Ensure the storage bucket exists (idempotent)
async function ensureBucket() {
    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Supabase not configured');
    const { data: buckets } = await sb.storage.listBuckets();
    if (!buckets?.find((b) => b.name === BUCKET)) {
        await sb.storage.createBucket(BUCKET, { public: false });
    }
    return sb;
}

// Upload a document for a property
export async function uploadDocument(formData: FormData) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });
    if (!user?.organizationId) throw new Error('No organization');

    const propertyId = formData.get('propertyId') as string;
    const docType = (formData.get('type') as string) || 'other';
    const file = formData.get('file') as File;

    if (!propertyId || !file) throw new Error('Missing propertyId or file');

    // Verify property belongs to user's org
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: user.organizationId },
    });
    if (!property) throw new Error('Property not found');

    const sb = await ensureBucket();

    // Build a unique storage path
    const ext = file.name.split('.').pop() || 'bin';
    const storagePath = `${user.organizationId}/${propertyId}/${Date.now()}.${ext}`;

    // Upload to Supabase Storage
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(storagePath, arrayBuffer, {
            contentType: file.type,
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // Save metadata to DB
    await prisma.document.create({
        data: {
            name: file.name,
            type: docType,
            storagePath,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream',
            propertyId,
        },
    });

    // --- AI Extraction: try to extract service provider data ---
    let extracted: string | null = null;
    try {
        let text = '';
        if (file.type === 'application/pdf') {
            text = await extractTextFromPdf(arrayBuffer);
        } else if (file.type.startsWith('text/')) {
            text = new TextDecoder().decode(arrayBuffer);
        }

        if (text.length > 50) {
            const result = await extractServiceProvider(text);
            if (result.found && result.name && result.category) {
                await prisma.serviceProvider.create({
                    data: {
                        name: result.name,
                        category: result.category,
                        contractNumber: result.contractNumber ?? null,
                        monthlyCost: result.monthlyCost ?? null,
                        yearlyCost: result.yearlyCost ?? null,
                        contactName: result.contactName ?? null,
                        contactPhone: result.contactPhone ?? null,
                        contactEmail: result.contactEmail ?? null,
                        propertyId,
                    },
                });
                extracted = result.name;
            }
        }
    } catch (err) {
        console.error('AI extraction error (non-fatal):', err);
    }

    revalidatePath(`/dashboard/properties/${propertyId}`);
    return { success: true, extracted };
}

// Delete a document
export async function deleteDocument(documentId: string) {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });
    if (!user?.organizationId) throw new Error('No organization');

    const doc = await prisma.document.findUnique({
        where: { id: documentId },
        include: { property: { select: { organizationId: true } } },
    });

    if (!doc || doc.property.organizationId !== user.organizationId) {
        throw new Error('Document not found');
    }

    // Remove from storage
    const sb = getSupabaseAdmin();
    if (sb) {
        await sb.storage.from(BUCKET).remove([doc.storagePath]);
    }

    // Remove from DB
    await prisma.document.delete({ where: { id: documentId } });

    revalidatePath(`/dashboard/properties/${doc.propertyId}`);
    return { success: true };
}

// Get a signed download URL for a document
export async function getDocumentUrl(documentId: string): Promise<string> {
    const session = await auth();
    if (!session?.user?.email) throw new Error('Not authenticated');

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { organizationId: true },
    });
    if (!user?.organizationId) throw new Error('No organization');

    const doc = await prisma.document.findUnique({
        where: { id: documentId },
        include: { property: { select: { organizationId: true } } },
    });

    if (!doc || doc.property.organizationId !== user.organizationId) {
        throw new Error('Document not found');
    }

    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Supabase not configured');

    const { data, error } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(doc.storagePath, 3600); // 1 hour

    if (error || !data?.signedUrl) throw new Error('Failed to create URL');

    return data.signedUrl;
}
