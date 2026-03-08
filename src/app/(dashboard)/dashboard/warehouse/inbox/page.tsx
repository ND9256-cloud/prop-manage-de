import { Suspense } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Upload, Download } from 'lucide-react';
import { getInboxDocuments, getInboxStats, getProperties } from '@/lib/warehouse-actions';
import { bilingual, t } from '@/lib/i18n/warehouse';
import { InboxStats } from './inbox-stats';
import { InboxFilters } from './inbox-filters';
import { InboxTable } from './inbox-table';

const PAGE_SIZE = 25;

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InboxPage({ searchParams }: PageProps) {
    const params = await searchParams;

    const page = Math.max(1, parseInt(String(params.page ?? '1'), 10));
    const filters = {
        status: params.status ? String(params.status) : undefined,
        propertyId: params.property ? String(params.property) : undefined,
        docType: params.docType ? String(params.docType) : undefined,
        source: params.source ? String(params.source) : undefined,
        dateRange: params.dateRange ? String(params.dateRange) : undefined,
        search: params.search ? String(params.search) : undefined,
    };

    const [{ documents, total }, stats, properties] = await Promise.all([
        getInboxDocuments({ filters, page, pageSize: PAGE_SIZE }),
        getInboxStats(),
        getProperties(),
    ]);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-foreground">
                        {t.inbox.de}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {bilingual('allDocuments')}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" className="gap-2">
                        <Download className="h-4 w-4" />
                        {t.export.de}
                    </Button>
                    <Button className="gap-2">
                        <Upload className="h-4 w-4" />
                        {t.upload.de}
                    </Button>
                </div>
            </div>

            {/* Stats */}
            <InboxStats
                total={stats.total}
                needsReview={stats.needsReview}
                appliedThisMonth={stats.appliedThisMonth}
                failed={stats.failed}
            />

            {/* Filters */}
            <Suspense fallback={null}>
                <InboxFilters
                    properties={properties.map((p) => ({
                        id: p.id,
                        name: p.name,
                        shortCode: p.shortCode,
                    }))}
                />
            </Suspense>

            {/* Table */}
            <InboxTable
                documents={documents}
                total={total}
                page={page}
                pageSize={PAGE_SIZE}
            />
        </div>
    );
}
