'use server';

import { getOrgContext } from '@/lib/org';
import { prisma } from '@/lib/db';
import { warehouseDb } from '@/lib/warehouse/db';

export interface LastVisitStats {
    newDocs: number;
    needsReview: number;
}

export async function getLastVisitStats(): Promise<LastVisitStats> {
    const ctx = await getOrgContext();
    if (!ctx) return { newDocs: 0, needsReview: 0 };

    // Read last_seen_at before updating it
    const membership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: ctx.userId, orgId: ctx.orgId } },
        select: { lastSeenAt: true },
    });

    const lastSeen = membership?.lastSeenAt;

    // Update last_seen_at to now (force, no throttle)
    await prisma.$executeRaw`
        UPDATE memberships SET last_seen_at = now()
        WHERE "userId" = ${ctx.userId}::uuid AND "orgId" = ${ctx.orgId}::uuid
    `;

    if (!lastSeen) return { newDocs: 0, needsReview: 0 };

    const db = warehouseDb(ctx.orgId);

    const [totalRes, reviewRes] = await Promise.all([
        db
            .from('documents')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', ctx.orgId)
            .gt('created_at', lastSeen.toISOString()),
        db
            .from('documents')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', ctx.orgId)
            .gt('created_at', lastSeen.toISOString())
            .eq('status', 'needs_review'),
    ]);

    return {
        newDocs: totalRes.count ?? 0,
        needsReview: reviewRes.count ?? 0,
    };
}

export interface BrainSummary {
    propertyId: string;
    analysis: Record<string, unknown>;
    isStale: boolean;
    generatedAt: string;
}

export async function getBrainSummaries(): Promise<BrainSummary[]> {
    const ctx = await getOrgContext();
    if (!ctx) return [];

    const db = warehouseDb(ctx.orgId);
    const { data, error } = await db
        .from('property_intelligence')
        .select('property_id, analysis, is_stale, generated_at')
        .eq('org_id', ctx.orgId)
        .eq('is_current', true);

    if (error || !data) return [];

    return data.map((row: { property_id: string; analysis: Record<string, unknown>; is_stale: boolean; generated_at: string }) => ({
        propertyId: row.property_id,
        analysis: row.analysis,
        isStale: row.is_stale,
        generatedAt: row.generated_at,
    }));
}
