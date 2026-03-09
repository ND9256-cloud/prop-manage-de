import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Upload, Download } from 'lucide-react';
import { getInboxDocuments, getInboxStats, getProperties, getOpenReviewCount } from '@/lib/warehouse-actions';
import { bilingual, t } from '@/lib/i18n/warehouse';
import { getOrgContext } from '@/lib/org';
import { InboxStats } from './inbox-stats';
import { InboxFilters } from './inbox-filters';
import { InboxTable } from './inbox-table';
import { SavedViews } from './saved-views';

const PAGE_SIZE = 25;

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InboxPage({ searchParams }: PageProps) {
    const params = await searchParams;

    // Role for viewer enforcement (defense-in-depth — middleware redirects viewers)
    const ctx = await getOrgContext().catch(() => null);
    const readOnly = ctx?.role === 'viewer';

    // Determine the active view
    let view = params.view ? String(params.view) : undefined;

    // Default view logic: if no view specified, check needs_review count
    if (!view) {
        const reviewCount = await getOpenReviewCount();
        if (reviewCount > 0) {
            // Redirect to needs_review view by default
            redirect('/dashboard/warehouse/inbox?view=needs_review');
        }
        view = 'all';
    }

    const page = Math.max(1, parseInt(String(params.page ?? '1'), 10));
    const filters = {
        status: params.status ? String(params.status) : undefined,
        propertyId: params.property ? String(params.property) : undefined,
        docType: params.docType ? String(params.docType) : undefined,
        source: params.source ? String(params.source) : undefined,
        dateRange: params.dateRange ? String(params.dateRange) : undefined,
        search: params.search ? String(params.search) : undefined,
        view, // Pass the saved view
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
                    {!readOnly && (
                        <>
                            <Button variant="outline" className="gap-2">
                                <Download className="h-4 w-4" />
                                {t.export.de}
                            </Button>
                            <Button className="gap-2">
                                <Upload className="h-4 w-4" />
                                {t.upload.de}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {/* Stats */}
            <InboxStats
                total={stats.total}
                needsReview={stats.needsReview}
                appliedThisMonth={stats.appliedThisMonth}
                failed={stats.failed}
            />

            {/* Saved Views (pills) */}
            <Suspense fallback={null}>
                <SavedViews
                    needsReviewCount={stats.needsReview}
                    appliedMonthCount={stats.appliedThisMonth}
                />
            </Suspense>

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
                readOnly={readOnly}
            />
        </div>
    );
}
