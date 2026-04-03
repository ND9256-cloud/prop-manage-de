'use server';

import { getOrgContext } from '@/lib/org';
import { warehouseDb } from '@/lib/warehouse/db';

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
