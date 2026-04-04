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

export interface RentRoll {
    current_tenants: number;
    monthly_gross_cold: number;
    annual_gross_cold: number;
}

export interface BrainSummary {
    propertyId: string;
    analysis: Record<string, unknown>;
    isStale: boolean;
    generatedAt: string;
    rentRoll: RentRoll;
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

    return data.map((row: { property_id: string; analysis: Record<string, unknown>; is_stale: boolean; generated_at: string }) => {
        const analysis = row.analysis as Record<string, unknown>;
        const rentRoll = extractRentRoll(analysis);
        return {
            propertyId: row.property_id,
            analysis,
            isStale: row.is_stale,
            generatedAt: row.generated_at,
            rentRoll,
        };
    });
}

function extractRentRoll(analysis: Record<string, unknown>): RentRoll {
    const rentRoll = analysis?.rent_roll as {
        current_tenants?: number | unknown[];
        tenants?: unknown[];
        monthly_gross_cold?: number;
        annual_gross_cold?: number;
    } | undefined;

    if (rentRoll) {
        // Resolve tenant count: current_tenants can be a number or an array;
        // fall back to tenants array length if current_tenants is missing or zero.
        let tenantCount = 0;
        if (Array.isArray(rentRoll.current_tenants)) {
            tenantCount = rentRoll.current_tenants.length;
        } else if (typeof rentRoll.current_tenants === 'number' && rentRoll.current_tenants > 0) {
            tenantCount = rentRoll.current_tenants;
        } else if (Array.isArray(rentRoll.tenants)) {
            tenantCount = rentRoll.tenants.length;
        }

        const monthly = typeof rentRoll.monthly_gross_cold === 'number' ? rentRoll.monthly_gross_cold : 0;
        const annual = typeof rentRoll.annual_gross_cold === 'number' ? rentRoll.annual_gross_cold : monthly * 12;

        return {
            current_tenants: tenantCount,
            monthly_gross_cold: monthly,
            annual_gross_cold: annual,
        };
    }

    // Fallback: no rent_roll section at all — return zeros
    return {
        current_tenants: 0,
        monthly_gross_cold: 0,
        annual_gross_cold: 0,
    };
}
