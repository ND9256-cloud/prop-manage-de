'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    FileText,
    Building2,
    Brain,
    ChevronDown,
} from 'lucide-react';
import type { BrainSummary, RentRollSnapshotPayload } from '@/lib/dashboard-actions';
import RentRollComposer from './rent-roll-composer';

type PropertyCard = {
    id: string;
    name: string;
    address: string;
    city: string;
    zip: string;
    shortCode: string | null;
    totalSqm: number | null;
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
    rentRollSnapshots?: RentRollSnapshotPayload[];
    appVersion?: string;
};

export default function PropertySelection({ stats, propertyCards, role, brainSummaries = [], rentRollSnapshots = [], appVersion = 'unknown' }: Props) {
    const router = useRouter();
    const [selectedPropertyId, setSelectedPropertyId] = useState<string>('');

    const isViewer = role === 'viewer';


    return (
        <div
            className="space-y-6"
            data-testid="warehouse-properties-loaded"
            data-property-count={propertyCards.length}
            data-app-version={appVersion}
        >
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
                <h2 className="text-lg font-semibold mb-3">Immobilien</h2>
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
                        return {
                            ...p,
                            rentRoll: brain?.rentRoll,
                            shortCode: brain?.shortCode ?? p.shortCode,
                            address: brain?.address || p.address,
                            city: brain?.city || p.city,
                            zip: brain?.zip || p.zip,
                            totalSqm: brain?.totalSqm ?? p.totalSqm,
                        };
                    });

                    const totalUnits = rows.reduce((sum, r) => sum + (r.rentRoll?.current_tenants ?? 0), 0);
                    const totalSqm = rows.reduce((sum, r) => sum + (r.totalSqm ?? 0), 0);
                    const totalMonthly = rows.reduce((sum, r) => sum + (r.rentRoll?.monthly_gross_cold ?? 0), 0);
                    const totalAnnual = rows.reduce((sum, r) => sum + (r.rentRoll?.annual_gross_cold ?? 0), 0);

                    return (
                        <div className="rounded-md border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b bg-muted/50">
                                        <th className="text-left font-medium px-4 py-2">Objekt</th>
                                        <th className="text-right font-medium px-4 py-2">Einheiten</th>
                                        <th className="text-right font-medium px-4 py-2">Mietfläche</th>
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
                                                <div className="font-semibold">{r.shortCode ?? r.name}</div>
                                                <div className="text-xs text-muted-foreground">{r.address}, {r.zip} {r.city}</div>
                                            </td>
                                            <td className="text-right px-4 py-2">{r.rentRoll?.current_tenants ?? '–'}</td>
                                            <td className="text-right px-4 py-2">{r.totalSqm != null ? `${Math.round(r.totalSqm)} m²` : '–'}</td>
                                            <td className="text-right px-4 py-2">{fmt(r.rentRoll?.monthly_gross_cold)}</td>
                                            <td className="text-right px-4 py-2">{fmt(r.rentRoll?.annual_gross_cold)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t bg-muted/50 font-semibold">
                                        <td className="px-4 py-2">Gesamt</td>
                                        <td className="text-right px-4 py-2">{totalUnits || '–'}</td>
                                        <td className="text-right px-4 py-2">{totalSqm > 0 ? `${Math.round(totalSqm)} m²` : '–'}</td>
                                        <td className="text-right px-4 py-2">{fmt(totalMonthly)}</td>
                                        <td className="text-right px-4 py-2">{fmt(totalAnnual)}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    );
                })()}
            </div>

            {/* Composer-driven rent roll (Task 3.3) */}
            {rentRollSnapshots.length > 0 && (
                <RentRollComposer payloads={rentRollSnapshots} role={role} />
            )}

            {/* Immobilien-Analyse section */}
            {brainSummaries.length > 0 && (() => {
                const defaultBrain = brainSummaries.find((b) => {
                    const pc = propertyCards.find((p) => p.id === b.propertyId);
                    return pc?.shortCode === 'KO132';
                }) ?? brainSummaries[0];

                const selectedBrain = brainSummaries.find((b) => b.propertyId === selectedPropertyId) ?? defaultBrain;
                const analysis = selectedBrain.analysis as Record<string, unknown>;

                // Property overview
                const overview = analysis?.property_overview as { summary?: string } | undefined;

                // Risk signals
                const riskSignals = analysis?.risk_signals as { high?: string[] } | undefined;
                const highRisks = riskSignals?.high ?? [];

                // Action items
                const actionItems = analysis?.action_items as { urgent?: { action?: string; reason?: string; deadline?: string }[] } | undefined;
                const urgentActions = actionItems?.urgent ?? [];

                return (
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-lg font-semibold flex items-center gap-2">
                                <Brain className="h-5 w-5" />
                                Immobilien-Analyse
                            </h2>
                            <div className="relative">
                                <select
                                    className="appearance-none rounded-md border border-border bg-card pl-3 pr-8 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                                    value={selectedBrain.propertyId}
                                    onChange={(e) => setSelectedPropertyId(e.target.value)}
                                >
                                    {brainSummaries.map((b) => {
                                        const pc = propertyCards.find((p) => p.id === b.propertyId);
                                        return (
                                            <option key={b.propertyId} value={b.propertyId}>
                                                {pc?.address ?? b.propertyId}{pc?.shortCode ? ` (${pc.shortCode})` : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                            </div>
                        </div>

                        <Card>
                            <CardContent className="p-4 space-y-4">
                                {/* Property status description */}
                                {overview?.summary && (
                                    <p className="text-sm text-muted-foreground line-clamp-2">
                                        {overview.summary}
                                    </p>
                                )}

                                {/* High risks in red */}
                                {!isViewer && highRisks.length > 0 && (
                                    <div className="space-y-1">
                                        {highRisks.map((risk, i) => (
                                            <div key={i} className="flex items-center gap-2 text-xs">
                                                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 uppercase shrink-0">
                                                    Hoch
                                                </Badge>
                                                <span className="text-red-600 dark:text-red-400">{risk}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* First urgent action */}
                                {!isViewer && urgentActions.length > 0 && urgentActions[0]?.action && (
                                    <div className="flex items-center gap-2 text-xs">
                                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-400 text-orange-600 bg-orange-50 shrink-0">
                                            Dringend
                                        </Badge>
                                        <span>{urgentActions[0].action}</span>
                                    </div>
                                )}

                                {/* Timestamp */}
                                <p className="text-[11px] text-muted-foreground pt-2 border-t">
                                    Erstellt: {new Date(selectedBrain.generatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    {selectedBrain.isStale && (
                                        <Badge variant="outline" className="ml-2 text-yellow-600 border-yellow-400 bg-yellow-50 text-[10px] px-1.5 py-0">
                                            Aktualisierung verfügbar
                                        </Badge>
                                    )}
                                </p>
                            </CardContent>
                        </Card>
                    </div>
                );
            })()}

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
