'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getDocumentPreview } from '@/lib/warehouse-actions';
import { X, Download, Loader2, ExternalLink } from 'lucide-react';

type Props = {
    documentId: string;
    onClose: () => void;
};

type PreviewData = {
    document: {
        id: string;
        file_name: string;
        display_name: string | null;
        doc_type: string | null;
        status: string;
        source: string;
        mime_type: string;
        storage_path: string;
        file_size_bytes: number;
        retention_until: string | null;
        created_at: string;
    };
    extraction: {
        extracted_fields: Record<string, unknown>;
        confidence_score: number;
        flags: unknown;
    } | null;
    signedUrl: string | null;
};

function formatDateTimeDE(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateDE(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

const sourceLabels: Record<string, string> = {
    email: '📧 E-Mail',
    telegram: '📱 Telegram',
    ui: '🖥️ Web-Upload',
};

function FieldRow({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
        <div className="flex justify-between py-1.5 border-b border-muted last:border-0">
            <span className="text-muted-foreground text-sm">{label}</span>
            <span className="text-sm font-medium text-right max-w-[60%] truncate">{String(value)}</span>
        </div>
    );
}

function ConfidenceBar({ score }: { score: number }) {
    const pct = Math.round(score * 100);
    const color = pct >= 95 ? 'bg-green-500' : pct >= 65 ? 'bg-amber-500' : 'bg-red-500';
    return (
        <div className="space-y-1">
            <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">KI-Konfidenz / AI Confidence</span>
                <span className="font-medium">{pct}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

function InvoiceFields({ f }: { f: Record<string, unknown> }) {
    return (
        <>
            <FieldRow label="Anbieter" value={f.vendor_name as string} />
            <FieldRow label="Betrag" value={f.amount ? `${f.amount} ${f.currency || 'EUR'}` : undefined} />
            <FieldRow label="Datum" value={formatDateDE(f.invoice_date as string)} />
            <FieldRow label="Rechnungsnr." value={f.invoice_number as string} />
            <FieldRow label="Beschreibung" value={f.description as string} />
            <FieldRow label="Kategorie" value={f.category_hint as string} />
        </>
    );
}

function LeaseFields({ f }: { f: Record<string, unknown> }) {
    const tenant = [f.tenant_first_name, f.tenant_last_name].filter(Boolean).join(' ');
    const address = [f.address_street, f.address_number].filter(Boolean).join(' ');
    return (
        <>
            <FieldRow label="Mieter" value={tenant || undefined} />
            <FieldRow label="Adresse" value={address || undefined} />
            <FieldRow label="Einheit" value={f.unit_ref as string} />
            <FieldRow label="Kaltmiete" value={f.rent_cold ? `${f.rent_cold} EUR` : undefined} />
            <FieldRow label="Warmmiete" value={f.rent_warm ? `${f.rent_warm} EUR` : undefined} />
            <FieldRow label="Beginn" value={formatDateDE(f.lease_start as string)} />
            <FieldRow label="Ende" value={f.lease_end ? formatDateDE(f.lease_end as string) : 'Unbefristet'} />
        </>
    );
}

function InspectionFields({ f }: { f: Record<string, unknown> }) {
    const damages = Array.isArray(f.damages) ? (f.damages as string[]).join(', ') : f.damages as string;
    const meters = typeof f.meter_readings === 'object' && f.meter_readings
        ? Object.entries(f.meter_readings as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(', ')
        : f.meter_readings as string;
    return (
        <>
            <FieldRow label="Datum" value={formatDateDE(f.inspection_date as string)} />
            <FieldRow label="Einheit" value={f.unit_ref as string} />
            <FieldRow label="Zustand" value={f.condition_summary as string} />
            <FieldRow label="Zählerstände" value={meters || undefined} />
            <FieldRow label="Schäden" value={damages || undefined} />
        </>
    );
}

function OtherFields({ f }: { f: Record<string, unknown> }) {
    const keyDates = Array.isArray(f.key_dates) ? (f.key_dates as string[]).join(', ') : f.key_dates as string;
    const keyAmounts = Array.isArray(f.key_amounts) ? (f.key_amounts as string[]).join(', ') : f.key_amounts as string;
    return (
        <>
            <FieldRow label="Zusammenfassung" value={f.summary as string} />
            <FieldRow label="Schlüsseldaten" value={keyDates || undefined} />
            <FieldRow label="Beträge" value={keyAmounts || undefined} />
        </>
    );
}

export default function DocumentPreviewPanel({ documentId, onClose }: Props) {
    const [data, setData] = useState<PreviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getDocumentPreview(documentId).then(result => {
            if (result.error || !result.data) {
                setError(result.error || 'Failed to load');
            } else {
                setData(result.data);
            }
            setLoading(false);
        });
    }, [documentId]);

    // Close on ESC
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    }, [onClose]);

    const doc = data?.document;
    const ext = data?.extraction;
    const fields = ext?.extracted_fields || {};

    return (
        <div
            className="fixed inset-0 z-50 flex justify-end bg-black/30"
            onClick={handleBackdropClick}
        >
            <div className="w-full max-w-[40vw] min-w-[380px] bg-background shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-300">
                {loading ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : error ? (
                    <div className="p-6 text-center text-muted-foreground">
                        <p>{error}</p>
                        <Button variant="outline" className="mt-4" onClick={onClose}>Schließen</Button>
                    </div>
                ) : doc ? (
                    <div className="flex flex-col">
                        {/* Panel Header */}
                        <div className="sticky top-0 z-10 bg-background border-b p-4 flex items-center justify-between">
                            <h2 className="font-semibold text-base truncate pr-4">
                                {doc.display_name || doc.file_name}
                            </h2>
                            <div className="flex items-center gap-2 shrink-0">
                                {data?.signedUrl && (
                                    <Button variant="outline" size="sm" asChild>
                                        <a href={data.signedUrl} target="_blank" rel="noopener noreferrer">
                                            <Download className="mr-1.5 h-3.5 w-3.5" />
                                            Download
                                        </a>
                                    </Button>
                                )}
                                <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>

                        <div className="p-4 space-y-4">
                            {/* File Preview */}
                            {data?.signedUrl && (
                                <Card>
                                    <CardContent className="p-0 overflow-hidden rounded-lg">
                                        {doc.mime_type === 'application/pdf' ? (
                                            <iframe
                                                src={data.signedUrl}
                                                className="w-full border-0"
                                                style={{ height: '500px' }}
                                                title="PDF Preview"
                                            />
                                        ) : doc.mime_type?.startsWith('image/') ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={data.signedUrl}
                                                alt={doc.display_name || doc.file_name}
                                                className="w-full object-contain"
                                                style={{ maxHeight: '500px' }}
                                            />
                                        ) : (
                                            <div className="p-8 text-center text-muted-foreground bg-muted">
                                                <p className="mb-2">Vorschau nicht verfügbar / Preview not available</p>
                                                <Button variant="outline" asChild>
                                                    <a href={data.signedUrl} target="_blank" rel="noopener noreferrer">
                                                        <ExternalLink className="mr-2 h-4 w-4" />
                                                        Herunterladen / Download
                                                    </a>
                                                </Button>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            )}

                            {/* Extracted Fields */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">Extrahierte Daten / Extracted Data</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {ext ? (
                                        <div>
                                            {doc.doc_type === 'invoice' && <InvoiceFields f={fields} />}
                                            {doc.doc_type === 'lease' && <LeaseFields f={fields} />}
                                            {doc.doc_type === 'inspection_report' && <InspectionFields f={fields} />}
                                            {!['invoice', 'lease', 'inspection_report'].includes(doc.doc_type || '') && <OtherFields f={fields} />}
                                        </div>
                                    ) : (
                                        <div className="p-4 bg-muted rounded-md text-sm text-muted-foreground text-center">
                                            Keine Extraktionsdaten verfügbar
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            {/* Confidence Bar */}
                            {ext && (
                                <Card>
                                    <CardContent className="p-4">
                                        <ConfidenceBar score={ext.confidence_score} />
                                    </CardContent>
                                </Card>
                            )}

                            {/* Metadata */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">Metadaten / Metadata</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <FieldRow label="Hochgeladen" value={formatDateTimeDE(doc.created_at)} />
                                    <FieldRow label="Quelle" value={sourceLabels[doc.source] || doc.source} />
                                    <FieldRow label="Aufbewahrung bis" value={formatDateDE(doc.retention_until)} />
                                    <FieldRow label="Originaldatei" value={doc.file_name} />
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
