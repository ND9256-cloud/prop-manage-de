import { getWarehouseOverview, getOpenReviewCount } from '@/lib/warehouse-actions';
import PropertySelection from '@/components/warehouse/property-selection';

export default async function WarehousePage() {
    const { stats, propertyCards, role } = await getWarehouseOverview();
    const reviewCount = await getOpenReviewCount();

    return (
        <PropertySelection
            stats={stats || { total: 0, needs_review: 0, applied_this_month: 0, properties_with_docs: 0, photos: 0, failed: 0, unknown: 0 }}
            propertyCards={propertyCards}
            reviewCount={reviewCount}
            role={role}
        />
    );
}
