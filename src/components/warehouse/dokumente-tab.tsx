'use client';

import { useState } from 'react';
import PropertyFolders from '@/components/warehouse/property-folders';
import { PropertyDocumentTable, PropertyDoc } from '@/components/warehouse/property-document-table';
import { TriageOverlay } from '@/components/warehouse/triage-overlay';

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
    docs: PropertyDoc[];
    docsTotal: number;
    docsPage: number;
    currentFilters: {
        search: string;
        category: string;
        status: string;
        sort: string;
    };
    readOnly?: boolean;
}

export function DokumenteTab({
    propertyId,
    foldersData,
    docs,
    docsTotal,
    docsPage,
    currentFilters,
    readOnly,
}: DokumenteTabProps) {
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

    return (
        <>
            {/* Category folders */}
            <PropertyFolders
                property={foldersData.property}
                folders={foldersData.folders}
                stats={foldersData.stats}
                unassignedCount={foldersData.unassignedCount}
                readOnly={readOnly}
            />

            {/* All documents table */}
            <PropertyDocumentTable
                docs={docs}
                total={docsTotal}
                page={docsPage}
                propertyId={propertyId}
                currentFilters={currentFilters}
                onDocumentClick={(docId) => setSelectedDocId(docId)}
            />

            {/* Triage overlay */}
            {selectedDocId && (
                <TriageOverlay
                    documentId={selectedDocId}
                    onClose={() => setSelectedDocId(null)}
                    onApplied={() => {
                        setSelectedDocId(null);
                        window.location.reload();
                    }}
                    readOnly={readOnly}
                />
            )}
        </>
    );
}
