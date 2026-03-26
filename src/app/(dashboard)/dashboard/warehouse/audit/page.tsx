import { getAuditEvents, getAuditActors, getProperties } from '@/lib/warehouse-actions';
import { AuditTable } from '@/components/warehouse/audit-table';
import { ShieldCheck } from 'lucide-react';

interface PageProps {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function AuditPage({ searchParams }: PageProps) {
    const params = await searchParams;

    const page = params.page ? Number(params.page) : 1;
    const types = params.types ? String(params.types).split(',') : undefined;
    const actorId = params.actor ? String(params.actor) : undefined;
    const dateRange = params.range ? String(params.range) : 'all';
    const query = params.q ? String(params.q) : undefined;

    // Compute date from/to based on range
    let from: string | undefined;
    let to: string | undefined;
    const now = new Date();
    if (dateRange === 'today') {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (dateRange === '7d') {
        from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (dateRange === '30d') {
        from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    } else if (dateRange === '90d') {
        from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    }
    // 'all' → no from/to filter

    const [{ events, total }, actors, properties] = await Promise.all([
        getAuditEvents({ types, actorId, from, to, query, page }),
        getAuditActors(),
        getProperties(),
    ]);

    return (
        <div className="w-full space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <ShieldCheck className="h-7 w-7 text-muted-foreground" />
                    <div>
                        <h1 className="text-2xl font-semibold text-foreground">
                            Aktivitätsprotokoll
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            Alle Aktionen in Ihrer Organisation
                        </p>
                    </div>
                </div>
            </div>

            {/* Client component handles filters, table, sheet, and CSV export */}
            <AuditTable
                events={events}
                total={total}
                page={page}
                actors={actors}
                properties={properties}
                currentFilters={{
                    types: types ?? [],
                    actorId: actorId ?? '',
                    range: dateRange,
                    q: query ?? '',
                }}
            />
        </div>
    );
}
