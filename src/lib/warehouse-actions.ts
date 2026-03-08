'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getSupabaseAdmin } from '@/lib/supabase';
import { CATEGORIES } from '@/lib/warehouse-categories';

async function getOrgId(): Promise<string | null> {
    const session = await auth();
    if (!session?.user?.email) return null;
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { organization: true },
    });
    return user?.organizationId || null;
}

export async function getWarehouseOverview() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', stats: null, propertyCards: [] };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured', stats: null, propertyCards: [] };

    // Fetch all documents for this org
    const { data: docs } = await supabase
        .schema('warehouse')
        .from('documents')
        .select('id, status, property_id, category, created_at')
        .eq('org_id', orgId)
        .neq('status', 'deleted');

    const allDocs = docs || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Global stats
    const stats = {
        total: allDocs.length,
        needs_review: allDocs.filter(d => d.status === 'needs_review').length,
        applied_this_month: allDocs.filter(
            d => d.status === 'applied' && d.created_at >= monthStart
        ).length,
        properties_with_docs: new Set(
            allDocs.filter(d => d.property_id).map(d => d.property_id)
        ).size,
    };

    // Fetch all properties
    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
    });

    // Build per-property card data
    const propertyCards = properties.map(p => {
        const propDocs = allDocs.filter(d => d.property_id === p.id);
        const needsReview = propDocs.filter(d => d.status === 'needs_review').length;
        const appliedThisMonth = propDocs.filter(
            d => d.status === 'applied' && d.created_at >= monthStart
        ).length;
        const categories = new Set(propDocs.filter(d => d.category).map(d => d.category));

        let statusDot: 'red' | 'green' | 'gray' = 'gray';
        if (propDocs.length === 0) statusDot = 'gray';
        else if (needsReview > 0) statusDot = 'red';
        else statusDot = 'green';

        return {
            id: p.id,
            name: p.name,
            address: p.address,
            shortCode: (p as Record<string, unknown>).short_code as string | null,
            totalDocs: propDocs.length,
            needsReview,
            appliedThisMonth,
            categoriesUsed: categories.size,
            statusDot,
        };
    });

    return { error: null, stats, propertyCards };
}

export async function getOpenReviewCount() {
    const orgId = await getOrgId();
    if (!orgId) return 0;

    const supabase = getSupabaseAdmin();
    if (!supabase) return 0;

    const { data } = await supabase
        .schema('warehouse')
        .from('review_tasks')
        .select('id')
        .eq('org_id', orgId)
        .eq('status', 'open');

    return data?.length || 0;
}

export async function getWarehouseStats() {
    const orgId = await getOrgId();
    if (!orgId) return { needs_review: 0, processing: 0, applied: 0, queued: 0 };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { needs_review: 0, processing: 0, applied: 0, queued: 0 };

    const { data } = await supabase
        .schema('warehouse')
        .from('documents')
        .select('status')
        .eq('org_id', orgId);

    const d = data || [];
    return {
        needs_review: d.filter(x => x.status === 'needs_review').length,
        processing: d.filter(x => x.status === 'processing').length,
        applied: d.filter(x => x.status === 'applied').length,
        queued: d.filter(x => x.status === 'queued').length,
    };
}

export async function getWarehouseDocuments() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', documents: [] };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured', documents: [] };

    const { data, error } = await supabase
        .schema('warehouse')
        .from('documents')
        .select('id, file_name, doc_type, source, status, mime_type, file_size_bytes, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });

    if (error) return { error: error.message, documents: [] };
    return { error: null, documents: data || [] };
}


export async function getPropertyWarehouseDetail(propertyId: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', property: null, folders: [], stats: null, unassignedCount: 0 };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured', property: null, folders: [], stats: null, unassignedCount: 0 };

    // Fetch property
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
    });
    if (!property) return { error: 'Property not found', property: null, folders: [], stats: null, unassignedCount: 0 };

    // Fetch all docs for this property
    const { data: docs } = await supabase
        .schema('warehouse')
        .from('documents')
        .select('id, status, category, file_size_bytes, created_at')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .neq('status', 'deleted');

    const allDocs = docs || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Build folder stats
    const folders = CATEGORIES.map(cat => {
        const catDocs = allDocs.filter(d => d.category === cat.key);
        const needsReview = catDocs.filter(d => d.status === 'needs_review').length;
        const totalSize = catDocs.reduce((s, d) => s + (d.file_size_bytes || 0), 0);
        const mostRecent = catDocs.length > 0
            ? catDocs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0].created_at
            : null;

        return {
            ...cat,
            count: catDocs.length,
            needsReview,
            totalSize,
            mostRecent,
        };
    });

    // Unassigned docs
    const unassignedCount = allDocs.filter(d => !d.category).length;

    // Property stats
    const needsReview = allDocs.filter(d => d.status === 'needs_review');
    const oldestUnreviewed = needsReview.length > 0
        ? needsReview.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0].created_at
        : null;

    const stats = {
        total: allDocs.length,
        needsReview: needsReview.length,
        appliedThisMonth: allDocs.filter(d => d.status === 'applied' && d.created_at >= monthStart).length,
        oldestUnreviewed,
    };

    return {
        error: null,
        property: {
            id: property.id,
            name: property.name,
            address: property.address,
            shortCode: (property as Record<string, unknown>).short_code as string | null,
        },
        folders,
        stats,
        unassignedCount,
    };
}

