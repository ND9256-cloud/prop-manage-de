'use client';

import { useEffect, useState, useRef } from 'react';
import { X, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/warehouse/ui/status-badge';
import { SourceIcon } from '@/components/warehouse/ui/source-icon';
import { ConfidenceBar } from '@/components/warehouse/ui/confidence-bar';
import { getTriageDocument, updateExtractionField, applyReviewTask, quarantineDocument, logAuditEvent } from '@/lib/warehouse-actions';

type TriageData = Awaited<ReturnType<typeof getTriageDocument>>;

interface TriageOverlayProps {
    documentId: string;
    onClose: () => void;
    onApplied?: () => void;
    readOnly?: boolean;
}

// ─── Inline editable field ─────────────────────────────────────
function EditableField({
    label,
    fieldName,
    value,
    isDirty,
    onEdit,
    readOnly,
}: {
    label: string;
    fieldName: string;
    value: string | null | undefined;
    isDirty: boolean;
    onEdit: (fieldName: string, value: string) => void;
    readOnly?: boolean;
}) {
    const [local, setLocal] = useState(value ?? '');

    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
                {label}
                {!readOnly && isDirty && <span className="ml-1 text-amber-500">•</span>}
            </p>
            {readOnly ? (
                <p className="text-sm text-foreground px-2 py-1">{local || '—'}</p>
            ) : (
                <input
                    className={`w-full text-sm text-foreground bg-transparent rounded px-2 py-1 hover:bg-muted focus:bg-background focus:border focus:border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${isDirty ? 'border-l-2 border-amber-400 pl-2' : ''}`}
                    value={local}
                    onChange={(e) => setLocal(e.target.value)}
                    onBlur={() => onEdit(fieldName, local)}
                />
            )}
        </div>
    );
}

