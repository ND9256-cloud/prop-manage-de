import { getWarehouseOverview } from '@/lib/warehouse-actions';
import { getBrainSummaries, getLastVisitStats } from '@/lib/dashboard-actions';
import PropertySelection from '@/components/warehouse/property-selection';

export default async function WarehousePage() {
    const [{ stats, propertyCards, role }, brainSummaries, lastVisitStats] = await Promise.all([
        getWarehouseOverview(),
        getBrainSummaries(),
        getLastVisitStats(),
    ]);

    return (
        <PropertySelection
            stats={stats || { total: 0, needs_review: 0, applied_this_month: 0, properties_with_docs: 0, photos: 0, failed: 0, unknown: 0 }}
            propertyCards={propertyCards}
            role={role}
            brainSummaries={brainSummaries}
            lastVisitStats={lastVisitStats}
        />
    );
}
