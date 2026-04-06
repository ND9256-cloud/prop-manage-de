import PropertyFolders from '@/components/warehouse/property-folders';

type FoldersData = {
    property: { id: string; name: string; address: string; shortCode: string | null };
    folders: {
        key: string;
        de: string;
        en: string;
        icon: string;
        count: number;
        needsReview: number;
        totalSize: number;
        mostRecent: string | null;
    }[];
    stats: {
        total: number;
        needsReview: number;
        appliedThisMonth: number;
        oldestUnreviewed: string | null;
    };
    unassignedCount: number;
};

interface DokumenteTabProps {
    propertyId: string;
    foldersData: FoldersData;
    readOnly?: boolean;
    unitCount?: number;
}

export function DokumenteTab({
    foldersData,
    readOnly,
    unitCount,
}: DokumenteTabProps) {
    return (
        <PropertyFolders
            property={foldersData.property}
            folders={foldersData.folders}
            stats={foldersData.stats}
            unassignedCount={foldersData.unassignedCount}
            readOnly={readOnly}
            unitCount={unitCount}
        />
    );
}
