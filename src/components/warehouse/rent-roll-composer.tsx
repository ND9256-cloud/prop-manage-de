'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Brain, ChevronDown, Upload } from 'lucide-react';
import type { RentRollSnapshotPayload } from '@/lib/dashboard-actions';
import ProvenanceModal, { type ProvenanceModalState } from './provenance-modal';

interface Props {
    payloads: RentRollSnapshotPayload[];
    role: string;
    defaultPropertyShortCode?: string;
    selectedPropertyId?: string;
    showHeader?: boolean;
}

const fmtEur = (cents: number) =>
    (cents / 100).toLocaleString('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    });

const fmtLegacyEur = (eur: number) =>
    eur.toLocaleString('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    });

export default function RentRollComposer({
    payloads,
    role,
    defaultPropertyShortCode = 'KO132',
    selectedPropertyId,
    showHeader = true,
}: Props) {
    const [internalSelectedId, setInternalSelectedId] = useState<string>('');
    const [modal, setModal] = useState<ProvenanceModalState | null>(null);

    const defaultPayload = useMemo(
        () =>
            payloads.find(p => p.shortCode === defaultPropertyShortCode) ?? payloads[0],
        [payloads, defaultPropertyShortCode]
    );
    const effectiveId = selectedPropertyId ?? internalSelectedId;
    const active = payloads.find(p => p.propertyId === effectiveId) ?? defaultPayload;

    if (!active) return null;

    const isViewer = role === 'viewer';
    const { snapshot, legacyByUnitRef, provenance } = active;
    const { rows, summary } = snapshot;

    const vermietungsquotePct =
        summary.total_units === 0 ? 0 : Math.round(summary.vermietungsquote * 100);

    return (
        <div data-testid="rent-roll-composer">
            {showHeader && (
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Brain className="h-5 w-5" />
                        Mietübersicht
                    </h2>
                    {payloads.length > 1 && (
                        <div className="relative">
                            <select
                                className="appearance-none rounded-md border border-border bg-card pl-3 pr-8 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                                value={active.propertyId}
                                onChange={e => setInternalSelectedId(e.target.value)}
                            >
                                {payloads.map(p => (
                                    <option key={p.propertyId} value={p.propertyId}>
                                        {p.address || p.propertyName}
                                        {p.shortCode ? ` (${p.shortCode})` : ''}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                        </div>
                    )}
                </div>
            )}

            <Card>
                <CardContent className="p-4 space-y-3">
                    {/* Understated header stat */}
                    <div className="flex items-end justify-between border-b pb-2">
                        <div>
                            <h3 className="text-sm font-semibold tracking-tight">
                                Einheiten
                            </h3>
                            <p className="text-[11px] text-muted-foreground">
                                {summary.total_units} {summary.total_units === 1 ? 'Einheit' : 'Einheiten'}
                                {summary.needs_review_units > 0 ? ` · ${summary.needs_review_units} zu prüfen` : ''}
                            </p>
                        </div>
                        <div className="text-right">
                            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                                Vermietungsquote
                            </div>
                            <div
                                className="text-sm font-medium tabular-nums"
                                data-testid="vermietungsquote-stat"
                                title={`${summary.occupied_units} von ${summary.total_units} Einheiten vermietet`}
                            >
                                {vermietungsquotePct}%
                            </div>
                        </div>
                    </div>

                    <div className="rounded-md border">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                                    <th className="text-left font-medium px-3 py-2">Einheit</th>
                                    <th className="text-left font-medium px-3 py-2">Mieter</th>
                                    <th className="text-right font-medium px-3 py-2">Mietfläche</th>
                                    <th className="text-right font-medium px-3 py-2">Kaltmiete</th>
                                    <th className="text-left font-medium px-3 py-2">Status</th>
                                </tr>
                            </thead>
                            <tbody data-testid="rent-roll-rows">
                                {rows.map(row => (
                                    <RentRollRowView
                                        key={row.unit_ref}
                                        row={row}
                                        propertyId={active.propertyId}
                                        legacy={legacyByUnitRef[row.unit_ref]}
                                        provenance={provenance}
                                        onProvenanceOpen={state => setModal(state)}
                                        isViewer={isViewer}
                                    />
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t bg-muted/50 font-semibold">
                                    <td className="px-3 py-2" colSpan={3}>
                                        Summe
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">
                                        {summary.resolved_kaltmiete_total
                                            ? fmtEur(summary.resolved_kaltmiete_total.amount)
                                            : '—'}
                                    </td>
                                    <td />
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    {summary.needs_review_units > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                            Konfliktbehaftete Mietverträge fließen nicht in die Summe — bitte
                            zuerst prüfen.
                        </p>
                    )}
                </CardContent>
            </Card>

            {modal && <ProvenanceModal state={modal} onClose={() => setModal(null)} />}
        </div>
    );

    type RentRollRowType = (typeof rows)[number];

    function RentRollRowView({
        row,
        propertyId,
        legacy,
        provenance,
        onProvenanceOpen,
        isViewer,
    }: {
        row: RentRollRowType;
        propertyId: string;
        legacy: RentRollSnapshotPayload['legacyByUnitRef'][string] | undefined;
        provenance: RentRollSnapshotPayload['provenance'];
        onProvenanceOpen: (state: ProvenanceModalState) => void;
        isViewer: boolean;
    }) {
        const kalt = row.current_kaltmiete;
        const hasResolved = kalt.value !== null;
        // Composer's `vacant` (phantom + tenancy_ended) is an authoritative
        // absence, not a coverage gap — never overlay legacy on it. Legacy
        // fallback is reserved for non-vacant rows the composer left empty
        // (defensive; rare with the current rent_roll module).
        const composerAuthoritativeAbsent = row.occupancy_status === 'vacant';
        const useLegacy =
            !hasResolved &&
            !composerAuthoritativeAbsent &&
            legacy?.monthly_rent != null;

        const openProvenance = () => {
            if (!hasResolved) return;
            const docs = kalt.source_document_ids
                .map(id => provenance.documents[id])
                .filter((d): d is RentRollSnapshotPayload['provenance']['documents'][string] => !!d);
            const claims = kalt.source_claim_ids
                .map(id => provenance.claims[id])
                .filter((c): c is RentRollSnapshotPayload['provenance']['claims'][string] => !!c);
            onProvenanceOpen({
                unit_ref: row.unit_ref,
                value: kalt.value,
                confidence: kalt.confidence,
                status: kalt.status,
                resolver: kalt.resolver,
                source_claim_ids: kalt.source_claim_ids,
                source_document_ids: kalt.source_document_ids,
                documents: docs,
                claims,
            });
        };

        return (
            <tr
                className="border-b last:border-0 group"
                data-unit-ref={row.unit_ref}
                data-occupancy-status={row.occupancy_status}
            >
                <td className="px-3 py-2 font-medium">{row.unit_ref}</td>
                <td className="px-3 py-2 text-muted-foreground italic">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {row.size_sqm != null ? `${row.size_sqm.toLocaleString('de-DE')} m²` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                    {hasResolved && kalt.value ? (
                        <button
                            type="button"
                            onClick={openProvenance}
                            className="inline-flex items-center gap-1.5 font-medium tabular-nums underline decoration-dotted underline-offset-4 hover:decoration-solid focus:outline-none focus:ring-2 focus:ring-ring rounded-sm px-0.5"
                            data-testid={`kaltmiete-${row.unit_ref}`}
                            data-action="open-provenance"
                            aria-label={`Beleg für ${row.unit_ref} öffnen`}
                        >
                            {fmtEur(kalt.value.amount)}
                            {kalt.confidence !== 'high' && (
                                <span
                                    className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400"
                                    title={`Konfidenz: ${kalt.confidence}`}
                                >
                                    {kalt.confidence === 'medium' ? 'mittel' : 'niedrig'}
                                </span>
                            )}
                        </button>
                    ) : useLegacy ? (
                        <span
                            className="inline-flex items-center gap-1.5 tabular-nums text-muted-foreground"
                            data-testid={`kaltmiete-${row.unit_ref}-legacy`}
                        >
                            {fmtLegacyEur(legacy!.monthly_rent!)}
                            <Badge
                                variant="outline"
                                className="text-[9px] uppercase tracking-wider px-1.5 py-0 border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-700"
                            >
                                Legacy
                            </Badge>
                        </span>
                    ) : (
                        <span className="text-muted-foreground">—</span>
                    )}
                </td>
                <td className="px-3 py-2">
                    <StatusCell
                        row={row}
                        propertyId={propertyId}
                        useLegacy={useLegacy}
                        isViewer={isViewer}
                    />
                </td>
            </tr>
        );
    }
}

function StatusCell({
    row,
    propertyId,
    useLegacy,
    isViewer,
}: {
    row: import('@/lib/composer/modules/rent-roll').RentRollRow;
    propertyId: string;
    useLegacy: boolean;
    isViewer: boolean;
}) {
    if (row.occupancy_status === 'occupied' || useLegacy) {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Vermietet
            </span>
        );
    }
    if (row.occupancy_status === 'needs_review') {
        return (
            <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wider px-1.5 py-0 border-amber-400 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-700"
            >
                Prüfen
            </Badge>
        );
    }
    // vacant
    if (row.vacancy_reason === 'no_data') {
        return (
            <a
                href={`/dashboard/warehouse/${propertyId}`}
                data-action="upload-lease"
                data-unit-ref={row.unit_ref}
                data-property-id={propertyId}
                className={`inline-flex items-center gap-1.5 text-xs ${
                    isViewer
                        ? 'text-muted-foreground pointer-events-none'
                        : 'text-foreground hover:text-primary'
                }`}
                aria-disabled={isViewer}
            >
                <Upload className="h-3 w-3" />
                Kein Mietvertrag hinterlegt
            </a>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" />
            Leerstand
        </span>
    );
}
