'use server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { warehouseDb } from '@/lib/warehouse/db';
import { CATEGORIES } from '@/lib/warehouse-categories';
import { getOrgId, getOrgContext, getOrgIdWritable } from '@/lib/org';
import { revalidatePath } from 'next/cache';

export interface InboxDocument {
    id: string;
    file_name: string;
    display_name: string | null;
    doc_type: string | null;
    status: string;
    source: 'email' | 'telegram' | 'ui';
    created_at: string;
    mime_type: string | null;
    file_size_bytes: number | null;
    property_id: string | null;
    category: string | null;
    subcategory: string | null;
    // Joined fields
    property_address: string | null;
    property_short_code: string | null;
    confidence_score: number | null;
    applied_by: string | null;
    applied_at: string | null;
}


// ─── Audit logging (silent — never throws) ────────────────────
export async function logAuditEvent({
    eventType,
    documentId,
    propertyId,
    unitId,
    metadata,
}: {
    eventType: string;
    documentId?: string;
    propertyId?: string;
    unitId?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    try {
        const orgId = await getOrgId();
        if (!orgId) return;

        const session = await auth();
        const email = session?.user?.email ?? 'system';
        let userId = 'system';
        if (email !== 'system') {
            const dbUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
            userId = dbUser?.id ?? 'system';
        }

        const db = warehouseDb(orgId);
        await db.admin.schema('shared').from('audit_log').insert({
            org_id: orgId,
            actor_user_id: userId,
            actor_email: email,
            event_type: eventType,
            document_id: documentId ?? null,
            property_id: propertyId ?? null,
            unit_id: unitId ?? null,
            metadata: metadata ?? {},
        });
    } catch (err) {
        console.error('[audit] Failed to log event:', err);
    }
}

export async function getWarehouseOverview() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', stats: null, propertyCards: [], role: 'viewer' as const };

    const db = warehouseDb(orgId);

    // Fetch role
    const ctx = await getOrgContext();
    const role = ctx.role;

    // Fetch all documents for this org
    const { data: docs } = await db.from('documents')
        .select('id, status, property_id, category, doc_type, created_at')
        .eq('org_id', orgId)
        .neq('status', 'deleted');

    const allDocs = docs || [];

    // Helper: classify a doc into a bucket
    const isPhoto = (d: { doc_type: string | null }) => d.doc_type === 'foto';
    const isUnknown = (d: { doc_type: string | null }) => d.doc_type === 'unknown';
    const isFailed = (d: { status: string }) => d.status === 'failed';

    // Bucket classification (excludes fotos and unknowns)
    const classifyBucket = (d: { category: string | null; doc_type: string | null }) => {
        if (isPhoto(d) || isUnknown(d)) return null;
        if (d.category === 'kosten_rechnungen' && !d.doc_type?.startsWith('versicherung')) return 'kosten';
        if (d.category === 'vertraege' || d.doc_type?.startsWith('versicherung')) return 'versicherungen_vertraege';
        if (d.category === 'behoerden') return 'behoerden';
        return 'sonstiges';
    };

    // Docs excluding fotos and unknowns for total count
    const countableDocs = allDocs.filter(d => !isPhoto(d) && !isUnknown(d));

    // Global stats
    const stats = {
        total: countableDocs.length,
        needs_review: countableDocs.filter(d => d.status === 'needs_review').length,
        applied_this_month: countableDocs.filter(
            d => d.status === 'applied' && d.created_at >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
        ).length,
        properties_with_docs: new Set(
            countableDocs.filter(d => d.property_id).map(d => d.property_id)
        ).size,
        photos: allDocs.filter(isPhoto).length,
        failed: allDocs.filter(isFailed).length,
        unknown: allDocs.filter(isUnknown).length,
    };

    // Fetch all properties
    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
    });

    // Build per-property card data
    const propertyCards = properties.map(p => {
        const propDocs = allDocs.filter(d => d.property_id === p.id);
        const propCountable = propDocs.filter(d => !isPhoto(d) && !isUnknown(d));
        const needsReview = propCountable.filter(d => d.status === 'needs_review').length;
        const failed = propDocs.filter(isFailed).length;
        const photos = propDocs.filter(isPhoto).length;

        const buckets = { kosten: 0, versicherungen_vertraege: 0, behoerden: 0, sonstiges: 0 };
        for (const d of propCountable) {
            const bucket = classifyBucket(d);
            if (bucket) buckets[bucket]++;
        }

        let statusDot: 'red' | 'green' | 'gray' = 'gray';
        if (propCountable.length === 0) statusDot = 'gray';
        else if (needsReview > 0) statusDot = 'red';
        else statusDot = 'green';

        return {
            id: p.id,
            name: p.name,
            address: p.address,
            shortCode: (p as Record<string, unknown>).short_code as string | null,
            totalDocs: propCountable.length,
            needsReview,
            failed,
            photos,
            buckets,
            statusDot,
        };
    });

    return { error: null, stats, propertyCards, role };
}

export async function getOpenReviewCount() {
    const orgId = await getOrgId();
    if (!orgId) return 0;

    const db = warehouseDb(orgId);

    const { count } = await db.from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'needs_review');

    return count ?? 0;
}



export async function getPropertyWarehouseDetail(propertyId: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', property: null, folders: [], stats: null, unassignedCount: 0 };

    const db = warehouseDb(orgId);

    // Fetch property
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
    });
    if (!property) return { error: 'Property not found', property: null, folders: [], stats: null, unassignedCount: 0 };

    // Fetch all docs for this property
    const { data: docs } = await db.from('documents')
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

