import { getCategoryDocuments } from '@/lib/warehouse-actions';
import CategoryDocuments from '@/components/warehouse/category-documents';
import { notFound } from 'next/navigation';

export default async function CategoryDocumentsPage({
    params,
}: {
    params: Promise<{ propertyId: string; category: string }>;
}) {
    const { propertyId, category } = await params;
    const { error, documents, property } = await getCategoryDocuments(propertyId, category);

    if (error || !property) {
        notFound();
    }

    return (
        <CategoryDocuments
            documents={documents}
            property={property}
            category={category}
        />
    );
}
