'use server';

import { getSupabaseAdmin } from '@/lib/supabase';
import { revalidatePath } from 'next/cache';
import { getOrgContext, getOrgContextWritable } from '@/lib/org';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

const BUCKET = 'property-documents';

// Upload a document for a property → warehouse.documents + processing_jobs
export async function uploadDocument(formData: FormData) {
    const { orgId, userId } = await getOrgContextWritable();

    const propertyId = formData.get('propertyId') as string;
    const file = formData.get('file') as File;

    if (!propertyId || !file) throw new Error('Missing propertyId or file');

    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Supabase not configured');

    const documentId = randomUUID();
    const arrayBuffer = await file.arrayBuffer();
    const fileHash = createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex');
    const storagePath = `${orgId}/${documentId}/${file.name}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(storagePath, arrayBuffer, {
            contentType: file.type,
            upsert: false,
        });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // Insert into warehouse.documents
    const { error: docError } = await sb
        .schema('warehouse')
        .from('documents')
        .insert({
            id: documentId,
            org_id: orgId,
            uploader_id: userId,
            source: 'ui',
            file_name: file.name,
            file_hash: fileHash,
            file_size_bytes: file.size,
            mime_type: file.type || 'application/octet-stream',
            storage_path: storagePath,
            status: 'queued',
        });

    if (docError) throw new Error(`Document insert failed: ${docError.message}`);

    // Insert processing job so the pipeline picks it up
    const { error: jobError } = await sb
        .schema('warehouse')
        .from('processing_jobs')
        .insert({
            document_id: documentId,
            org_id: orgId,
            status: 'queued',
        });

    if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);

    revalidatePath(`/dashboard/properties/${propertyId}`);
    return { success: true, extracted: null as string | null };
}

// Delete a document from warehouse.documents and storage
export async function deleteDocument(documentId: string) {
    const { orgId } = await getOrgContextWritable();

    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Supabase not configured');

    // Fetch the document (RLS scopes to org via service role setting current_org_id)
    const { data: doc, error: fetchError } = await sb
        .schema('warehouse')
        .from('documents')
        .select('id, storage_path, org_id')
        .eq('id', documentId)
        .eq('org_id', orgId)
        .single();

    if (fetchError || !doc) throw new Error('Document not found');

    // Remove from storage
    await sb.storage.from(BUCKET).remove([doc.storage_path]);

    // Remove from warehouse.documents
    const { error: deleteError } = await sb
        .schema('warehouse')
        .from('documents')
        .delete()
        .eq('id', documentId)
        .eq('org_id', orgId);

    if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);

    return { success: true };
}

// Get a signed download URL for a warehouse document
export async function getDocumentUrl(documentId: string): Promise<string> {
    const { orgId } = await getOrgContext();

    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Supabase not configured');

    const { data: doc, error: fetchError } = await sb
        .schema('warehouse')
        .from('documents')
        .select('storage_path, org_id')
        .eq('id', documentId)
        .eq('org_id', orgId)
        .single();

    if (fetchError || !doc) throw new Error('Document not found');

    const { data, error } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(doc.storage_path, 3600);

    if (error || !data?.signedUrl) throw new Error('Failed to create URL');

    return data.signedUrl;
}
