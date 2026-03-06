
import { auth } from '@/auth';
import { notFound } from 'next/navigation';
import { getWarehouseDocuments, getWarehouseStats } from '@/lib/warehouse-actions';
import WarehouseDocumentList from '@/components/warehouse/document-list';

export default async function WarehousePage() {
    const session = await auth();
    if (!session?.user?.email) {
        notFound();
    }

    const [docResult, stats] = await Promise.all([
        getWarehouseDocuments(),
        getWarehouseStats(),
    ]);

    return (
        <WarehouseDocumentList
            initialDocuments={docResult.documents}
            initialStats={stats}
        />
    );
}
