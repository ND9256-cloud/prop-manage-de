'use client';

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { FileText, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { Money, ResolutionStatus, ResolverConfidence } from '@/lib/resolvers/types';
import type { ProvenanceDocument, ProvenanceClaim } from '@/lib/dashboard-actions';

export interface ProvenanceModalState {
    unit_ref: string;
    value: Money | null;
    confidence: ResolverConfidence;
    status: ResolutionStatus;
    resolver: { name: string; version: string };
    source_claim_ids: string[];
    source_document_ids: string[];
    documents: ProvenanceDocument[];
    claims: ProvenanceClaim[];
}

interface Props {
    state: ProvenanceModalState;
    onClose: () => void;
}

const fmtEur = (cents: number) =>
    (cents / 100).toLocaleString('de-DE', {
        style: 'currency',
        currency: 'EUR',
    });

const fmtDate = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const confidenceLabel: Record<ResolverConfidence, string> = {
    high: 'hoch',
    medium: 'mittel',
    low: 'niedrig',
};

const statusLabel: Record<ResolutionStatus, string> = {
    single_active_claim: 'Eindeutiger Beleg',
    latest_active_claim_with_conflicts: 'Konflikt: jüngster Beleg gewählt',
    no_active_claim: 'Kein Beleg gefunden',
    no_claim_for_date: 'Kein Beleg zu diesem Datum',
};

export default function ProvenanceModal({ state, onClose }: Props) {
    const primaryClaim = state.claims[0];
    const validFrom = fmtDate(primaryClaim?.valid_from ?? null);

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent
                className="sm:max-w-xl"
                data-testid="provenance-modal"
            >
                <DialogHeader>
                    <DialogTitle className="flex items-baseline gap-3">
                        <span>Beleg · {state.unit_ref}</span>
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-5">
                    {/* The resolved fact */}
                    <section>
                        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                            Aufgelöster Wert
                        </div>
                        <div className="flex items-baseline gap-3">
                            <span className="text-2xl font-semibold tabular-nums">
                                {state.value ? fmtEur(state.value.amount) : '—'}
                            </span>
                            {state.value && (
                                <span className="text-sm text-muted-foreground">
                                    Kaltmiete{validFrom ? ` · gültig ab ${validFrom}` : ''}
                                </span>
                            )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <Badge variant="outline" className="text-[10px] uppercase tracking-wider px-1.5 py-0">
                                Konfidenz: {confidenceLabel[state.confidence]}
                            </Badge>
                            <span>·</span>
                            <span>{statusLabel[state.status]}</span>
                        </div>
                    </section>

                    {/* Source documents */}
                    <section>
                        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                            Quelle
                        </div>
                        {state.documents.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Keine Quelldokumente verknüpft.
                            </p>
                        ) : (
                            <ul className="space-y-2" data-testid="provenance-documents">
                                {state.documents.map(doc => (
                                    <li
                                        key={doc.id}
                                        className="flex items-start gap-2 rounded-md border bg-card p-3"
                                        data-document-id={doc.id}
                                    >
                                        <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate">
                                                {doc.file_name}
                                            </div>
                                            <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                                                {doc.doc_type && (
                                                    <span className="uppercase tracking-wider">
                                                        {doc.doc_type}
                                                    </span>
                                                )}
                                                {doc.category && doc.doc_type && <span>·</span>}
                                                {doc.category && <span>{doc.category}</span>}
                                            </div>
                                        </div>
                                        <Link
                                            href={`/dashboard/warehouse/inbox?doc=${doc.id}`}
                                            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                                        >
                                            Öffnen
                                            <ExternalLink className="h-3 w-3" />
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {/* Claim chain */}
                    {state.claims.length > 0 && (
                        <section>
                            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                                Behauptungskette
                            </div>
                            <ul className="space-y-1.5 text-xs font-mono" data-testid="provenance-claims">
                                {state.claims.map((c, i) => (
                                    <li
                                        key={c.id}
                                        className="flex items-baseline gap-2"
                                        data-claim-id={c.id}
                                    >
                                        <span className="text-muted-foreground">
                                            {i === 0 ? '★' : '·'}
                                        </span>
                                        <span className="truncate" title={c.id}>
                                            {c.id.slice(0, 8)}
                                        </span>
                                        {c.source_field_path && (
                                            <span className="text-muted-foreground truncate">
                                                {c.source_field_path}
                                            </span>
                                        )}
                                        {c.valid_from && (
                                            <span className="text-muted-foreground ml-auto">
                                                {fmtDate(c.valid_from)}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[11px] text-muted-foreground mt-2">
                                Resolver: {state.resolver.name}@{state.resolver.version}
                            </p>
                        </section>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
