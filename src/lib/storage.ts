
import { supabase, supabaseAdmin } from '@/lib/supabase';

const BUCKET_NAME = 'documents';

export interface UploadResult {
    path: string;
    publicUrl: string;
}

/**
 * Sanitize filename by removing special characters and spaces
 */
function sanitizeFilename(filename: string): string {
    // Replace German umlauts and other special characters
    const replacements: Record<string, string> = {
        'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
        'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue',
        ' ': '_',
    };

    let sanitized = filename;
    for (const [char, replacement] of Object.entries(replacements)) {
        sanitized = sanitized.split(char).join(replacement);
    }

    // Remove any remaining non-ASCII characters
    return sanitized.replace(/[^\x00-\x7F]/g, '');
}

/**
 * Upload a file to Supabase Storage
 * @param file - File to upload
 * @param organizationId - Organization ID for path scoping
 * @param propertyId - Optional property ID for path scoping
 * @param unitId - Optional unit ID for path scoping
 * @returns Upload result with path and public URL
 */
export async function uploadFile(
    file: File,
    organizationId: string,
    propertyId?: string,
    unitId?: string
): Promise<UploadResult> {
    // Use admin client to bypass RLS
    const client = supabaseAdmin || supabase;

    // Build path: org/property/unit/filename
    let path = `${organizationId}`;
    if (propertyId) path += `/${propertyId}`;
    if (unitId) path += `/${unitId}`;

    // Add timestamp and sanitize filename to avoid collisions and invalid chars
    const timestamp = Date.now();
    const sanitizedName = sanitizeFilename(file.name);
    const fileName = `${timestamp}-${sanitizedName}`;
    path += `/${fileName}`;

    const { data, error } = await client.storage
        .from(BUCKET_NAME)
        .upload(path, file, {
            cacheControl: '3600',
            upsert: false,
        });

    if (error) {
        throw new Error(`Upload failed: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = client.storage
        .from(BUCKET_NAME)
        .getPublicUrl(data.path);

    return {
        path: data.path,
        publicUrl: urlData.publicUrl,
    };
}

/**
 * Get a signed URL for private file access
 * @param storagePath - Path in storage bucket
 * @param expiresIn - Seconds until URL expires (default 1 hour)
 */
export async function getSignedUrl(
    storagePath: string,
    expiresIn: number = 3600
): Promise<string> {
    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(storagePath, expiresIn);

    if (error) {
        throw new Error(`Failed to create signed URL: ${error.message}`);
    }

    return data.signedUrl;
}

/**
 * Delete a file from storage
 * @param storagePath - Path in storage bucket
 */
export async function deleteFile(storagePath: string): Promise<void> {
    const client = supabaseAdmin || supabase;

    const { error } = await client.storage
        .from(BUCKET_NAME)
        .remove([storagePath]);

    if (error) {
        throw new Error(`Delete failed: ${error.message}`);
    }
}

/**
 * List files in a folder path
 * @param folderPath - Folder path in storage bucket
 */
export async function listFiles(folderPath: string) {
    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .list(folderPath, {
            limit: 100,
            offset: 0,
            sortBy: { column: 'name', order: 'asc' },
        });

    if (error) {
        throw new Error(`List failed: ${error.message}`);
    }

    return data;
}
