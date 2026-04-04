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
import { getTriageDocument, updateExtractionField, applyReviewTask, updateDocumentMetadata, quarantineDocument, logAuditEvent } from '@/lib/warehouse-actions';
import { getCategoryHintLabel } from '@/lib/warehouse-categories';

type TriageData = Awaited<ReturnType<typeof getTriageDocument>>;

interface TriageOverlayProps {
    documentId: string;
    onClose: () => void;
    onApplied?: () => void;
    readOnly?: boolean;
}

// ─── Inline editable field ─────────────────────────────────────
function formatFieldDisplay(fieldName: string, value: string | null | undefined): string {
    if (!value) return '';
    // Format amount/currency fields as German number
    if (['amount', 'rent_cold'].includes(fieldName)) {
        const num = parseFloat(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
        if (!isNaN(num)) return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EUR';
    }
    // Format date fields as DD.MM.YYYY
    if (['invoice_date', 'lease_start', 'lease_end'].includes(fieldName)) {
        const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    }
    return String(value);
}

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
    const [focused, setFocused] = useState(false);
    const display = formatFieldDisplay(fieldName, isDirty ? local : value);

    return (
        <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
                {label}
                {!readOnly && isDirty && <span className="ml-1 text-amber-500">•</span>}
            </p>
            {readOnly ? (
                <p className="text-sm text-foreground px-2 py-1">{display || '—'}</p>
            ) : focused ? (
                <input
                    className={`w-full text-sm text-foreground bg-transparent rounded px-2 py-1 hover:bg-muted focus:bg-background focus:border focus:border-border focus:outline-none focus:ring-1 focus:ring-ring transition-colors ${isDirty ? 'border-l-2 border-amber-400 pl-2' : ''}`}
                    value={local}
                    autoFocus
                    onChange={(e) => setLocal(e.target.value)}
                    onBlur={() => { setFocused(false); onEdit(fieldName, local); }}
                />
            ) : (
                <p
                    className={`w-full text-sm text-foreground bg-transparent rounded px-2 py-1 hover:bg-muted cursor-text transition-colors ${isDirty ? 'border-l-2 border-amber-400 pl-2' : ''}`}
                    onClick={() => setFocused(true)}
                >
                    {display || '—'}
                </p>
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
                setSelectedFilename((d?.file_name as string) ?? '');
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
    const intelligenceSummary = data?.data?.intelligenceSummary ?? null;
    const mimeType = (doc?.mime_type as string) ?? '';
    const displayName = (doc?.file_name as string) ?? documentId;
    const docType = (doc?.doc_type as string) ?? 'other';
    const category = (doc?.category as string) ?? '';
    const fields = (extraction?.extracted_fields as Record<string, unknown>) ?? {};

    // Determine field layout from category (doc_type uses open German taxonomy)
    const isInvoiceLike = category === 'kosten_rechnungen' || category === 'instandhaltung' || category === 'finanzen';
    const isLeaseLike = category === 'vertraege';

    // Helper: check if extraction field has a non-empty value
    const hasValue = (v: unknown) => v != null && String(v).trim() !== '';

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

            const docId = doc?.id as string;
            const extractionId = extraction?.id as string;
            const originalFilename = (doc?.file_name as string) ?? '';
            const originalCategory = (doc?.category as string) ?? '';

            // Persist filename/category changes before applying
            const filenameChanged = selectedFilename !== originalFilename && selectedFilename !== '';
            const categoryChanged = selectedCategory !== originalCategory && selectedCategory !== '';
            if (filenameChanged || categoryChanged) {
                const metaResult = await updateDocumentMetadata(
                    docId,
                    filenameChanged ? selectedFilename : (doc?.display_name as string) ?? originalFilename,
                    categoryChanged ? selectedCategory : originalCategory,
                );
                if (metaResult?.error) {
                    setError(metaResult.error);
                    return;
                }
            }

            const triggerType = editedFields.size > 0 || filenameChanged || categoryChanged
                ? 'user_corrected' as const
                : 'user_confirmed' as const;

            const result = await applyReviewTask(
                docId,
                extractionId,
                docType,
                fields,
                selectedPropertyId || undefined,
                undefined, // unitId
                triggerType,
            );

            if (result?.error) {
                setError(result.error);
                return;
            }

            setEditedFields(new Set());
            onClose();
            onApplied?.();
        } catch (err) {
            console.error('Apply failed:', err);
            setError(err instanceof Error ? err.message : 'Verbuchen fehlgeschlagen');
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
                'Möchten Sie wirklich schließen?'
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
                                Lädt...
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
                            className="w-full flex-1 min-h-0"
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
                                Vorschau nicht verfügbar
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
                                        Dokument
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
                                        <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                                            {doc.created_at
                                                ? new Date(doc.created_at as string).toLocaleDateString('de-DE')
                                                : '—'}
                                        </span>
                                    </div>
                                    {intelligenceSummary && (
                                        <p className="text-sm text-muted-foreground leading-relaxed">
                                            {intelligenceSummary}
                                        </p>
                                    )}
                                </div>

                                <Separator />

                                {/* ── SECTION 2: Extracted fields ── */}
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Extrahierte Felder
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

                                    {isInvoiceLike ? (() => {
                                        const invoiceFields = [
                                            { label: 'Anbieter', fieldName: 'vendor_name', value: fields.vendor_name },
                                            { label: 'Betrag', fieldName: 'amount', value: fields.amount },
                                            { label: 'Datum', fieldName: 'invoice_date', value: fields.invoice_date },
                                            { label: 'Rechnungsnr.', fieldName: 'invoice_number', value: fields.invoice_number },
                                            { label: 'Kategorie', fieldName: 'category_hint', value: getCategoryHintLabel(fields.category_hint as string) },
                                        ].filter(f => hasValue(f.value) || editedFields.has(f.fieldName));
                                        return invoiceFields.length > 0 ? (
                                            <div className="space-y-2">
                                                {invoiceFields.map(f => (
                                                    <EditableField key={f.fieldName} label={f.label} fieldName={f.fieldName} value={f.value as string} isDirty={editedFields.has(f.fieldName)} onEdit={handleFieldEdit} readOnly={readOnly} />
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">Keine Felder verfügbar</p>
                                        );
                                    })() : isLeaseLike ? (() => {
                                        const leaseFields = [
                                            { label: 'Mieter', fieldName: 'tenant_last_name', value: fields.tenant_last_name },
                                            { label: 'Einheit', fieldName: 'unit_ref', value: fields.unit_ref },
                                            { label: 'Kaltmiete', fieldName: 'rent_cold', value: fields.rent_cold },
                                            { label: 'Beginn', fieldName: 'lease_start', value: fields.lease_start },
                                            { label: 'Ende', fieldName: 'lease_end', value: fields.lease_end },
                                        ].filter(f => hasValue(f.value) || editedFields.has(f.fieldName));
                                        return leaseFields.length > 0 ? (
                                            <div className="space-y-2">
                                                {leaseFields.map(f => (
                                                    <EditableField key={f.fieldName} label={f.label} fieldName={f.fieldName} value={f.value as string} isDirty={editedFields.has(f.fieldName)} onEdit={handleFieldEdit} readOnly={readOnly} />
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">Keine Felder verfügbar</p>
                                        );
                                    })() : (() => {
                                        const populatedFields = Object.entries(fields).filter(([, val]) => hasValue(val));
                                        return populatedFields.length > 0 ? (
                                            <div className="space-y-2">
                                                {populatedFields.map(([key, val]) => (
                                                    <EditableField key={key} label={key} fieldName={key} value={String(val)} isDirty={editedFields.has(key)} onEdit={handleFieldEdit} readOnly={readOnly} />
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-muted-foreground">Keine Felder verfügbar</p>
                                        );
                                    })()}
                                </div>

                                <Separator />

                                {/* ── SECTION 3: Filing decision ── */}
                                <div className="space-y-3">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                        Ablage
                                    </p>

                                    {/* Property */}
                                    <div className="space-y-1">
                                        <p className="text-xs text-muted-foreground">Immobilie</p>
                                        <Select value={selectedPropertyId} onValueChange={setSelectedPropertyId}>
                                            <SelectTrigger className="text-sm">
                                                <SelectValue placeholder="Immobilie wählen..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {properties.map((p) => (
                                                    <SelectItem key={p.id} value={p.id}>
                                                        {p.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Category */}
                                    <div className="space-y-1">
                                        <p className="text-xs text-muted-foreground">Kategorie</p>
                                        <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                                            <SelectTrigger className="text-sm">
                                                <SelectValue placeholder="Kategorie wählen..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {[
                                                    ['rechtliches', 'Rechtliches'],
                                                    ['finanzen', 'Finanzen'],
                                                    ['kosten_rechnungen', 'Kosten & Rechnungen'],
                                                    ['vertraege', 'Verträge'],
                                                    ['instandhaltung', 'Instandhaltung'],
                                                    ['behoerden', 'Behörden'],
                                                    ['medien', 'Medien'],
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
                                        <p className="text-xs text-muted-foreground">Dateiname</p>
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
                                        Herkunft
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
                                                <span className="text-muted-foreground" suppressHydrationWarning>
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
                                        ? 'Speichert...'
                                        : failedFields.size > 0
                                            ? '✓ Trotzdem verbuchen'
                                            : '✓ Verbuchen'}
                            </Button>
                            {failedFields.size > 0 && (
                                <p className="text-xs text-amber-600 text-center">
                                    ⚠ {failedFields.size} Feld(er) nicht gespeichert
                                </p>
                            )}
                            <Button
                                variant="outline"
                                className="w-full text-amber-700 border-amber-300 bg-amber-50 hover:bg-amber-100"
                                onClick={() => setQuarantineOpen(true)}
                                disabled={!data?.data}
                            >
                                🚫 Aussortieren
                            </Button>
                            <p className="text-xs text-muted-foreground text-center">
                                Dokument wird ausgeblendet und nicht weiter verarbeitet
                            </p>

                            {/* Quarantine dialog */}
                            <Dialog open={quarantineOpen} onOpenChange={setQuarantineOpen}>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle>Aussortieren</DialogTitle>
                                    </DialogHeader>
                                    <div className="space-y-4 py-2">
                                        <div className="space-y-2">
                                            <p className="text-sm text-muted-foreground">Grund *</p>
                                            <Select value={quarantineReason} onValueChange={setQuarantineReason}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Grund auswählen..." />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="suspicious">Verdächtige Datei</SelectItem>
                                                    <SelectItem value="cannot_classify">Kann nicht klassifiziert werden</SelectItem>
                                                    <SelectItem value="duplicate">Duplikat</SelectItem>
                                                    <SelectItem value="wrong_format">Falsches Format</SelectItem>
                                                    <SelectItem value="other">Sonstiges</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <p className="text-sm text-muted-foreground">Notizen (optional)</p>
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
                                            Abbrechen
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            onClick={handleQuarantine}
                                            disabled={!quarantineReason || quarantining}
                                        >
                                            {quarantining ? 'Wird gespeichert...' : 'Bestätigen'}
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
