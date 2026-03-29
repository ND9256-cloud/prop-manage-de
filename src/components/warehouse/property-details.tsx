'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Building2, Check, Loader2, X } from 'lucide-react';
import { updatePropertyField } from '@/lib/warehouse-actions';

// ─── Types ────────────────────────────────────────────────────
interface PropertyData {
    id: string;
    name: string;
    address: string;
    short_code: string | null;
    notes: string | null;
    organizationId: string;
    createdAt: string;
}

interface UnitData {
    id: string;
    label: string;
    floor: string | null;
    size: number | null;
    status: string | null;
}

interface MetaData {
    lastAppliedAt: string | null;
    totalDocuments: number;
}

interface PropertyDetailsProps {
    property: PropertyData;
    units: UnitData[];
    meta: MetaData;
    readOnly?: boolean;
}

// ─── Inline edit field ────────────────────────────────────────
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function InlineField({
    label,
    hint,
    value,
    field,
    propertyId,
    multiline,
    transform,
    readOnly,
}: {
    label: string;
    hint?: string;
    value: string;
    field: string;
    propertyId: string;
    multiline?: boolean;
    transform?: (v: string) => string;
    readOnly?: boolean;
}) {
    const [current, setCurrent] = useState(value);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const save = useCallback(
        async (newValue: string) => {
            const clean = transform ? transform(newValue) : newValue;
            if (clean === value && saveState !== 'error') return;
            setSaveState('saving');
            try {
                const result = await updatePropertyField(propertyId, field, clean);
                if (result.error) {
                    setSaveState('error');
                } else {
                    setSaveState('saved');
                    setTimeout(() => setSaveState('idle'), 2000);
                }
            } catch {
                setSaveState('error');
            }
        },
        [propertyId, field, value, saveState, transform],
    );

    const handleChange = useCallback(
        (val: string) => {
            const transformed = transform ? transform(val) : val;
            setCurrent(transformed);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => save(transformed), 400);
        },
        [save, transform],
    );

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    const handleBlur = useCallback(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        const clean = transform ? transform(current) : current;
        save(clean);
    }, [current, save, transform]);

    return (
        <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{label}</label>
            <div className="relative">
                {readOnly ? (
                    <p className="px-3 py-2 text-sm text-foreground">{current || '—'}</p>
                ) : multiline ? (
                    <textarea
                        className="w-full px-3 py-2 text-sm bg-transparent border border-transparent rounded-md hover:bg-muted focus:bg-background focus:border-border focus:outline-none transition-colors resize-none"
                        rows={3}
                        value={current}
                        onChange={(e) => handleChange(e.target.value)}
                        onBlur={handleBlur}
                        placeholder="Interne Notizen..."
                        aria-label={label}
                    />
                ) : (
                    <input
                        type="text"
                        className="w-full px-3 py-2 text-sm bg-transparent border border-transparent rounded-md hover:bg-muted focus:bg-background focus:border-border focus:outline-none transition-colors"
                        value={current}
                        onChange={(e) => handleChange(e.target.value)}
                        onBlur={handleBlur}
                        aria-label={label}
                    />
                )}
                {!readOnly && (
                    <span className="absolute right-2 top-2 text-xs">
                        {saveState === 'saving' && (
                            <span className="text-muted-foreground flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" /> Saving...
                            </span>
                        )}
                        {saveState === 'saved' && (
                            <span className="text-green-600 flex items-center gap-1">
                                <Check className="h-3 w-3" /> Saved
                            </span>
                        )}
                        {saveState === 'error' && (
                            <span className="text-red-600 flex items-center gap-1">
                                <X className="h-3 w-3" /> Error
                            </span>
                        )}
                    </span>
                )}
            </div>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

// ─── Main component ──────────────────────────────────────────
export function PropertyDetails({ property, units, meta, readOnly }: PropertyDetailsProps) {
    const router = useRouter();

    return (
        <div className="space-y-8 max-w-2xl">
            {/* ── Section 1: Immobiliendaten ── */}
            <div className="space-y-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Immobiliendaten
                </h3>

                <InlineField
                    label="Kurzcode"
                    hint="Max. 5 Zeichen, Großbuchstaben"
                    value={property.short_code ?? ''}
                    field="short_code"
                    propertyId={property.id}
                    transform={(v) => v.toUpperCase().slice(0, 5)}
                    readOnly={readOnly}
                />

                <InlineField
                    label="Adresse"
                    value={property.address}
                    field="address"
                    propertyId={property.id}
                    readOnly={readOnly}
                />

                <InlineField
                    label="Notizen"
                    value={property.notes ?? ''}
                    field="notes"
                    propertyId={property.id}
                    multiline
                    readOnly={readOnly}
                />
            </div>

            {/* ── Section 2: Einheiten ── */}
            <Separator />
            <div className="space-y-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Einheiten
                </h3>

                {units.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                        <Building2 className="h-8 w-8" />
                        <p className="text-sm font-medium">Keine Einheiten erfasst</p>
                        <p className="text-xs">
                            Einheiten werden aus dem PM-System synchronisiert
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="border border-border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-muted/50">
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Einheit
                                        </th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Etage
                                        </th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Größe
                                        </th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                            Status
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {units.map((unit) => (
                                        <tr key={unit.id} className="border-b border-border last:border-0">
                                            <td className="px-4 py-3 text-sm font-medium text-foreground">
                                                {unit.label}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">
                                                {unit.floor ?? '—'}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">
                                                {unit.size != null ? `${unit.size} m²` : '—'}
                                            </td>
                                            <td className="px-4 py-3">
                                                {unit.status === 'occupied' ? (
                                                    <span className="flex items-center gap-1.5 text-sm">
                                                        <span className="h-2 w-2 rounded-full bg-green-500" />
                                                        Vermietet
                                                    </span>
                                                ) : unit.status === 'vacant' ? (
                                                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                                        <span className="h-2 w-2 rounded-full bg-gray-300" />
                                                        Leer
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Einheiten werden im PM-System verwaltet
                        </p>
                    </>
                )}
            </div>

            {/* ── Section 3: Verwalter ── */}
            <Separator />
            <div className="space-y-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Verwalter
                </h3>
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <p className="text-sm text-muted-foreground">
                        Verwalterzuweisungen werden unter Team konfiguriert
                    </p>
                    {!readOnly && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="mt-2 text-xs"
                            onClick={() => router.push('/dashboard/settings/users')}
                        >
                            Zu Team →
                        </Button>
                    )}
                </div>
            </div>

            {/* ── Section 4: Metadaten ── */}
            <Separator />
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2">
                <div>
                    <dt className="text-xs text-muted-foreground">Erstellt</dt>
                    <dd className="text-xs text-foreground font-mono" suppressHydrationWarning>
                        {new Date(property.createdAt).toLocaleDateString('de-DE')}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Zuletzt verbucht</dt>
                    <dd className="text-xs text-foreground font-mono" suppressHydrationWarning>
                        {meta.lastAppliedAt
                            ? new Date(meta.lastAppliedAt).toLocaleDateString('de-DE')
                            : '—'}
                    </dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Dokumente gesamt</dt>
                    <dd className="text-xs text-foreground font-mono">{meta.totalDocuments}</dd>
                </div>
                <div>
                    <dt className="text-xs text-muted-foreground">Immobilien-ID</dt>
                    <dd className="text-xs text-foreground font-mono truncate">{property.id}</dd>
                </div>
            </dl>
        </div>
    );
}
