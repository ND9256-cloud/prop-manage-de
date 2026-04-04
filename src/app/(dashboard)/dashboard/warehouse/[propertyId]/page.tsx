import { getPropertyStats, getPropertyWarehouseDetail, getPropertyDocuments, getPropertyCosts, getAuditEvents, getAuditActors, getProperties, getPropertyDetails } from '@/lib/warehouse-actions';
import { getBrainSummaries } from '@/lib/dashboard-actions';
import { AssetTabs } from '@/components/warehouse/asset-tabs';
import { DokumenteTab } from '@/components/warehouse/dokumente-tab';
import { PropertyCosts } from '@/components/warehouse/property-costs';
import { PropertyAudit } from '@/components/warehouse/property-audit';
import { PropertyDetails } from '@/components/warehouse/property-details';
import { PropertyChat } from '@/components/warehouse/property-chat';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, FileText, AlertCircle, Building, Lightbulb } from 'lucide-react';
import { getOrgContext } from '@/lib/org';

interface PageProps {
    params: Promise<{ propertyId: string }>;
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function PropertyWarehousePage({ params, searchParams }: PageProps) {
    const { propertyId } = await params;
    const sp = await searchParams;
    const tab = (sp.tab as string) ?? 'dokumente';

    // Fetch stats for header — ownership check inside
    const [{ error: statsError, data: statsData }, brainSummaries] = await Promise.all([
        getPropertyStats(propertyId),
        getBrainSummaries(),
    ]);
    if (statsError || !statsData) notFound();

    const { property, totalDocs, needsReview, unitCount } = statsData;

    // Extract brain insight for this property
    const brain = brainSummaries.find(b => b.propertyId === propertyId);
    let insightLine: string | null = null;
    if (brain?.analysis) {
        const a = brain.analysis as Record<string, unknown>;
        // Try to extract risks count and next action from the analysis JSON
        const risks = a.offene_risiken ?? a.risks ?? a.open_risks;
        const riskCount = Array.isArray(risks) ? risks.length : 0;
        const nextAction = (a.naechste_massnahme ?? a.next_action ?? a.empfehlung ?? a.recommendation) as string | undefined;
        const parts: string[] = [];
        if (riskCount > 0) parts.push(`${riskCount} offene Risiken`);
        if (typeof nextAction === 'string' && nextAction.trim()) {
            parts.push(`Nächste Maßnahme: ${nextAction.trim()}`);
        }
        if (parts.length > 0) insightLine = parts.join(' · ');
    }

    // Role for viewer enforcement
    const ctx = await getOrgContext().catch(() => null);
    const readOnly = ctx?.role === 'viewer';

    // Tab-specific data
    let foldersData = null;
    let propertyDocs: Awaited<ReturnType<typeof getPropertyDocuments>> = { docs: [], total: 0 };
    const docFilters = {
        search: (sp.q as string) ?? '',
        category: (sp.cat as string) ?? '',
        status: (sp.docStatus as string) ?? '',
        sort: (sp.sort as string) ?? 'newest',
    };

    if (tab === 'dokumente') {
        const [detail, docsResult] = await Promise.all([
            getPropertyWarehouseDetail(propertyId),
            getPropertyDocuments(propertyId, {
                search: docFilters.search || undefined,
                category: docFilters.category || undefined,
                status: docFilters.status || undefined,
                sort: (docFilters.sort as 'newest' | 'oldest') || 'newest',
                page: sp.docPage ? Number(sp.docPage) : 1,
            }),
        ]);

        if (!detail.error) {
            foldersData = {
                property: detail.property!,
                folders: detail.folders,
                stats: detail.stats!,
                unassignedCount: detail.unassignedCount,
            };
        }
        propertyDocs = docsResult;
    }

    // Kosten tab data
    const costYear = sp.year ? Number(sp.year) : new Date().getFullYear();
    const costFilters = {
        category: (sp.costCat as string) ?? '',
        vendor: (sp.vendor as string) ?? '',
    };
    let costsData: Awaited<ReturnType<typeof getPropertyCosts>> | null = null;
    if (tab === 'kosten') {
        costsData = await getPropertyCosts(propertyId, costYear, {
            category: costFilters.category || undefined,
            vendor: costFilters.vendor || undefined,
        });
    }

    // Protokoll tab data
    const DEFAULT_AUDIT_TYPES = ['uploaded', 'applied', 'quarantined', 'unquarantined', 'downloaded'];
    const auditRange = (sp.auditRange as string) ?? '30d';
    const auditFilters = {
        types: sp.auditTypes ? (sp.auditTypes as string).split(',') : [],
        actorId: (sp.auditActor as string) ?? '',
        range: auditRange,
        q: (sp.q as string) ?? '',
    };
    const auditPage = sp.auditPage ? Number(sp.auditPage) : 1;
    let auditData: Awaited<ReturnType<typeof getAuditEvents>> | null = null;
    let auditActors: { id: string; email: string }[] = [];
    let auditProperties: { id: string; name: string; address: string; shortCode: string | null }[] = [];

    if (tab === 'protokoll') {
        // Compute from date
        let auditFrom: string | undefined;
        const now = new Date();
        if (auditRange === '7d') auditFrom = new Date(now.getTime() - 7 * 86400000).toISOString();
        else if (auditRange === '30d') auditFrom = new Date(now.getTime() - 30 * 86400000).toISOString();
        else if (auditRange === '90d') auditFrom = new Date(now.getTime() - 90 * 86400000).toISOString();

        const auditTypes = auditFilters.types.length > 0 ? auditFilters.types : DEFAULT_AUDIT_TYPES;

        const [eventsResult, actorsResult, propsResult] = await Promise.all([
            getAuditEvents({
                types: auditTypes,
                actorId: auditFilters.actorId || undefined,
                from: auditFrom,
                query: auditFilters.q || undefined,
                page: auditPage,
                propertyId,
            }),
            getAuditActors(),
            getProperties(),
        ]);

        auditData = eventsResult;
        auditActors = actorsResult;
        auditProperties = propsResult;
    }

    // Stammdaten tab data
    let detailsData: Awaited<ReturnType<typeof getPropertyDetails>> = null;
    if (tab === 'stammdaten') {
        detailsData = await getPropertyDetails(propertyId);
    }

    return (
        <div className="w-full space-y-6">
            {/* ── Breadcrumb ── */}
            <nav className="flex items-center text-sm text-muted-foreground" aria-label="Breadcrumb">
                <Link href="/dashboard/warehouse" className="hover:text-foreground transition-colors">
                    Dokumentenarchiv
                </Link>
                <ChevronRight className="h-3.5 w-3.5 mx-1.5" />
                <Link href="/dashboard/warehouse" className="hover:text-foreground transition-colors">
                    Immobilien
                </Link>
                <ChevronRight className="h-3.5 w-3.5 mx-1.5" />
                <span className="text-foreground font-medium">
                    {property.shortCode ?? property.name}
                </span>
            </nav>

            {/* ── Property header ── */}
            <div className="space-y-2">
                <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-semibold text-foreground">{property.name}</h1>
                    {property.shortCode && (
                        <Badge variant="outline" className="text-xs font-mono">
                            {property.shortCode}
                        </Badge>
                    )}
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-6 pt-2">
                    <div className="flex items-center gap-1.5 text-sm">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-foreground">{totalDocs}</span>
                        <span className="text-muted-foreground">Dokumente</span>
                    </div>
                    {!readOnly && (
                        <div className={`flex items-center gap-1.5 text-sm ${needsReview > 0 ? 'text-amber-600' : ''}`}>
                            <AlertCircle className="h-4 w-4" />
                            <span className="font-medium">{needsReview}</span>
                            <span>zu prüfen</span>
                        </div>
                    )}
                    <div className="flex items-center gap-1.5 text-sm">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-foreground">{unitCount}</span>
                        <span className="text-muted-foreground">Einheiten</span>
                    </div>
                </div>
            </div>

            {/* ── Brain insight line ── */}
            {insightLine && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-200">
                    <Lightbulb className="h-4 w-4 shrink-0" />
                    <span>{insightLine}</span>
                </div>
            )}

            {/* ── Tab bar ── */}
            <AssetTabs propertyId={propertyId} activeTab={tab} />

            {/* ── Tab content ── */}
            {tab === 'dokumente' && foldersData && (
                <DokumenteTab
                    propertyId={propertyId}
                    foldersData={foldersData}
                    docs={propertyDocs.docs}
                    docsTotal={propertyDocs.total}
                    docsPage={sp.docPage ? Number(sp.docPage) : 1}
                    currentFilters={docFilters}
                    readOnly={readOnly}
                    unitCount={unitCount}
                />
            )}

            {tab === 'kosten' && costsData && (
                <PropertyCosts
                    propertyId={propertyId}
                    year={costYear}
                    kpis={costsData.kpis}
                    rows={costsData.rows}
                    total={costsData.total}
                    currentFilters={costFilters}
                    readOnly={readOnly}
                />
            )}

            {tab === 'protokoll' && auditData && (
                <PropertyAudit
                    events={auditData.events}
                    total={auditData.total}
                    page={auditPage}
                    propertyId={propertyId}
                    actors={auditActors}
                    properties={auditProperties}
                    currentFilters={auditFilters}
                />
            )}

            {tab === 'stammdaten' && detailsData && (
                <PropertyDetails
                    property={{
                        ...detailsData.property,
                        createdAt: detailsData.property.createdAt.toISOString(),
                    }}
                    units={detailsData.units}
                    meta={detailsData.meta}
                    readOnly={readOnly}
                />
            )}

            <PropertyChat propertyId={propertyId} />
        </div>
    );
}
