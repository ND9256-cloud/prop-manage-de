'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Copy, Check, ExternalLink } from 'lucide-react';
import type { AuditEvent } from '@/lib/warehouse-actions';

// ─── Event badge colors (same as table) ─────────────────────
const EVENT_COLORS: Record<string, string> = {
    uploaded: 'bg-blue-50 text-blue-700 border-blue-200',
    applied: 'bg-green-50 text-green-700 border-green-200',
    quarantined: 'bg-amber-50 text-amber-700 border-amber-200',
    unquarantined: 'bg-gray-50 text-gray-700 border-gray-200',
    dismissed: 'bg-gray-50 text-gray-700 border-gray-200',
    downloaded: 'bg-blue-50 text-blue-700 border-blue-200',
    invited: 'bg-blue-50 text-blue-700 border-blue-200',
    role_changed: 'bg-amber-50 text-amber-700 border-amber-200',
    apply_failed: 'bg-red-50 text-red-700 border-red-200',
    processing_failed: 'bg-red-50 text-red-700 border-red-200',
};

const EVENT_LABELS: Record<string, string> = {
    uploaded: 'Hochgeladen / Uploaded',
    applied: 'Verbucht / Applied',
    quarantined: 'Quarantäne / Quarantined',
    unquarantined: 'Freigegeben / Unquarantined',
    dismissed: 'Verworfen / Dismissed',
    downloaded: 'Heruntergeladen / Downloaded',
    invited: 'Eingeladen / Invited',
    role_changed: 'Rolle geändert / Role changed',
    apply_failed: 'Fehler / Apply failed',
    processing_failed: 'Fehler / Processing failed',
};

const METADATA_LABELS: Record<string, string> = {
    trigger_type: 'Auslöser / Trigger',
    vendor_name: 'Anbieter / Vendor',
    amount: 'Betrag / Amount',
    doc_type: 'Dokumenttyp / Doc type',
    reason: 'Grund / Reason',
    notes: 'Notizen / Notes',
    file_name: 'Dateiname / Filename',
    display_name: 'Anzeigename / Display name',
    source: 'Quelle / Source',
    mime_type: 'MIME Typ',
    old_role: 'Alte Rolle / Old role',
    new_role: 'Neue Rolle / New role',
    invited_email: 'Eingeladene E-Mail',
};

interface AuditDetailSheetProps {
    event: AuditEvent | null;
    onClose: () => void;
    properties: { id: string; name: string; address: string; shortCode: string | null }[];
}

export function AuditDetailSheet({ event, onClose, properties }: AuditDetailSheetProps) {
    const [copied, setCopied] = useState(false);

    if (!event) return null;

    const propMatch = properties.find((p) => p.id === event.property_id);
    const metaEntries = Object.entries(event.metadata).filter(([, v]) => v != null && v !== '');

    function copyId() {
        navigator.clipboard.writeText(event!.id);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    return (
        <Sheet open={!!event} onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="w-[480px] sm:w-[480px] overflow-y-auto" aria-live="polite">
                <SheetHeader className="space-y-4 pb-4">
                    <div className="flex items-center gap-3">
                        <Badge
                            variant="outline"
                            className={`text-sm px-3 py-1 ${EVENT_COLORS[event.event_type] ?? ''}`}
                        >
                            {EVENT_LABELS[event.event_type] ?? event.event_type}
                        </Badge>
                    </div>
                    <SheetTitle className="text-lg">
                        {new Date(event.created_at).toLocaleString('de-DE', {
                            dateStyle: 'full',
                            timeStyle: 'medium',
                        })}
                    </SheetTitle>
                </SheetHeader>

                <div className="space-y-6 pt-2">
                    {/* ── Section 1: Actor ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Akteur / Actor
                        </p>
                        <p className="text-sm text-foreground">{event.actor_email ?? 'System'}</p>
                        <code className="text-xs text-muted-foreground font-mono">
                            {event.actor_user_id}
                        </code>
                    </div>

                    {/* ── Section 2: Target ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Ziel / Target
                        </p>
                        {event.document_id ? (
                            <div className="space-y-1">
                                <p className="text-sm text-foreground">
                                    {(event.metadata.display_name as string) ??
                                        (event.metadata.file_name as string) ??
                                        event.document_id}
                                </p>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs text-muted-foreground"
                                    onClick={() =>
                                        window.open(
                                            `/dashboard/warehouse/inbox?documentId=${event.document_id}`,
                                            '_blank',
                                        )
                                    }
                                >
                                    <ExternalLink className="h-3 w-3 mr-1" />
                                    Dokument öffnen / Open document
                                </Button>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">—</p>
                        )}
                        {propMatch && (
                            <Badge variant="outline" className="text-xs">
                                {propMatch.shortCode ?? propMatch.name} — {propMatch.address}
                            </Badge>
                        )}
                    </div>

                    {/* ── Section 3: Metadata ── */}
                    {metaEntries.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Metadaten / Metadata
                            </p>
                            <dl className="space-y-2">
                                {metaEntries.map(([key, value]) => (
                                    <div key={key} className="flex gap-4">
                                        <dt className="text-xs text-muted-foreground w-32 shrink-0">
                                            {METADATA_LABELS[key] ?? key}
                                        </dt>
                                        <dd className="text-xs text-foreground font-mono">
                                            {String(value)}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    )}

                    {/* ── Section 4: Event ID ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Event ID
                        </p>
                        <div className="flex items-center gap-2">
                            <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                                {event.id}
                            </code>
                            <Button variant="ghost" size="sm" onClick={copyId} className="h-7 w-7 p-0">
                                {copied ? (
                                    <Check className="h-3 w-3 text-green-600" />
                                ) : (
                                    <Copy className="h-3 w-3" />
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    );
}
