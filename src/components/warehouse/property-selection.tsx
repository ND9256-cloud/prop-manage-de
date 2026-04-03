'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    FileText,
    AlertTriangle,
    Building2,
    Camera,
    AlertCircle,
    XCircle,
    Brain,
} from 'lucide-react';
import type { BrainSummary } from '@/lib/dashboard-actions';

type PropertyCard = {
    id: string;
    name: string;
    address: string;
    shortCode: string | null;
    totalDocs: number;
    needsReview: number;
    failed: number;
    photos: number;
    buckets: {
        kosten: number;
        versicherungen_vertraege: number;
        behoerden: number;
        sonstiges: number;
    };
};

type Stats = {
    total: number;
    needs_review: number;
    applied_this_month: number;
    properties_with_docs: number;
    photos: number;
    failed: number;
    unknown: number;
};

type Props = {
    stats: Stats;
    propertyCards: PropertyCard[];
    role: string;
    brainSummaries?: BrainSummary[];
};

export default function PropertySelection({ stats, propertyCards, role, brainSummaries = [] }: Props) {
    const router = useRouter();

    const isOperator = role === 'service_operator' || role === 'owner';
    const isViewer = role === 'viewer';


    return (
        <div className="space-y-6">
            {/* Page header */}
            <div>
                <h1 className="text-2xl font-bold">Dokumentenarchiv</h1>
            </div>

            {/* Portfolio bar */}
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Building2 className="h-4 w-4" />
                <span className="font-medium text-foreground">{propertyCards.length}</span> Objekte
                <span className="mx-1">&middot;</span>
                <FileText className="h-4 w-4" />
                <span className="font-medium text-foreground">{stats.total}</span> Dokumente
                <span className="mx-1">&middot;</span>
                <Camera className="h-4 w-4" />
                <span className="font-medium text-foreground">{stats.photos}</span> Fotos
            </div>

            {/* Property cards grid */}
            <div>
                <h2 className="text-lg font-semibold mb-3">Immobilien</h2>
                {propertyCards.length === 0 ? (
                    <Card>
                        <CardContent className="p-8 text-center text-muted-foreground">
                            <Building2 className="mx-auto h-10 w-10 mb-2 opacity-40" />
                            <p>Keine Immobilien vorhanden.</p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {propertyCards.map((p) => (
                            <Card
                                key={p.id}
                                className="cursor-pointer hover:shadow-md transition-shadow"
                                onClick={() => router.push(`/dashboard/warehouse/${p.id}`)}
                            >
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold">
                                        {p.address}
                                    </CardTitle>
                                    {p.shortCode && (
                                        <Badge variant="secondary" className="w-fit mt-1 text-xs">
                                            {p.shortCode}
                                        </Badge>
                                    )}
                                </CardHeader>
                                <CardContent className="pt-0 space-y-2">
                                    {/* Category rows */}
                                    <div className="space-y-1 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Kosten</span>
                                            <span className="font-medium">{p.buckets.kosten}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Verträge & Vers.</span>
                                            <span className="font-medium">{p.buckets.versicherungen_vertraege}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Behörden</span>
                                            <span className="font-medium">{p.buckets.behoerden}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Sonstiges</span>
                                            <span className="font-medium">{p.buckets.sonstiges}</span>
                                        </div>
                                    </div>

                                    {/* Operator badges */}
                                    {role !== 'viewer' && (p.needsReview > 0 || p.failed > 0) && (
                                        <div className="flex gap-2 pt-1">
                                            {p.needsReview > 0 && (
                                                <Badge variant="outline" className="text-amber-600 border-amber-300">
                                                    {p.needsReview} zur Prüfung
                                                </Badge>
                                            )}
                                            {p.failed > 0 && (
                                                <Badge variant="outline" className="text-red-600 border-red-300">
                                                    {p.failed} fehlgeschlagen
                                                </Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Footer: total doc count */}
                                    <div className="pt-2 border-t text-xs text-muted-foreground flex items-center gap-1.5">
                                        <FileText className="h-3.5 w-3.5" />
                                        {p.totalDocs} Dokumente
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* Photo bar */}
            {stats.photos > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
                    <Camera className="h-4 w-4" />
                    <span>{stats.photos} Fotos im Archiv</span>
                </div>
            )}

            {/* Attention section (operator only) */}
            {isOperator && (stats.unknown > 0 || stats.failed > 0 || stats.needs_review > 0) && (
                <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                    <CardContent className="p-4 space-y-2">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-amber-600" />
                            Handlungsbedarf
                        </h3>
                        <div className="flex flex-wrap gap-3 text-sm">
                            {stats.unknown > 0 && (
                                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    {stats.unknown} nicht klassifiziert
                                </span>
                            )}
                            {stats.failed > 0 && (
                                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                                    <XCircle className="h-3.5 w-3.5" />
                                    {stats.failed} fehlgeschlagen
                                </span>
                            )}
                            {stats.needs_review > 0 && (
                                <Button
                                    variant="link"
                                    className="h-auto p-0 text-sm text-amber-700 dark:text-amber-400"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        router.push('/dashboard/warehouse/inbox');
                                    }}
                                >
                                    {stats.needs_review} zur Prüfung
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Immobilien-Analyse section */}
            {brainSummaries.length > 0 && (
                <div>
                    <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <Brain className="h-5 w-5" />
                        Immobilien-Analyse
                    </h2>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {brainSummaries.map((brain) => {
                            const analysis = brain.analysis as Record<string, unknown>;
                            const propertyCard = propertyCards.find((p) => p.id === brain.propertyId);
                            const propertyName = propertyCard?.address ?? brain.propertyId;
                            const propertyCode = propertyCard?.shortCode;

                            // Extract fields from brain analysis
                            const overview = analysis?.property_overview as { summary?: string } | undefined;
                            const tenantData = analysis?.tenant_overview as { identified_tenants?: { name?: string; unit_ref?: string; rent_cold?: number }[] } | undefined;
                            const tenants = tenantData?.identified_tenants ?? [];
                            const riskSignals = analysis?.risk_signals as { high?: string[] } | undefined;
                            const highRisks = riskSignals?.high ?? [];
                            const actionItems = analysis?.action_items as { urgent?: { action?: string; reason?: string; deadline?: string }[] } | undefined;
                            const urgentActions = actionItems?.urgent ?? [];

                            return (
                                <Card key={brain.propertyId}>
                                    <CardHeader className="pb-2">
                                        <div className="flex items-center justify-between">
                                            <CardTitle className="text-base font-semibold">
                                                {propertyName}
                                                {propertyCode && (
                                                    <Badge variant="secondary" className="ml-2 text-xs">
                                                        {propertyCode}
                                                    </Badge>
                                                )}
                                            </CardTitle>
                                            {brain.isStale && (
                                                <Badge variant="outline" className="text-yellow-600 border-yellow-400 bg-yellow-50 text-xs">
                                                    Aktualisierung verfügbar
                                                </Badge>
                                            )}
                                        </div>
                                    </CardHeader>
                                    <CardContent className="pt-0 space-y-3">
                                        {/* Property status summary */}
                                        {overview?.summary && (
                                            <p className="text-sm text-muted-foreground line-clamp-3">
                                                {overview.summary}
                                            </p>
                                        )}

                                        {/* Tenant list */}
                                        {tenants.length > 0 && (
                                            <div>
                                                <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Mieter</h4>
                                                <ul className="text-sm space-y-0.5">
                                                    {tenants.map((t, i) => (
                                                        <li key={i} className="flex items-center gap-1 text-xs">
                                                            <span className="text-muted-foreground">{t.unit_ref ?? '–'}</span>
                                                            <span className="mx-0.5">–</span>
                                                            <span>{t.name ?? 'Unbekannt'}</span>
                                                            {t.rent_cold != null && (
                                                                <>
                                                                    <span className="mx-0.5">–</span>
                                                                    <span className="font-medium">{t.rent_cold.toLocaleString('de-DE')} €</span>
                                                                </>
                                                            )}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {/* High risks (top 2, hidden for viewer) */}
                                        {!isViewer && highRisks.length > 0 && (
                                            <div>
                                                <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Risiken (hoch)</h4>
                                                <ul className="text-sm space-y-0.5">
                                                    {highRisks.slice(0, 2).map((risk, i) => (
                                                        <li key={i} className="text-xs text-red-600 dark:text-red-400">
                                                            {risk}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {/* First urgent action (hidden for viewer) */}
                                        {!isViewer && urgentActions.length > 0 && urgentActions[0]?.action && (
                                            <div>
                                                <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Nächste Maßnahme</h4>
                                                <div className="flex items-center gap-2 text-xs">
                                                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                                                        Dringend
                                                    </Badge>
                                                    <span>{urgentActions[0].action}</span>
                                                </div>
                                            </div>
                                        )}

                                        {/* Timestamp */}
                                        <p className="text-[11px] text-muted-foreground pt-1 border-t">
                                            Erstellt: {new Date(brain.generatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                </div>
            )}

        </div>
    );
}