export async function getPropertyStats(propertyId: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', data: null };

    // Ownership check
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        include: { units: { select: { id: true } } },
    });
    if (!property) return { error: 'Property not found', data: null };

    const db = warehouseDb(orgId);

    // Fetch all docs for this property
    const { data: docs } = await db.from('documents')
        .select('id, status, category')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .neq('status', 'deleted');

    const allDocs = docs || [];
    const needsReview = allDocs.filter(d => d.status === 'needs_review').length;

    // Total costs this year: sum amounts from applied invoices
    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1).toISOString();
    const yearEnd = new Date(currentYear + 1, 0, 1).toISOString();
    const { data: costDocs } = await db.from('documents')
        .select('id, doc_type, category')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .eq('status', 'applied')
        .gte('applied_at', yearStart)
        .lt('applied_at', yearEnd)
        .or('doc_type.eq.invoice,category.eq.kosten_rechnungen');

    let totalCostsThisYear = 0;
    if (costDocs && costDocs.length > 0) {
        const costDocIds = costDocs.map(d => d.id);
        const { data: extractions } = await db.from('document_extractions')
            .select('extracted_fields')
            .eq('org_id', orgId)
            .eq('is_current', true)
            .in('document_id', costDocIds);

        if (extractions) {
            for (const ext of extractions) {
                const fields = ext.extracted_fields as Record<string, unknown> | null;
                if (fields?.amount) {
                    const parsed = parseFloat(String(fields.amount).replace(/[^\d.,]/g, '').replace(',', '.'));
                    if (!isNaN(parsed)) totalCostsThisYear += parsed;
                }
            }
        }
    }

    // Per-category review counts
    const categoryStats: Record<string, { total: number; needsReview: number }> = {};
    for (const d of allDocs) {
        const cat = (d.category as string) ?? '_unassigned';
        if (!categoryStats[cat]) categoryStats[cat] = { total: 0, needsReview: 0 };
        categoryStats[cat].total++;
        if (d.status === 'needs_review') categoryStats[cat].needsReview++;
    }

    return {
        error: null,
        data: {
            totalDocs: allDocs.length,
            needsReview,
            unitCount: property.units.length,
            totalCostsThisYear,
            categoryStats,
            property: {
                id: property.id,
                name: property.name,
                address: property.address,
                shortCode: (property as Record<string, unknown>).short_code as string | null,
                organizationId: property.organizationId,
            },
        },
    };
}

export async function getPropertyDocuments(
    propertyId: string,
    filters?: {
        search?: string;
        category?: string;
        status?: string;
        sort?: 'newest' | 'oldest';
        page?: number;
        pageSize?: number;
    },
) {
    const orgId = await getOrgId();
    if (!orgId) return { docs: [], total: 0 };

    // Ownership check
    const prop = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        select: { id: true },
    });
    if (!prop) return { docs: [], total: 0 };

    const db = warehouseDb(orgId);
    const page = filters?.page ?? 1;
    const pageSize = filters?.pageSize ?? 50;
    const ascending = filters?.sort === 'oldest';

    let q = db.from('documents')
        .select('id, display_name, file_name, category, status, source, mime_type, created_at, property_id, doc_type', { count: 'exact' })
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .neq('status', 'deleted')
        .order('created_at', { ascending });

    if (filters?.category && filters.category !== 'all') {
        q = q.eq('category', filters.category);
    }
    if (filters?.status && filters.status !== 'all') {
        q = q.eq('status', filters.status);
    }
    if (filters?.search) {
        q = q.or(`display_name.ilike.%${filters.search}%,file_name.ilike.%${filters.search}%`);
    }

    const offset = (page - 1) * pageSize;
    q = q.range(offset, offset + pageSize - 1);

    const { data, count, error } = await q;
    if (error || !data) return { docs: [], total: 0 };

    // Fetch extractions for amounts/vendor
    const docIds = data.map(d => d.id);
    let extractionMap: Record<string, { amount?: string; vendor_name?: string }> = {};
    if (docIds.length > 0) {
        const { data: extractions } = await db.from('document_extractions')
            .select('document_id, extracted_fields')
            .eq('org_id', orgId)
            .eq('is_current', true)
            .in('document_id', docIds);

        if (extractions) {
            for (const ext of extractions) {
                const fields = ext.extracted_fields as Record<string, unknown> | null;
                extractionMap[ext.document_id as string] = {
                    amount: fields?.amount ? String(fields.amount) : undefined,
                    vendor_name: fields?.vendor_name ? String(fields.vendor_name) : undefined,
                };
            }
        }
    }

    const docs = data.map(d => ({
        id: d.id as string,
        displayName: (d.display_name as string) ?? (d.file_name as string) ?? 'Unbekannt',
        fileName: (d.file_name as string) ?? null,
        category: d.category as string | null,
        status: d.status as string,
        source: d.source as string | null,
        mimeType: d.mime_type as string | null,
        createdAt: d.created_at as string,
        amount: extractionMap[d.id as string]?.amount ?? null,
        vendorName: extractionMap[d.id as string]?.vendor_name ?? null,
    }));

    return { docs, total: count ?? 0 };
}

