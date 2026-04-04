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
    // Prefer explicit rent_roll section (present after brain regeneration)
    const rentRoll = analysis?.rent_roll as {
        current_tenants?: number | unknown[];
        monthly_gross_cold?: number;
        annual_gross_cold?: number;
    } | undefined;

    if (rentRoll && rentRoll.current_tenants != null) {
        const tenants = Array.isArray(rentRoll.current_tenants)
            ? rentRoll.current_tenants.length
            : typeof rentRoll.current_tenants === 'number'
              ? rentRoll.current_tenants
              : 0;
        const monthly = rentRoll.monthly_gross_cold ?? 0;
        return {
            current_tenants: tenants,
            monthly_gross_cold: monthly,
            annual_gross_cold: rentRoll.annual_gross_cold ?? monthly * 12,
        };
    }

    // Fallback: derive from tenant_overview + financial_analysis
    const tenantOverview = analysis?.tenant_overview as { identified_tenants?: { status?: string }[] } | undefined;
    const activeTenants = (tenantOverview?.identified_tenants ?? []).filter(
        (t) => t.status === 'aktiv'
    );

    const financial = analysis?.financial_analysis as {
        recurring_costs?: { amount?: number; frequency?: string }[];
    } | undefined;

    let monthlyTotal = 0;
    for (const cost of financial?.recurring_costs ?? []) {
        const amt = typeof cost.amount === 'number' ? cost.amount : 0;
        if (cost.frequency === 'monatlich') {
            monthlyTotal += amt;
        } else if (cost.frequency === 'jährlich') {
            monthlyTotal += amt / 12;
        }
    }

    return {
        current_tenants: activeTenants.length,
        monthly_gross_cold: Math.round(monthlyTotal),
        annual_gross_cold: Math.round(monthlyTotal * 12),
    };
}
