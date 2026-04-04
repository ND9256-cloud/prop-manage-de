'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    FileText,
    AlertTriangle,
    Building2,

    AlertCircle,
    XCircle,
    Brain,
} from 'lucide-react';
import type { BrainSummary, LastVisitStats } from '@/lib/dashboard-actions';

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
    lastVisitStats?: LastVisitStats;
};

export default function PropertySelection({ stats, propertyCards, role, brainSummaries = [], lastVisitStats }: Props) {
    const router = useRouter();

    const isOperator = role === 'service_operator' || role === 'owner';
    const isViewer = role === 'viewer';


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

            {/* Portfolio KPI strip */}
            {brainSummaries.length > 0 && (() => {
                const objekte = propertyCards.length;
                const einheiten = brainSummaries.reduce((sum, b) => sum + b.rentRoll.current_tenants, 0);
                const mieteMonat = brainSummaries.reduce((sum, b) => sum + b.rentRoll.monthly_gross_cold, 0);
                const totalUnitsFromAnalysis = brainSummaries.reduce((sum, b) => {
                    const ua = (b.analysis as Record<string, unknown>)?.unit_analysis as { units_identified?: unknown[] } | undefined;
                    return sum + (Array.isArray(ua?.units_identified) ? ua.units_identified.length : b.rentRoll.current_tenants);
                }, 0);
                const vermietungsquote = totalUnitsFromAnalysis > 0 ? Math.round((einheiten / totalUnitsFromAnalysis) * 100) : 0;

                const kpis = [
                    { label: 'Objekte', value: String(objekte) },
                    { label: 'Einheiten', value: String(einheiten) },
                    { label: 'Miete/Monat', value: mieteMonat.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }), green: true },
                    { label: 'Vermietungsquote', value: `${vermietungsquote} %` },
                ];

                return (
                    <div className="flex items-center divide-x divide-border rounded-lg border border-border bg-card px-2 py-3">
                        {kpis.map((kpi) => (
                            <div key={kpi.label} className="flex-1 text-center px-4">
                                <div className={`text-lg font-semibold ${kpi.green ? 'text-green-600 dark:text-green-400' : ''}`}>{kpi.value}</div>
                                <div className="text-xs text-muted-foreground">{kpi.label}</div>
                            </div>
                        ))}
                    </div>
                );
            })()}

            {/* Holdings table */}
            <div>
                <h2 className="text-lg font-semibold mb-1">Immobilien</h2>
                <p className="text-sm text-muted-foreground mb-3">
                    {stats.total} Dokumente &middot; {stats.photos} Fotos
                </p>
                {propertyCards.length === 0 ? (
                    <Card>
                        <CardContent className="p-8 text-center text-muted-foreground">
                            <Building2 className="mx-auto h-10 w-10 mb-2 opacity-40" />
                            <p>Keine Immobilien vorhanden.</p>
                        </CardContent>
                    </Card>
                ) : (() => {
                    const fmt = (v: number | undefined) =>
                        v != null ? v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '–';

                    const rows = propertyCards.map((p) => {
                        const brain = brainSummaries.find((b) => b.propertyId === p.id);
                        return { ...p, rentRoll: brain?.rentRoll };
                    });

                    const totalUnits = rows.reduce((sum, r) => sum + (r.rentRoll?.current_tenants ?? 0), 0);
                    const totalMonthly = rows.reduce((sum, r) => sum + (r.rentRoll?.monthly_gross_cold ?? 0), 0);
                    const totalAnnual = rows.reduce((sum, r) => sum + (r.rentRoll?.annual_gross_cold ?? 0), 0);

                    return (
                        <div className="rounded-md border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b bg-muted/50">
                                        <th className="text-left font-medium px-4 py-2">Objekt</th>
                                        <th className="text-right font-medium px-4 py-2">Einheiten</th>
                                        <th className="text-right font-medium px-4 py-2">Miete/Monat</th>
                                        <th className="text-right font-medium px-4 py-2">Miete/Jahr</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((r) => (
                                        <tr
                                            key={r.id}
                                            className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                                            onClick={() => router.push(`/dashboard/warehouse/${r.id}`)}
                                        >
                                            <td className="px-4 py-2">
                                                <span className="font-medium">{r.address}</span>
                                                {r.shortCode && (
                                                    <Badge variant="secondary" className="ml-2 text-xs">
                                                        {r.shortCode}
                                                    </Badge>
                                                )}
                                            </td>
                                            <td className="text-right px-4 py-2">{r.rentRoll?.current_tenants ?? '–'}</td>
                                            <td className="text-right px-4 py-2">{fmt(r.rentRoll?.monthly_gross_cold)}</td>
                                            <td className="text-right px-4 py-2">{fmt(r.rentRoll?.annual_gross_cold)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t bg-muted/50 font-semibold">
                                        <td className="px-4 py-2">Gesamt</td>
                                        <td className="text-right px-4 py-2">{totalUnits || '–'}</td>
                                        <td className="text-right px-4 py-2">{fmt(totalMonthly)}</td>
                                        <td className="text-right px-4 py-2">{fmt(totalAnnual)}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    );
                })()}
            </div>

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
                                    <CardContent className="pt-0 space-y-2">
                                        {/* Property status summary (2 lines max) */}
                                        {overview?.summary && (
                                            <p className="text-sm text-muted-foreground line-clamp-2">
                                                {overview.summary}
                                            </p>
                                        )}

                                        {/* High risk line (hidden for viewer) */}
                                        {!isViewer && highRisks.length > 0 && (
                                            <div className="flex items-center gap-2 text-xs">
                                                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 uppercase">
                                                    Risiken Hoch
                                                </Badge>
                                                <span className="text-red-600 dark:text-red-400 line-clamp-1">{highRisks[0]}</span>
                                            </div>
                                        )}

                                        {/* First urgent action (hidden for viewer) */}
                                        {!isViewer && urgentActions.length > 0 && urgentActions[0]?.action && (
                                            <div className="flex items-center gap-2 text-xs">
                                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-400 text-orange-600 bg-orange-50">
                                                    Dringend
                                                </Badge>
                                                <span className="line-clamp-1">{urgentActions[0].action}</span>
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

            {/* Status bar */}
            <div className="flex items-center justify-between rounded-lg bg-gray-100 dark:bg-gray-800/50 px-4 py-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                    Alle Dokumente verarbeitet
                </span>
                <span>{stats.photos} Fotos im Archiv</span>
            </div>

        </div>
    );
}
