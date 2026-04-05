import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, Download } from 'lucide-react';
import { getInboxDocuments, getInboxStats, getProperties } from '@/lib/warehouse-actions';
import { getLastVisitStats } from '@/lib/dashboard-actions';
import { t } from '@/lib/i18n/warehouse';
import { getOrgContext } from '@/lib/org';
import { InboxFilters } from './inbox-filters';
import { InboxTable } from './inbox-table';

const PAGE_SIZE = 25;

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InboxPage({ searchParams }: PageProps) {
    const params = await searchParams;

    // Role for viewer enforcement (defense-in-depth — middleware redirects viewers)
    const ctx = await getOrgContext().catch(() => null);
    const readOnly = ctx?.role === 'viewer';

    // Default to "all" view
    const view = params.view ? String(params.view) : 'all';

    const page = Math.max(1, parseInt(String(params.page ?? '1'), 10));
    const filters = {
        status: params.status ? String(params.status) : undefined,
        propertyId: params.property ? String(params.property) : undefined,
        docType: params.docType ? String(params.docType) : undefined,
        source: params.source ? String(params.source) : undefined,
        dateRange: params.dateRange ? String(params.dateRange) : undefined,
        search: params.search ? String(params.search) : undefined,
        view,
    };

    const [{ documents, total }, stats, properties, lastVisitStats] = await Promise.all([
        getInboxDocuments({ filters, page, pageSize: PAGE_SIZE }),
        getInboxStats(),
        getProperties(),
        getLastVisitStats(),
    ]);

    return (
        <div className="space-y-6">
            {/* Last visit orientation card */}
            {lastVisitStats && (
                <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Seit deinem letzten Besuch</span>
                    <span className="mx-2">&mdash;</span>
                    {lastVisitStats.newDocs > 0 ? (
                        <span>
                            {lastVisitStats.newDocs} neue Dokumente
                            {lastVisitStats.needsReview > 0 && (
                                <> &middot; {lastVisitStats.needsReview} zur Prüfung</>
                            )}
                        </span>
                    ) : (
                        <span>Keine neuen Dokumente seit deinem letzten Besuch</span>
                    )}
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-foreground">
                        {t.allDocuments.de}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {stats.total} Dokumente
                        {stats.needsReview > 0 && (
                            <span className="text-amber-600"> · {stats.needsReview} Prüfung nötig</span>
                        )}
                        {stats.failed > 0 && (
                            <span className="text-red-600"> · {stats.failed} fehlgeschlagen</span>
                        )}
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