// ─── Main overlay component ───────────────────────────────────
export function TriageOverlay({ documentId, onClose, onApplied, readOnly }: TriageOverlayProps) {
    const [data, setData] = useState<TriageData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [editedFields, setEditedFields] = useState<Set<string>>(new Set());
    const [provenanceOpen, setProvenanceOpen] = useState(false);
    const [applying, setApplying] = useState(false);
    const [selectedPropertyId, setSelectedPropertyId] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('');
    const [selectedFilename, setSelectedFilename] = useState('');
    const [quarantineOpen, setQuarantineOpen] = useState(false);
    const [quarantineReason, setQuarantineReason] = useState('');
    const [quarantineNotes, setQuarantineNotes] = useState('');
    const [quarantining, setQuarantining] = useState(false);
    const [failedFields, setFailedFields] = useState<Set<string>>(new Set());
    const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getTriageDocument(documentId)
            .then((result) => {
                setData(result);
                // Initialize filing state from loaded data
                const d = result?.data?.document as Record<string, unknown> | undefined;
                setSelectedPropertyId((d?.property_id as string) ?? '');
                setSelectedCategory((d?.category as string) ?? '');
                setSelectedFilename((d?.display_name as string) ?? '');
            })
            .catch((e) => setError(String(e)))
            .finally(() => setLoading(false));
    }, [documentId]);

    // Debounced field save (400ms)
    function handleFieldEdit(fieldName: string, value: string) {
        setEditedFields((prev) => new Set(prev).add(fieldName));
        setSaveState('saving');

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

        saveTimerRef.current = setTimeout(async () => {
            try {
                const docId = (data?.data?.document as Record<string, unknown>)?.id as string;
                if (!docId) return;
                await updateExtractionField(docId, fieldName, value);
                setFailedFields((prev) => {
                    const next = new Set(prev);
                    next.delete(fieldName);
                    return next;
                });
                setSaveState('saved');
                setTimeout(() => setSaveState('idle'), 2000);
            } catch {
                setFailedFields((prev) => new Set(prev).add(fieldName));
                setSaveState('error');
            }
        }, 400);
    }

    const doc = data?.data?.document as Record<string, unknown> | undefined;
    const extraction = data?.data?.extraction;
    const signedUrl = data?.data?.signedUrl;
    const properties = data?.data?.properties ?? [];
    const confidence = data?.data?.confidence;
    const mimeType = (doc?.mime_type as string) ?? '';
    const displayName = (doc?.display_name as string) ?? (doc?.file_name as string) ?? documentId;
    const docType = (doc?.doc_type as string) ?? 'other';
    const fields = (extraction?.extracted_fields as Record<string, unknown>) ?? {};

    // ─── Apply handler ─────────────────────────────────────────
    async function handleApply() {
        if (!data?.data || applying) return;
        setApplying(true);
        try {
            // Flush pending debounced save
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }

            const triggerType = editedFields.size > 0 ? 'user_corrected' as const : 'user_confirmed' as const;
            const docId = doc?.id as string;
            const extractionId = extraction?.id as string;

            await applyReviewTask(
                docId,
                extractionId,
                docType,
                fields,
                selectedPropertyId || undefined,
                undefined, // unitId
                triggerType,
            );

            setEditedFields(new Set());
            onClose();
            onApplied?.();
        } catch (err) {
            console.error('Apply failed:', err);
        } finally {
            setApplying(false);
        }
    }

    // ─── Safe close with unsaved changes guard ─────────────────
    function safeClose() {
        if (saveState === 'saving') return;
        if (editedFields.size > 0) {
            const confirmed = window.confirm(
                'Sie haben ungespeicherte Änderungen.\n' +
                'Möchten Sie wirklich schließen?\n\n' +
                'You have unsaved changes.\n' +
                'Close anyway?'
            );
            if (!confirmed) return;
        }
        onClose();
    }

    // ─── Keyboard shortcuts ────────────────────────────────────
    useEffect(() => {
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                safeClose();
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleApply();
            }
        }
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    });

    // ─── Quarantine handler ────────────────────────────────────
    async function handleQuarantine() {
        if (!data?.data || !quarantineReason) return;
        setQuarantining(true);
        try {
            const docId = doc?.id as string;
            await quarantineDocument(docId, quarantineReason, quarantineNotes || null);
            setQuarantineOpen(false);
            onClose();
            onApplied?.();
        } catch (err) {
            console.error('Quarantine failed:', err);
        } finally {
            setQuarantining(false);
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 bg-background flex flex-col"
            style={{ animation: 'fadeIn 150ms ease' }}
        >
            <div className="flex flex-1 overflow-hidden">

                {/* ═══ LEFT — 60% preview ═══ */}
                <div className="w-[60%] flex flex-col border-r border-border">
                    <div className="h-14 flex items-center justify-between px-4 border-b border-border shrink-0">
                        <Button variant="ghost" size="sm" onClick={safeClose}>
                            <X className="h-4 w-4 mr-2" />
                            Schließen
                        </Button>
                        <span className="text-sm font-medium text-foreground truncate max-w-xs">
                            {displayName}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!signedUrl}
                            onClick={() => {
                                if (!signedUrl) return;
                                window.open(signedUrl, '_blank');
                                logAuditEvent({
                                    eventType: 'downloaded',
                                    documentId: doc?.id as string,
                                    propertyId: (doc?.property_id as string) ?? undefined,
                                    metadata: { display_name: displayName },
                                });
                            }}
                        >
                            <Download className="h-4 w-4 mr-2" />
                            Download
                        </Button>
                    </div>

                    {loading ? (
                        <div className="flex-1 bg-muted flex items-center justify-center">
                            <div className="text-sm text-muted-foreground animate-pulse">
                                Lädt... / Loading...
                            </div>
                        </div>
                    ) : error || data?.error ? (
                        <div className="flex-1 bg-muted flex items-center justify-center">
                            <div className="text-sm text-destructive">
                                Fehler: {error || data?.error}
                            </div>
                        </div>
                    ) : signedUrl && mimeType === 'application/pdf' ? (
                        <iframe
                            src={signedUrl}
                            className="w-full flex-1"
                            sandbox="allow-scripts allow-same-origin"
                            referrerPolicy="no-referrer"
                            title={displayName}
                        />
                    ) : signedUrl && mimeType.startsWith('image/') ? (
                        <div className="flex-1 bg-muted flex items-center justify-center p-4">
                            <img
                                src={signedUrl}
                                alt={displayName}
                                className="max-w-full max-h-full object-contain"
                            />
                        </div>
                    ) : (
                        <div className="flex-1 bg-muted flex flex-col items-center justify-center gap-4">
                            <p className="text-sm text-muted-foreground">
                                Vorschau nicht verfügbar / Preview not available
                            </p>
                            {signedUrl && (
                                <Button variant="outline" onClick={() => window.open(signedUrl, '_blank')}>
                                    <Download className="h-4 w-4 mr-2" />
                                    Download
                                </Button>
                            )}
                        </div>
                    )}
                </div>

                {/* ═══ RIGHT — 40% fields ═══ */}
                <div className="w-[40%] flex flex-col bg-card">

                    {/* Scrollable content */}
                    <div className="flex-1 overflow-y-auto p-6 pb-32 space-y-5">
                        {loading ? (
                            <p className="text-sm text-muted-foreground animate-pulse">
                                Dokument wird geladen...
                            </p>
                        ) : doc ? (
                            <>
                                {/* ── SECTION 1: Document info ── */}
                                <div className="space-y-3">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                        Dokument / Document
                                    </p>
                                    <p className="text-sm font-medium text-foreground">
                                        {displayName}
                                    </p>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Badge variant="outline">
                                            {docType}
                                        </Badge>
                                        <StatusBadge status={doc.status as string} />
                                        <SourceIcon source={(doc.source as 'email' | 'telegram' | 'ui') ?? 'ui'} />
                                        <span className="text-xs text-muted-foreground">
                                            {doc.created_at
                                                ? new Date(doc.created_at as string).toLocaleDateString('de-DE')
                                                : '—'}
                                        </span>
                                    </div>
                                </div>

                                <Separator />

                                {/* ── SECTION 2: Extracted fields ── */}
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Extrahierte Felder / Extracted Fields
                                        </p>
                                        {saveState === 'saving' && (
                                            <span className="text-xs text-muted-foreground">Speichert...</span>
                                        )}
                                        {saveState === 'saved' && (
                                            <span className="text-xs text-green-600">✓ Gespeichert</span>
                                        )}
                                        {saveState === 'error' && (
                                            <span className="text-xs text-destructive">✗ Fehler</span>
                                        )}
                                    </div>

                                    {docType === 'invoice' ? (
                                        <div className="space-y-2">
                                            <EditableField label="Anbieter / Vendor" fieldName="vendor_name" value={fields.vendor_name as string} isDirty={editedFields.has('vendor_name')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Betrag / Amount" fieldName="amount" value={fields.amount as string} isDirty={editedFields.has('amount')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Datum / Date" fieldName="invoice_date" value={fields.invoice_date as string} isDirty={editedFields.has('invoice_date')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Rechnungsnr." fieldName="invoice_number" value={fields.invoice_number as string} isDirty={editedFields.has('invoice_number')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Kategorie" fieldName="category_hint" value={fields.category_hint as string} isDirty={editedFields.has('category_hint')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                        </div>
                                    ) : docType === 'lease' ? (
                                        <div className="space-y-2">
                                            <EditableField label="Mieter / Tenant" fieldName="tenant_last_name" value={fields.tenant_last_name as string} isDirty={editedFields.has('tenant_last_name')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Einheit / Unit" fieldName="unit_ref" value={fields.unit_ref as string} isDirty={editedFields.has('unit_ref')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Kaltmiete" fieldName="rent_cold" value={fields.rent_cold as string} isDirty={editedFields.has('rent_cold')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Beginn / Start" fieldName="lease_start" value={fields.lease_start as string} isDirty={editedFields.has('lease_start')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                            <EditableField label="Ende / End" fieldName="lease_end" value={fields.lease_end as string} isDirty={editedFields.has('lease_end')} onEdit={handleFieldEdit} readOnly={readOnly} />
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            {(fields.summary as string) ?? 'Keine Felder verfügbar'}
                                        </p>
                                    )}
                                </div>

                                <Separator />

                                {/* ── SECTION 3: Filing decision ── */}
                                <div className="space-y-3">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                        Ablage / Filing
                                    </p>

                                    {/* Property */}
                                    <div className="space-y-1">
                                        <p className="text-xs text-muted-foreground">Immobilie / Property</p>
                                        <Select value={selectedPropertyId} onValueChange={setSelectedPropertyId}>
                                            <SelectTrigger className="text-sm">
                                                <SelectValue placeholder="Immobilie wählen..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {properties.map((p) => (
                                                    <SelectItem key={p.id} value={p.id}>
                                                        {p.name} — {p.address}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Category */}
                                    <div className="space-y-1">
                                        <p className="text-xs text-muted-foreground">Kategorie / Category</p>
                                        <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                                            <SelectTrigger className="text-sm">
                                                <SelectValue placeholder="Kategorie wählen..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {[
                                                    ['rechtliches', 'Rechtliches / Legal'],
                                                    ['finanzen', 'Finanzen / Financial'],
                                                    ['kosten_rechnungen', 'Kosten & Rechnungen / Costs'],
                                                    ['vertraege', 'Verträge / Contracts'],
                                                    ['instandhaltung', 'Instandhaltung / Maintenance'],
                                                    ['behoerden', 'Behörden / Authority'],
                                                    ['medien', 'Medien / Media'],
                                                ].map(([v, l]) => (
                                                    <SelectItem key={v} value={v}>
                                                        {l}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Filename */}
                                    <div className="space-y-1">
                                        <p className="text-xs text-muted-foreground">Dateiname / Filename</p>
                                        <Input
                                            className="text-sm"
                                            value={selectedFilename}
                                            onChange={(e) => setSelectedFilename(e.target.value)}
                                            placeholder="YYYYMMDD_Vendor_KO132_Desc"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Format: YYYYMMDD_Anbieter_Code_Typ
                                        </p>
                                    </div>
                                </div>

                                <Separator />

                                {/* ── SECTION 4: Provenance (collapsed) ── */}
                                <div className="space-y-2">
                                    <button
                                        onClick={() => setProvenanceOpen(!provenanceOpen)}
                                        className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide w-full text-left"
                                    >
                                        {provenanceOpen
                                            ? <ChevronDown className="h-3 w-3" />
                                            : <ChevronRight className="h-3 w-3" />
                                        }
                                        Herkunft / Provenance
                                    </button>

                                    {provenanceOpen && (
                                        <div className="space-y-2 bg-muted rounded-md p-3 text-sm">
                                            <div className="flex gap-2">
                                                <span>🤖</span>
                                                <span className="text-foreground">
                                                    {extraction?.model ?? 'Claude Haiku'}
                                                </span>
                                            </div>
                                            <div className="flex gap-2">
                                                <span>📅</span>
                                                <span className="text-muted-foreground">
                                                    {extraction?.created_at
                                                        ? new Date(extraction.created_at).toLocaleString('de-DE')
                                                        : '—'}
                                                </span>
                                            </div>
                                            <ConfidenceBar score={(confidence?.score ?? 0) * 100} />
                                            {confidence?.reason && (
                                                <div className="flex gap-2">
                                                    <span className="text-muted-foreground text-xs">Grund:</span>
                                                    <span className="text-xs text-foreground">{confidence.reason}</span>
                                                </div>
                                            )}
                                            <div className="flex gap-2">
                                                <span className="text-muted-foreground text-xs">Original:</span>
                                                <span className="text-xs text-foreground font-mono">
                                                    {doc.file_name as string}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs text-muted-foreground w-full"
                                        onClick={() =>
                                            window.open(
                                                `/dashboard/warehouse/audit?q=${encodeURIComponent(displayName)}`,
                                                '_blank',
                                            )
                                        }
                                    >
                                        Alle Aktivitäten für dieses Dokument →
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <p className="text-sm text-destructive">Keine Daten</p>
                        )}
                    </div>

                    {/* Sticky actions */}
                    {!readOnly && (
                        <div className="border-t border-border bg-card p-4 space-y-2">
                            <Button
                                className="w-full"
                                onClick={handleApply}
                                disabled={applying || saveState === 'saving' || !data?.data}
                            >
                                {applying
                                    ? 'Wird verbucht...'
                                    : saveState === 'saving'
                                        ? 'Speichert... / Saving...'
                                        : failedFields.size > 0
                                            ? '✓ Trotzdem verbuchen / Apply anyway'
                                            : '✓ Verbuchen / Apply'}
                            </Button>
                            {failedFields.size > 0 && (
                                <p className="text-xs text-amber-600 text-center">
                                    ⚠ {failedFields.size} Feld(er) nicht gespeichert / field(s) not saved
                                </p>
                            )}
                            <Button
                                variant="outline"
                                className="w-full text-destructive border-destructive hover:bg-destructive/10"
                                onClick={() => setQuarantineOpen(true)}
                                disabled={!data?.data}
                            >
                                🚫 Quarantäne / Quarantine
                            </Button>

                            {/* Quarantine dialog */}
                            <Dialog open={quarantineOpen} onOpenChange={setQuarantineOpen}>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle>Quarantäne / Quarantine</DialogTitle>
                                    </DialogHeader>
                                    <div className="space-y-4 py-2">
                                        <div className="space-y-2">
                                            <p className="text-sm text-muted-foreground">Grund / Reason *</p>
                                            <Select value={quarantineReason} onValueChange={setQuarantineReason}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Grund auswählen..." />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="suspicious">Verdächtige Datei / Suspicious file</SelectItem>
                                                    <SelectItem value="cannot_classify">Kann nicht klassifiziert / Cannot classify</SelectItem>
                                                    <SelectItem value="duplicate">Duplikat / Duplicate</SelectItem>
                                                    <SelectItem value="wrong_format">Falsches Format / Wrong format</SelectItem>
                                                    <SelectItem value="other">Sonstiges / Other</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <p className="text-sm text-muted-foreground">Notizen / Notes (optional)</p>
                                            <Textarea
                                                placeholder="Weitere Details..."
                                                value={quarantineNotes}
                                                onChange={(e) => setQuarantineNotes(e.target.value)}
                                                rows={3}
                                            />
                                        </div>
                                    </div>
                                    <DialogFooter>
                                        <Button variant="outline" onClick={() => setQuarantineOpen(false)}>
                                            Abbrechen / Cancel
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            onClick={handleQuarantine}
                                            disabled={!quarantineReason || quarantining}
                                        >
                                            {quarantining ? 'Wird gespeichert...' : 'Bestätigen / Confirm'}
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