export interface CostRow {
    documentId: string;
    displayName: string;
    vendorName: string | null;
    amount: number | null;
    category: string | null;
    invoiceDate: string | null;
    appliedAt: string | null;
    displayDate: string;
}

export interface CostKpis {
    totalAmount: number;
    invoiceCount: number;
    averageAmount: number;
    topCategories: Array<{ category: string; amount: number; count: number }>;
}

export async function getPropertyCosts(
    propertyId: string,
    year: number,
    filters?: { category?: string; vendor?: string },
): Promise<{ kpis: CostKpis; rows: CostRow[]; total: number }> {
    const empty = {
        kpis: { totalAmount: 0, invoiceCount: 0, averageAmount: 0, topCategories: [] },
        rows: [],
        total: 0,
    };

    const orgId = await getOrgId();
    if (!orgId) return empty;

    const prop = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        select: { id: true },
    });
    if (!prop) return empty;

    const db = warehouseDb(orgId);

    // Fetch applied invoices for the year
    const yearStart = `${year}-01-01T00:00:00.000Z`;
    const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;

    let q = db.from('documents')
        .select('id, display_name, file_name, category, status, applied_at, created_at, doc_type')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .eq('status', 'applied')
        .or('doc_type.eq.invoice,category.eq.kosten_rechnungen');

    if (filters?.category && filters.category !== 'all') {
        q = q.eq('category', filters.category);
    }

    const { data: docs, error } = await q;
    if (error || !docs || docs.length === 0) return empty;

    // Fetch extractions for all docs
    const docIds = docs.map(d => d.id as string);
    const { data: extractions } = await db.from('document_extractions')
        .select('document_id, extracted_fields')
        .eq('org_id', orgId)
        .eq('is_current', true)
        .in('document_id', docIds);

    const extractionMap: Record<string, Record<string, unknown>> = {};
    if (extractions) {
        for (const ext of extractions) {
            extractionMap[ext.document_id as string] = (ext.extracted_fields as Record<string, unknown>) ?? {};
        }
    }

    // Build rows with amounts and dates
    const allRows: CostRow[] = [];
    for (const doc of docs) {
        const fields = extractionMap[doc.id as string] ?? {};

        // Parse amount
        let amount: number | null = null;
        if (fields.amount != null) {
            const parsed = parseFloat(String(fields.amount).replace(/[^\d.,-]/g, '').replace(',', '.'));
            if (!isNaN(parsed)) amount = parsed;
        }

        const invoiceDate = fields.invoice_date ? String(fields.invoice_date) : null;
        const appliedAt = doc.applied_at ? String(doc.applied_at) : null;
        const displayDate = invoiceDate ?? appliedAt ?? String(doc.created_at);

        // Year filter: check displayDate falls in requested year
        const displayYear = new Date(displayDate).getFullYear();
        if (displayYear !== year) continue;

        // Vendor filter
        if (filters?.vendor) {
            const vn = fields.vendor_name ? String(fields.vendor_name).toLowerCase() : '';
            if (!vn.includes(filters.vendor.toLowerCase())) continue;
        }

        allRows.push({
            documentId: doc.id as string,
            displayName: (doc.display_name as string) ?? (doc.file_name as string) ?? 'Unbekannt',
            vendorName: fields.vendor_name ? String(fields.vendor_name) : null,
            amount,
            category: doc.category as string | null,
            invoiceDate,
            appliedAt,
            displayDate,
        });
    }

    // Sort by displayDate DESC
    allRows.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());

    // Compute KPIs
    const totalAmount = allRows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const invoiceCount = allRows.length;
    const averageAmount = invoiceCount > 0 ? totalAmount / invoiceCount : 0;

    // Top categories
    const catMap: Record<string, { amount: number; count: number }> = {};
    for (const r of allRows) {
        const cat = r.category ?? 'sonstiges';
        if (!catMap[cat]) catMap[cat] = { amount: 0, count: 0 };
        catMap[cat].amount += r.amount ?? 0;
        catMap[cat].count++;
    }
    const topCategories = Object.entries(catMap)
        .map(([category, data]) => ({ category, ...data }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3);

    return {
        kpis: { totalAmount, invoiceCount, averageAmount, topCategories },
        rows: allRows,
        total: allRows.length,
    };
}

export async function getPropertyDetails(propertyId: string) {
    const orgId = await getOrgId();
    if (!orgId) return null;

    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        include: {
            units: {
                include: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        select: { id: true },
                    },
                },
                orderBy: { unitNumber: 'asc' },
            },
        },
    });
    if (!property) return null;

    const db = warehouseDb(orgId);

    // Meta: lastAppliedAt and totalDocuments
    const { data: lastApplied } = await db.from('documents')
        .select('applied_at')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .not('applied_at', 'is', null)
        .order('applied_at', { ascending: false })
        .limit(1);

    const { count } = await db.from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .neq('status', 'deleted');

    const units = property.units.map(u => ({
        id: u.id,
        label: u.unitNumber,
        floor: u.floor != null ? String(u.floor) : null,
        size: u.sizeSqm ?? null,
        status: u.leases.length > 0 ? 'occupied' : 'vacant',
    }));

    return {
        property: {
            id: property.id,
            name: property.name,
            address: property.address,
            short_code: (property as Record<string, unknown>).short_code as string | null,
            notes: (property as Record<string, unknown>).notes as string | null,
            organizationId: property.organizationId,
            createdAt: property.createdAt,
        },
        units,
        meta: {
            lastAppliedAt: lastApplied?.[0]?.applied_at ? String(lastApplied[0].applied_at) : null,
            totalDocuments: count ?? 0,
        },
    };
}

