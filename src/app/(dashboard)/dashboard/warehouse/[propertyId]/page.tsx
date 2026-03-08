import { getPropertyWarehouseDetail } from '@/lib/warehouse-actions';
import PropertyFolders from '@/components/warehouse/property-folders';
import { notFound } from 'next/navigation';

export default async function PropertyWarehousePage({
    params,
}: {
    params: Promise<{ propertyId: string }>;
}) {
    const { propertyId } = await params;
    const { error, property, folders, stats, unassignedCount } = await getPropertyWarehouseDetail(propertyId);

    if (error || !property || !stats) {
        notFound();
    }

    return (
        <PropertyFolders
            property={property}
            folders={folders}
            stats={stats}
            unassignedCount={unassignedCount}
        />
    );
}