export async function uploadWarehouseDocument(formData: FormData) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated' };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured' };

    const file = formData.get('file') as File | null;
    if (!file) return { error: 'No file provided' };

    const documentId = crypto.randomUUID();
    const sanitisedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${orgId}/${documentId}/${sanitisedName}`;

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Upload to storage
    const { error: uploadError } = await supabase.storage
        .from('property-documents')
        .upload(storagePath, bytes, {
            contentType: file.type,
            upsert: false,
        });

    if (uploadError) return { error: `Upload failed: ${uploadError.message}` };

    // Compute hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    const fileHash = Array.from(hashArray)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    // Insert document
    const propertyId = formData.get('propertyId') as string | null;
    const { error: docError } = await supabase
        .schema('warehouse')
        .from('documents')
        .insert({
            id: documentId,
            org_id: orgId,
            source: 'ui',
            source_ref: `ui-${documentId}`,
            file_name: sanitisedName,
            file_hash: fileHash,
            file_size_bytes: file.size,
            mime_type: file.type,
            storage_path: storagePath,
            status: 'queued',
            ...(propertyId ? { property_id: propertyId } : {}),
        });

    if (docError) return { error: `Document insert failed: ${docError.message}` };

    // Insert processing job
    await supabase
        .schema('warehouse')
        .from('processing_jobs')
        .insert({
            document_id: documentId,
            org_id: orgId,
            status: 'queued',
            next_attempt_at: new Date().toISOString(),
        });

    return { error: null, documentId };
}

export async function getReviewTasks() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', tasks: [] };

    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured', tasks: [] };

    const { data: tasks, error } = await supabase
        .schema('warehouse')
        .from('review_tasks')
        .select('*')
        .eq('org_id', orgId)
        .eq('status', 'open')
        .order('created_at', { ascending: false });

    if (error) return { error: error.message, tasks: [] };

    // For each task, get document and extraction
    const enrichedTasks = await Promise.all(
        (tasks || []).map(async (task: Record<string, unknown>) => {
            const { data: doc } = await supabase
                .schema('warehouse')
                .from('documents')
                .select('file_name, doc_type, source, mime_type')
                .eq('id', task.document_id as string)
                .single();

            const { data: extraction } = await supabase
                .schema('warehouse')
                .from('document_extractions')
                .select('id, extracted_fields, confidence_score, flags')
                .eq('document_id', task.document_id as string)
                .eq('is_current', true)
                .single();

            return {
                ...task,
                document: doc,
                extraction,
            };
        })
    );

    return { error: null, tasks: enrichedTasks };
}

export async function applyReviewTask(
    documentId: string,
    extractionId: string,
    orgId: string,
    docType: string,
    extractedFields: Record<string, unknown>,
    propertyId?: string,
    unitId?: string,
) {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured' };

    const session = await auth();
    let userId: string | null = null;
    if (session?.user?.email) {
        const dbUser = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
        userId = dbUser?.id || null;
    }

    const payload = {
        ...extractedFields,
        ...(propertyId ? { property_id: propertyId } : {}),
        ...(unitId ? { unit_id: unitId } : {}),
    };

    const action = docType === 'lease' ? 'lease.create' : 'ledger.append';
    const idempotencyKey = `${documentId}_${extractionId}_confirmed`;

    // Call connector.apply() via direct SQL (connector schema not exposed via REST)
    try {
        const result = await prisma.$queryRawUnsafe<{ apply: string }[]>(
            `SELECT connector.apply(
                $1::UUID, $2::UUID, $3::UUID, $4::TEXT, $5::JSONB,
                $6::TEXT, $7::TEXT, $8::TEXT
            ) as apply`,
            orgId, documentId, extractionId, action,
            JSON.stringify(payload),
            userId, 'user_confirmed', idempotencyKey,
        );

        const applyResult = typeof result[0]?.apply === 'string'
            ? JSON.parse(result[0].apply)
            : result[0]?.apply;

        if (!applyResult?.success) {
            return { error: applyResult?.error || 'Apply failed' };
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { error: `Apply failed: ${msg}` };
    }

    // Mark review task as resolved
    await supabase
        .schema('warehouse')
        .from('review_tasks')
        .update({ status: 'resolved' })
        .eq('document_id', documentId)
        .eq('status', 'open');

    return { error: null };
}

export async function dismissReviewTask(taskId: string) {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { error: 'Supabase not configured' };

    const { error } = await supabase
        .schema('warehouse')
        .from('review_tasks')
        .update({ status: 'dismissed' })
        .eq('id', taskId);

    if (error) return { error: error.message };
    return { error: null };
}

export async function getProperties() {
    const orgId = await getOrgId();
    if (!orgId) return [];

    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
        include: { units: { select: { id: true, unitNumber: true } } },
        orderBy: { name: 'asc' },
    });

    return properties.map(p => ({
        id: p.id,
        name: p.name,
        units: p.units.map(u => ({ id: u.id, unitNumber: u.unitNumber })),
    }));
}