const ALLOWED_PROPERTY_FIELDS = new Set(['address', 'short_code', 'name', 'notes']);

export async function updatePropertyField(
    propertyId: string,
    field: string,
    value: string,
): Promise<{ error?: string }> {
    if (!ALLOWED_PROPERTY_FIELDS.has(field)) {
        return { error: 'Field not allowed' };
    }

    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
        select: { id: true },
    });
    if (!property) return { error: 'Property not found' };

    // Normalize short_code
    let cleanValue = value.trim();
    if (field === 'short_code') {
        cleanValue = cleanValue.toUpperCase().slice(0, 5);
    }

    // Update via Prisma for known fields, raw SQL for extended fields
    if (field === 'name' || field === 'address') {
        await prisma.property.update({
            where: { id: propertyId },
            data: { [field]: cleanValue },
        });
    } else {
        // short_code, notes — not in Prisma schema, use raw SQL
        await prisma.$executeRawUnsafe(
            `UPDATE "Property" SET "${field}" = $1, "updatedAt" = NOW() WHERE id = $2`,
            cleanValue,
            propertyId,
        );
    }

    // Log audit event (silent)
    await logAuditEvent({
        eventType: 'property_updated',
        propertyId,
        metadata: { field, new_value: cleanValue },
    });

    return {};
}

