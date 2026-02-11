'use client';

import { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { importRentRoll, ImportRow } from '@/lib/import-actions';

// Our DB fields the user can map to
const FIELDS = [
    { key: 'address', label: 'Adresse', required: true },
    { key: 'unitNumber', label: 'Einheit / Geschoss', required: true },
    { key: 'tenantFirstName', label: 'Vorname Mieter', required: true },
    { key: 'tenantLastName', label: 'Nachname Mieter', required: true },
    { key: 'sizeSqm', label: 'Wohnfläche (m²)', required: true },
    { key: 'coldRent', label: 'Kaltmiete', required: true },
    { key: 'utilityAdvance', label: 'BK-Vorauszahlung', required: true },
    { key: 'deposit', label: 'Kaution', required: true },
    { key: 'startDate', label: 'Mietstart', required: true },
    { key: 'propertyName', label: 'Objektname', required: false },
    { key: 'city', label: 'Stadt', required: false },
    { key: 'zip', label: 'PLZ', required: false },
    { key: 'rooms', label: 'Zimmer', required: false },
    { key: 'floor', label: 'Stockwerk', required: false },
    { key: 'parkingRent', label: 'Stellplatzmiete', required: false },
    { key: 'endDate', label: 'Mietende', required: false },
    { key: 'rentIncreaseRule', label: 'Mieterhöhungsregel', required: false },
    { key: 'lastRentIncreaseAt', label: 'Letzte Erhöhung', required: false },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

// Parse German number formats: "1.234,56" → 1234.56
function parseNum(val: unknown): number {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const s = String(val).trim();
    // Remove thousand separators (dots) and convert comma to dot
    const cleaned = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
}

// Parse German date formats: "01.03.2024" → "2024-03-01"
function parseDate(val: unknown): string {
    if (!val) return '';
    const s = String(val).trim();
    // Try DD.MM.YYYY
    const match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (match) {
        return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    }
    // Try ISO or YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    // Try Excel serial date (number)
    if (typeof val === 'number' && val > 30000 && val < 60000) {
        const date = new Date((val - 25569) * 86400 * 1000);
        return date.toISOString().slice(0, 10);
    }
    return s;
}

export default function RentRollImport({ onClose }: { onClose: () => void }) {
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [headers, setHeaders] = useState<string[]>([]);
    const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
    const [mapping, setMapping] = useState<Record<FieldKey, string>>({} as Record<FieldKey, string>);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<{ created: number } | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Step 1: Parse file
    const onFile = useCallback((file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
            if (json.length === 0) {
                setError('Die Datei enthält keine Daten.');
                return;
            }
            const hdrs = Object.keys(json[0]);
            setHeaders(hdrs);
            setRawRows(json);

            // Auto-map obvious matches
            const autoMap: Record<string, string> = {};
            for (const field of FIELDS) {
                const match = hdrs.find(
                    (h) => h.toLowerCase().trim() === field.label.toLowerCase().trim()
                );
                if (match) autoMap[field.key] = match;
            }
            setMapping(autoMap as Record<FieldKey, string>);
            setStep(2);
        };
        reader.readAsArrayBuffer(file);
    }, []);

    // Build import rows from mapping
    const buildRows = (): ImportRow[] => {
        return rawRows.map((raw) => {
            const get = (key: FieldKey) => raw[mapping[key]] ?? '';
            return {
                address: String(get('address')).trim(),
                unitNumber: String(get('unitNumber')).trim(),
                tenantFirstName: String(get('tenantFirstName')).trim(),
                tenantLastName: String(get('tenantLastName')).trim(),
                sizeSqm: parseNum(get('sizeSqm')),
                coldRent: parseNum(get('coldRent')),
                utilityAdvance: parseNum(get('utilityAdvance')),
                deposit: parseNum(get('deposit')),
                startDate: parseDate(get('startDate')),
                endDate: mapping['endDate'] ? parseDate(get('endDate')) || undefined : undefined,
                propertyName: mapping['propertyName'] ? String(get('propertyName')).trim() || undefined : undefined,
                city: mapping['city'] ? String(get('city')).trim() || undefined : undefined,
                zip: mapping['zip'] ? String(get('zip')).trim() || undefined : undefined,
                rooms: mapping['rooms'] ? parseNum(get('rooms')) || undefined : undefined,
                floor: mapping['floor'] ? parseNum(get('floor')) || undefined : undefined,
                parkingRent: mapping['parkingRent'] ? parseNum(get('parkingRent')) || undefined : undefined,
                rentIncreaseRule: mapping['rentIncreaseRule'] ? String(get('rentIncreaseRule')).trim() || undefined : undefined,
                lastRentIncreaseAt: mapping['lastRentIncreaseAt'] ? parseDate(get('lastRentIncreaseAt')) || undefined : undefined,
            };
        });
    };

    // Check required fields are mapped
    const requiredMissing = FIELDS.filter((f) => f.required && !mapping[f.key]);

    // Step 3: Submit
    const handleImport = async () => {
        setImporting(true);
        setError(null);
        try {
            const rows = buildRows();
            const res = await importRentRoll(rows);
            setResult(res);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import fehlgeschlagen');
        } finally {
            setImporting(false);
        }
    };

    // --- RENDER ---
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>
                        {result ? 'Import abgeschlossen' : `Rent Roll importieren — Schritt ${step}/3`}
                    </CardTitle>
                    <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
                </CardHeader>
                <CardContent>
                    {/* STEP 1: Upload */}
                    {step === 1 && (
                        <div
                            className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:border-primary/50 transition-colors"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                const file = e.dataTransfer.files[0];
                                if (file) onFile(file);
                            }}
                            onClick={() => {
                                const input = document.createElement('input');
                                input.type = 'file';
                                input.accept = '.csv,.xlsx,.xls';
                                input.onchange = () => {
                                    if (input.files?.[0]) onFile(input.files[0]);
                                };
                                input.click();
                            }}
                        >
                            <div className="text-4xl mb-4">📄</div>
                            <p className="text-lg font-medium mb-2">CSV oder Excel-Datei hochladen</p>
                            <p className="text-sm text-muted-foreground">
                                Datei hierher ziehen oder klicken zum Auswählen
                            </p>
                        </div>
                    )}

                    {/* STEP 2: Column Mapping */}
                    {step === 2 && (
                        <div>
                            <p className="text-sm text-muted-foreground mb-4">
                                Ordnen Sie Ihre Spalten unseren Feldern zu. Pflichtfelder sind mit * markiert.
                            </p>
                            <div className="space-y-3">
                                {FIELDS.map((field) => (
                                    <div key={field.key} className="flex items-center gap-3">
                                        <label className="w-48 text-sm font-medium shrink-0">
                                            {field.label}{field.required ? ' *' : ''}
                                        </label>
                                        <select
                                            className="flex-1 border rounded-md px-3 py-2 text-sm bg-background"
                                            value={mapping[field.key] || ''}
                                            onChange={(e) =>
                                                setMapping((m) => ({ ...m, [field.key]: e.target.value }))
                                            }
                                        >
                                            <option value="">— nicht zugeordnet —</option>
                                            {headers.map((h) => (
                                                <option key={h} value={h}>{h}</option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-between mt-6">
                                <Button variant="outline" onClick={() => setStep(1)}>Zurück</Button>
                                <Button
                                    disabled={requiredMissing.length > 0}
                                    onClick={() => setStep(3)}
                                >
                                    Weiter — Vorschau
                                </Button>
                            </div>
                            {requiredMissing.length > 0 && (
                                <p className="text-xs text-destructive mt-2">
                                    Fehlende Pflichtfelder: {requiredMissing.map((f) => f.label).join(', ')}
                                </p>
                            )}
                        </div>
                    )}

                    {/* STEP 3: Preview & Import */}
                    {step === 3 && !result && (
                        <div>
                            <p className="text-sm text-muted-foreground mb-4">
                                Vorschau — {rawRows.length} Zeilen werden importiert.
                            </p>
                            <div className="overflow-x-auto border rounded-md max-h-64">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-muted/50 border-b">
                                            <th className="p-2 text-left">Adresse</th>
                                            <th className="p-2 text-left">Einheit</th>
                                            <th className="p-2 text-left">Mieter</th>
                                            <th className="p-2 text-right">m²</th>
                                            <th className="p-2 text-right">Kaltmiete</th>
                                            <th className="p-2 text-left">Mietstart</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {buildRows().slice(0, 10).map((row, i) => (
                                            <tr key={i} className="border-b">
                                                <td className="p-2">{row.address}</td>
                                                <td className="p-2">{row.unitNumber}</td>
                                                <td className="p-2">{row.tenantFirstName} {row.tenantLastName}</td>
                                                <td className="p-2 text-right">{row.sizeSqm}</td>
                                                <td className="p-2 text-right">{row.coldRent}</td>
                                                <td className="p-2">{row.startDate}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {rawRows.length > 10 && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    … und {rawRows.length - 10} weitere Zeilen
                                </p>
                            )}
                            {error && <p className="text-sm text-destructive mt-3">{error}</p>}
                            <div className="flex justify-between mt-6">
                                <Button variant="outline" onClick={() => setStep(2)}>Zurück</Button>
                                <Button onClick={handleImport} disabled={importing}>
                                    {importing ? 'Importiere…' : `${rawRows.length} Zeilen importieren`}
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* DONE */}
                    {result && (
                        <div className="text-center py-8">
                            <div className="text-4xl mb-4">✅</div>
                            <p className="text-lg font-medium mb-2">
                                {result.created} Mietverhältnisse importiert
                            </p>
                            <Button onClick={onClose} className="mt-4">Schließen</Button>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