export async function uploadWarehouseDocument(formData: FormData) {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    const file = formData.get('file') as File | null;
    if (!file) return { error: 'No file provided' };

    const documentId = crypto.randomUUID();
    const sanitisedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${orgId}/${documentId}/${sanitisedName}`;

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Upload to storage
    const { error: uploadError } = await db.storage
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
    const { error: docError } = await db.from('documents')
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
    await db.from('processing_jobs')
        .insert({
            document_id: documentId,
            org_id: orgId,
            status: 'queued',
            next_attempt_at: new Date().toISOString(),
        });

    // Audit log
    await logAuditEvent({
        eventType: 'uploaded',
        documentId,
        propertyId: propertyId ?? undefined,
        metadata: { file_name: sanitisedName, source: 'ui', mime_type: file.type },
    });

    return { error: null, documentId };
}

export async function getReviewTasks() {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', tasks: [] };

    const db = warehouseDb(orgId);

    const { data: tasks, error } = await db.from('review_tasks')
        .select('*')
        .eq('org_id', orgId)
        .eq('status', 'open')
        .order('created_at', { ascending: false });

    if (error) return { error: error.message, tasks: [] };

    // For each task, get document and extraction — SECURITY: org-scoped sub-queries
    const enrichedTasks = await Promise.all(
        (tasks || []).map(async (task: Record<string, unknown>) => {
            const { data: doc } = await db.from('documents')
                .select('file_name, display_name, doc_type, source, mime_type, property_id, category')
                .eq('org_id', orgId)
                .eq('id', task.document_id as string)
                .single();

            const { data: extraction } = await db.from('document_extractions')
                .select('id, extracted_fields, confidence_score, flags')
                .eq('org_id', orgId)
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
    docType: string,
    extractedFields: Record<string, unknown>,
    propertyId?: string,
    unitId?: string,
    triggerType: 'user_confirmed' | 'user_corrected' = 'user_confirmed',
) {
    // SECURITY: orgId always from session, never from client
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Unauthorized' };

    const db = warehouseDb(orgId);

    // SECURITY: Ownership check — verify document belongs to this org
    const { data: doc, error: docError } = await db.from('documents')
        .select('id, org_id')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .single();

    if (docError || !doc) {
        return { error: 'Unauthorized or document not found' };
    }

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

    // Call connector.apply() via parameterized SQL
    try {
        const result = await prisma.$queryRaw<{ apply: string }[]>`
            SELECT connector.apply(
                ${orgId}::UUID, ${documentId}::UUID, ${extractionId}::UUID, ${action}::TEXT, ${JSON.stringify(payload)}::JSONB,
                ${userId}::TEXT, ${triggerType}::TEXT, ${idempotencyKey}::TEXT
            ) as apply`;

        const applyResult = typeof result[0]?.apply === 'string'
            ? JSON.parse(result[0].apply)
            : result[0]?.apply;

        if (!applyResult?.success) {
            return { error: applyResult?.error || 'Apply failed' };
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        // Handle idempotency — document was already applied
        if (msg.includes('apply_log_idempotency_key_key')) {
            // Not an error — just revalidate so UI updates
            revalidatePath('/dashboard/warehouse/inbox');
            revalidatePath(`/dashboard/warehouse`);
            return { error: null };
        }
        return { error: `Apply failed: ${msg}` };
    }

    // Mark review task as resolved — SECURITY: scoped to org_id
    await db.from('review_tasks')
        .update({ status: 'resolved' })
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('status', 'open');

    // Set applied_at and applied_by on the document for "Applied this month" view
    await db.from('documents')
        .update({ applied_at: new Date().toISOString(), applied_by: userId })
        .eq('id', documentId);

    // Audit log
    await logAuditEvent({
        eventType: 'applied',
        documentId,
        propertyId: propertyId ?? undefined,
        metadata: {
            trigger_type: triggerType,
            doc_type: docType,
            property_id: propertyId ?? null,
            ...(extractedFields.vendor_name ? { vendor_name: extractedFields.vendor_name } : {}),
            ...(extractedFields.amount ? { amount: extractedFields.amount } : {}),
        },
    });

    // Revalidate inbox and warehouse pages so applied document disappears from "Prüfung nötig"
    revalidatePath('/dashboard/warehouse/inbox');
    revalidatePath(`/dashboard/warehouse`);

    return { error: null };
}

export async function updateDocumentMetadata(
    documentId: string,
    displayName: string,
    category: string,
) {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // Fetch extraction to get invoice_date for retention calculation — SECURITY: org-scoped
    let invoiceDate: string | null = null;
    const { data: extraction } = await db.from('document_extractions')
        .select('extracted_fields')
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('is_current', true)
        .single();

    if (extraction?.extracted_fields) {
        const fields = extraction.extracted_fields as Record<string, unknown>;
        invoiceDate = (fields.invoice_date as string) || null;
    }

    // Calculate retention_until
    let retentionUntil: string;
    const now = new Date();
    if (category === 'rechtliches') {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() + 30);
        retentionUntil = d.toISOString();
    } else if (category === 'kosten_rechnungen' && invoiceDate) {
        const d = new Date(invoiceDate);
        d.setFullYear(d.getFullYear() + 10);
        retentionUntil = d.toISOString();
    } else {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() + 10);
        retentionUntil = d.toISOString();
    }

    const updatePayload: Record<string, unknown> = {
        category,
        retention_until: retentionUntil,
        updated_at: new Date().toISOString(),
    };
    if (displayName.trim()) {
        updatePayload.display_name = displayName.trim();
    }

    const { error } = await db.from('documents')
        .update(updatePayload)
        .eq('org_id', orgId)
        .eq('id', documentId);

    if (error) return { error: error.message };
    return { error: null };
}

export async function dismissReviewTask(taskId: string) {
    // SECURITY: orgId always from session, never from client
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Unauthorized' };

    const db = warehouseDb(orgId);

    // SECURITY: org-scoped update with ownership verification
    const { data, error } = await db.from('review_tasks')
        .update({ status: 'dismissed' })
        .eq('org_id', orgId)
        .eq('id', taskId)
        .select()
        .single();

    if (error || !data) return { error: 'Unauthorized or task not found' };
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
        address: p.address,
        shortCode: (p as Record<string, unknown>).short_code as string | null,
        units: p.units.map(u => ({ id: u.id, unitNumber: u.unitNumber })),
    }));
}

export async function getCategoryDocuments(propertyId: string, category: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', documents: [], property: null };

    const db = warehouseDb(orgId);

    // Fetch property info
    const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
    });
    if (!property) return { error: 'Property not found', documents: [], property: null };

    const { data, error } = await db.from('documents')
        .select('id, file_name, display_name, doc_type, status, source, mime_type, file_size_bytes, retention_until, created_at')
        .eq('org_id', orgId)
        .eq('property_id', propertyId)
        .eq('category', category)
        .neq('status', 'deleted')
        .order('created_at', { ascending: false });

    if (error) return { error: error.message, documents: [], property: null };

    // Fetch extractions for amounts/vendor
    const docIds = (data || []).map(d => d.id as string);
    let extractionMap: Record<string, { amount?: string; vendor_name?: string }> = {};
    if (docIds.length > 0) {
        const { data: extractions } = await db.from('document_extractions')
            .select('document_id, extracted_fields')
            .in('document_id', docIds);
        if (extractions) {
            for (const ext of extractions) {
                const fields = ext.extracted_fields as Record<string, unknown> | null;
                extractionMap[ext.document_id as string] = {
                    amount: fields?.amount ? String(fields.amount) : undefined,
                    vendor_name: fields?.vendor_name ? String(fields.vendor_name) : undefined,
                };
            }
        }
    }

    return {
        error: null,
        documents: (data || []).map(d => ({
            ...d,
            amount: extractionMap[d.id as string]?.amount ?? null,
            vendorName: extractionMap[d.id as string]?.vendor_name ?? null,
        })),
        property: {
            id: property.id,
            name: property.name,
            address: property.address,
            shortCode: (property as Record<string, unknown>).short_code as string | null,
        },
    };
}

export async function renameDocument(documentId: string, newDisplayName: string) {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    const { error } = await db.from('documents')
        .update({ display_name: newDisplayName, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('id', documentId);

    if (error) return { error: error.message };
    return { error: null };
}

export async function softDeleteDocument(documentId: string) {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // Soft delete only — GoBD compliance: never hard delete
    const { error } = await db.from('documents')
        .update({ status: 'deleted', updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('id', documentId);

    if (error) return { error: error.message };
    return { error: null };
}

export async function getDocumentPreview(documentId: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', data: null };

    const db = warehouseDb(orgId);

    // Fetch document
    const { data: doc } = await db.from('documents')
        .select('id, file_name, display_name, doc_type, status, source, mime_type, storage_path, file_size_bytes, retention_until, created_at')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .single();

    if (!doc) return { error: 'Document not found', data: null };

    // Fetch current extraction — SECURITY: org-scoped
    const { data: extraction } = await db.from('document_extractions')
        .select('id, extracted_fields, confidence_score, flags')
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('is_current', true)
        .single();

    // Generate signed URL (300 second expiry)
    let signedUrl: string | null = null;
    if (doc.storage_path) {
        const { data: urlData } = await db.storage
            .from('property-documents')
            .createSignedUrl(doc.storage_path, 300);
        signedUrl = urlData?.signedUrl || null;
    }

    return {
        error: null,
        data: {
            document: doc,
            extraction: extraction ? {
                extracted_fields: extraction.extracted_fields as Record<string, unknown>,
                confidence_score: extraction.confidence_score as number,
                flags: extraction.flags,
            } : null,
            signedUrl,
        },
    };
}

export interface InboxFilters {
    status?: string;
    propertyId?: string;
    docType?: string;
    source?: string;
    dateRange?: string;
    search?: string;
    view?: string; // saved view: 'needs_review' | 'all' | 'applied_month'
}

export async function getInboxDocuments({
    filters = {},
    page = 1,
    pageSize = 25,
}: {
    filters?: InboxFilters;
    page?: number;
    pageSize?: number;
}): Promise<{ documents: InboxDocument[]; total: number; error: string | null }> {
    const orgId = await getOrgId();
    if (!orgId) return { documents: [], total: 0, error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // Build query with Supabase query builder — NO raw SQL
    // IMPORTANT: Apply all filter methods BEFORE transform methods (order/range)
    // to ensure PostgREST generates correct WHERE clauses.
    let query = db.from('documents')
        .select('*', { count: 'exact' })
        .eq('org_id', orgId)
        .neq('status', 'deleted');

    // Apply saved view filters FIRST (before individual filters)
    if (filters.view === 'needs_review') {
        query = query.eq('status', 'needs_review');
    } else if (filters.view === 'applied_month') {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        query = query.eq('status', 'applied')
            .gte('applied_at', monthStart);
    }

    // Apply individual filters (status filter only if no view overrides it)
    if (filters.status && !filters.view) {
        query = query.eq('status', filters.status);
    }
    if (filters.propertyId) {
        query = query.eq('property_id', filters.propertyId);
    }
    if (filters.docType) {
        query = query.eq('doc_type', filters.docType);
    }
    if (filters.source) {
        query = query.eq('source', filters.source);
    }
    if (filters.search) {
        query = query.or(
            `display_name.ilike.%${filters.search}%,file_name.ilike.%${filters.search}%`
        );
    }
    if (filters.dateRange) {
        const now = new Date();
        let from: Date;
        switch (filters.dateRange) {
            case 'this_week': {
                from = new Date(now);
                from.setDate(now.getDate() - now.getDay());
                from.setHours(0, 0, 0, 0);
                break;
            }
            case 'this_month': {
                from = new Date(now.getFullYear(), now.getMonth(), 1);
                break;
            }
            case 'last_3_months': {
                from = new Date(now.getFullYear(), now.getMonth() - 3, 1);
                break;
            }
            default:
                from = new Date(0); // all time
        }
        if (filters.dateRange !== 'all_time') {
            query = query.gte('created_at', from.toISOString());
        }
    }

    // Transform methods AFTER all filters
    query = query
        .order('status', { ascending: true })
        .order('created_at', { ascending: false });

    // Pagination
    const offset = (page - 1) * pageSize;
    query = query.range(offset, offset + pageSize - 1);

    const { data: docs, error, count } = await query;

    if (error) return { documents: [], total: 0, error: error.message };

    // Fetch related data for the page of documents
    const docIds = (docs || []).map((d: Record<string, unknown>) => d.id as string);
    const propertyIds = [...new Set((docs || []).map((d: Record<string, unknown>) => d.property_id as string).filter(Boolean))];

    // Fetch properties
    let propertiesMap: Record<string, { address: string; short_code: string | null }> = {};
    if (propertyIds.length > 0) {
        const properties = await prisma.property.findMany({
            where: { id: { in: propertyIds } },
            select: { id: true, address: true, short_code: true },
        });
        propertiesMap = Object.fromEntries(
            properties.map(p => [p.id, { address: p.address, short_code: p.short_code ?? null }])
        );
    }

    // Fetch extractions — SECURITY: org-scoped
    let extractionsMap: Record<string, number | null> = {};
    if (docIds.length > 0) {
        const { data: extractions } = await db.from('document_extractions')
            .select('document_id, confidence_score')
            .eq('org_id', orgId)
            .in('document_id', docIds)
            .eq('is_current', true);
        if (extractions) {
            extractionsMap = Object.fromEntries(
                extractions.map((e: Record<string, unknown>) => [e.document_id, e.confidence_score as number | null])
            );
        }
    }

    // Fetch apply log — SECURITY: org-scoped
    let applyMap: Record<string, { applied_by: string | null; applied_at: string | null }> = {};
    if (docIds.length > 0) {
        const { data: applyLogs } = await db.from('apply_log')
            .select('document_id, applied_by, created_at')
            .eq('org_id', orgId)
            .in('document_id', docIds);
        if (applyLogs) {
            applyMap = Object.fromEntries(
                applyLogs.map((a: Record<string, unknown>) => [
                    a.document_id,
                    { applied_by: a.applied_by as string | null, applied_at: a.created_at as string | null },
                ])
            );
        }
    }

    const documents: InboxDocument[] = (docs || []).map((d: Record<string, unknown>) => {
        const propData = propertiesMap[d.property_id as string];
        const applyData = applyMap[d.id as string];
        return {
            id: d.id as string,
            file_name: d.file_name as string,
            display_name: d.display_name as string | null,
            doc_type: d.doc_type as string | null,
            status: d.status as string,
            source: (d.source as 'email' | 'telegram' | 'ui') || 'ui',
            created_at: d.created_at as string,
            mime_type: d.mime_type as string | null,
            file_size_bytes: d.file_size_bytes as number | null,
            property_id: d.property_id as string | null,
            category: d.category as string | null,
            subcategory: d.subcategory as string | null ?? null,
            property_address: propData?.address ?? null,
            property_short_code: propData?.short_code ?? null,
            confidence_score: extractionsMap[d.id as string] ?? null,
            applied_by: applyData?.applied_by ?? null,
            applied_at: applyData?.applied_at ?? null,
        };
    });

    return { documents, total: count ?? 0, error: null };
}

export async function getInboxStats() {
    const orgId = await getOrgId();
    if (!orgId) return { total: 0, needsReview: 0, appliedThisMonth: 0, failed: 0 };

    const db = warehouseDb(orgId);

    const { data: docs } = await db.from('documents')
        .select('id, status, created_at')
        .eq('org_id', orgId)
        .neq('status', 'deleted');

    const allDocs = docs || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    return {
        total: allDocs.length,
        needsReview: allDocs.filter((d: Record<string, unknown>) => d.status === 'needs_review').length,
        appliedThisMonth: allDocs.filter(
            (d: Record<string, unknown>) => d.status === 'applied' && (d.created_at as string) >= monthStart
        ).length,
        failed: allDocs.filter((d: Record<string, unknown>) => d.status === 'failed').length,
    };
}

// ─── Quarantine Actions ────────────────────────────────────────

export async function quarantineDocument(
    documentId: string,
    reason: string,
    notes: string | null,
): Promise<{ error: string | null }> {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // SECURITY: Ownership check
    const { data: doc, error: docError } = await db.from('documents')
        .select('id, property_id')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .single();

    if (docError || !doc) {
        return { error: 'Unauthorized or document not found' };
    }

    // Get user id from session
    const session = await auth();
    let userId: string | null = null;
    if (session?.user?.email) {
        const dbUser = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
        userId = dbUser?.id || null;
    }

    const { error } = await db.from('documents')
        .update({
            status: 'quarantined',
            quarantine_reason: reason,
            quarantine_notes: notes,
            quarantined_by: userId,
            quarantined_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('org_id', orgId)
        .eq('id', documentId);

    if (error) return { error: error.message };

    // Also close any open review task for this document
    await db.from('review_tasks')
        .update({ status: 'dismissed' })
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('status', 'open');

    // Audit log
    await logAuditEvent({
        eventType: 'quarantined',
        documentId,
        propertyId: (doc.property_id as string) ?? undefined,
        metadata: { reason, notes },
    });

    return { error: null };
}

export async function unquarantineDocument(
    documentId: string,
): Promise<{ error: string | null }> {
    const orgId = await getOrgIdWritable();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // SECURITY: Ownership check
    const { data: doc, error: docError } = await db.from('documents')
        .select('id')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .single();

    if (docError || !doc) {
        return { error: 'Unauthorized or document not found' };
    }

    const { error } = await db.from('documents')
        .update({
            status: 'needs_review',
            quarantine_reason: null,
            quarantine_notes: null,
            quarantined_by: null,
            quarantined_at: null,
            updated_at: new Date().toISOString(),
        })
        .eq('org_id', orgId)
        .eq('id', documentId);

    if (error) return { error: error.message };

    // Audit log
    await logAuditEvent({
        eventType: 'unquarantined',
        documentId,
    });

    return { error: null };
}

// ─── Triage Overlay Data ───────────────────────────────────────

export async function getTriageDocument(documentId: string) {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated', data: null };

    const db = warehouseDb(orgId);

    // 1) Full document row
    const { data: doc, error: docError } = await db.from('documents')
        .select('*')
        .eq('org_id', orgId)
        .eq('id', documentId)
        .single();

    if (docError || !doc) {
        return { error: 'Document not found', data: null };
    }

    // 2) Current extraction
    const { data: extraction } = await db.from('document_extractions')
        .select('id, extracted_fields, confidence_score, flags, model, created_at')
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('is_current', true)
        .single();

    // 3) Signed URL (300s)
    let signedUrl: string | null = null;
    if (doc.storage_path) {
        const { data: urlData } = await db.storage
            .from('property-documents')
            .createSignedUrl(doc.storage_path, 300);
        signedUrl = urlData?.signedUrl || null;
    }

    // 4) All org properties
    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
        select: { id: true, name: true, address: true },
        orderBy: { name: 'asc' },
    });

    // 5) Units for matched property (if any)
    let units: { id: string; unitNumber: string }[] = [];
    if (doc.property_id) {
        units = await prisma.unit.findMany({
            where: { propertyId: doc.property_id },
            select: { id: true, unitNumber: true },
            orderBy: { unitNumber: 'asc' },
        });
    }

    // 6) Last apply log entry
    const { data: applyLogEntries } = await db.from('apply_log')
        .select('id, trigger_type, status, created_at')
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .order('created_at', { ascending: false })
        .limit(1);

    const applyLog = applyLogEntries?.[0] || null;

    // 7) Confidence info
    const confidenceScore = extraction?.confidence_score as number | null;
    const flags = (extraction?.flags as string[]) || [];
    let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
    if (confidenceScore !== null) {
        if (confidenceScore >= 85) confidenceLevel = 'high';
        else if (confidenceScore >= 60) confidenceLevel = 'medium';
    }

    // Determine review reason from flags or review_tasks
    let reviewReason: string | null = null;
    if (flags.length > 0) {
        reviewReason = flags.join(', ');
    } else {
        const { data: reviewTask } = await db.from('review_tasks')
            .select('reason')
            .eq('org_id', orgId)
            .eq('document_id', documentId)
            .eq('status', 'open')
            .limit(1)
            .single();
        reviewReason = (reviewTask?.reason as string) || null;
    }

    return {
        error: null,
        data: {
            document: doc,
            extraction: extraction ? {
                id: extraction.id,
                extracted_fields: extraction.extracted_fields as Record<string, unknown>,
                confidence_score: extraction.confidence_score as number | null,
                flags: extraction.flags as string[],
                model: extraction.model as string,
                created_at: extraction.created_at as string,
            } : null,
            signedUrl,
            properties,
            units,
            applyLog,
            confidence: {
                score: confidenceScore,
                level: confidenceLevel,
                reason: reviewReason,
            },
        },
    };
}

export async function updateExtractionField(
    documentId: string,
    fieldName: string,
    fieldValue: unknown,
): Promise<{ error: string | null }> {
    const orgId = await getOrgId();
    if (!orgId) return { error: 'Not authenticated' };

    const db = warehouseDb(orgId);

    // Fetch current extraction — SECURITY: org-scoped
    const { data: extraction, error: extError } = await db.from('document_extractions')
        .select('id, extracted_fields')
        .eq('org_id', orgId)
        .eq('document_id', documentId)
        .eq('is_current', true)
        .single();

    if (extError || !extraction) {
        return { error: 'Extraction not found' };
    }

    // Update the specific field in extracted_fields JSONB
    const currentFields = (extraction.extracted_fields as Record<string, unknown>) || {};
    const updatedFields = { ...currentFields, [fieldName]: fieldValue };

    const { error } = await db.from('document_extractions')
        .update({ extracted_fields: updatedFields })
        .eq('org_id', orgId)
        .eq('id', extraction.id);

    if (error) return { error: error.message };
    return { error: null };
}

// ─── Audit Log Queries ────────────────────────────────────────

export interface AuditEvent {
    id: string;
    org_id: string;
    actor_user_id: string;
    actor_email: string | null;
    event_type: string;
    document_id: string | null;
    property_id: string | null;
    unit_id: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
}

const ALLOWED_METADATA_KEYS = new Set([
    'trigger_type', 'vendor_name', 'amount', 'doc_type',
    'reason', 'notes', 'file_name', 'display_name', 'source',
    'mime_type', 'old_role', 'new_role', 'invited_email',
]);

function stripMetadata(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        if (ALLOWED_METADATA_KEYS.has(key)) {
            out[key] = obj[key];
        }
    }
    return out;
}

export async function getAuditEvents({
    types,
    actorId,
    from,
    to,
    query,
    page,
    pageSize = 50,
    propertyId,
}: {
    types?: string[];
    actorId?: string;
    from?: string;
    to?: string;
    query?: string;
    page: number;
    pageSize?: number;
    propertyId?: string;
}): Promise<{ events: AuditEvent[]; total: number }> {
    const { orgId } = await getOrgContext();

    const db = warehouseDb(orgId);
    const shared = db.admin.schema('shared');

    // Build query
    let q = shared.from('audit_log')
        .select('*', { count: 'exact' })
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });

    // Property-scoped filter
    if (propertyId) {
        const prop = await prisma.property.findFirst({
            where: { id: propertyId, organizationId: orgId },
            select: { id: true },
        });
        if (!prop) return { events: [], total: 0 };
        q = q.eq('property_id', propertyId);
    }

    if (types && types.length > 0) {
        q = q.in('event_type', types);
    }
    if (actorId) {
        q = q.eq('actor_user_id', actorId);
    }
    if (from) {
        q = q.gte('created_at', from);
    }
    if (to) {
        q = q.lte('created_at', to);
    }
    if (query) {
        q = q.or(`actor_email.ilike.%${query}%,metadata->>display_name.ilike.%${query}%,metadata->>file_name.ilike.%${query}%`);
    }

    // Paginate
    const offset = (page - 1) * pageSize;
    q = q.range(offset, offset + pageSize - 1);

    const { data, count, error } = await q;

    if (error) {
        console.error('[audit] Query failed:', error);
        return { events: [], total: 0 };
    }

    const events: AuditEvent[] = (data ?? []).map((row) => ({
        ...row,
        metadata: stripMetadata(row.metadata),
    })) as AuditEvent[];

    return { events, total: count ?? 0 };
}

export async function getAuditActors(): Promise<{ id: string; email: string }[]> {
    const { orgId } = await getOrgContext();

    const db = warehouseDb(orgId);
    const shared = db.admin.schema('shared');

    const { data, error } = await shared.from('audit_log')
        .select('actor_user_id, actor_email')
        .eq('org_id', orgId)
        .not('actor_email', 'is', null);

    if (error || !data) return [];

    // Deduplicate
    const seen = new Map<string, string>();
    for (const row of data) {
        if (row.actor_user_id && row.actor_email && !seen.has(row.actor_user_id)) {
            seen.set(row.actor_user_id, row.actor_email as string);
        }
    }

    return Array.from(seen.entries()).map(([id, email]) => ({ id, email }));
}
