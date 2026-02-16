'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Trash2, X, Check, Phone, Mail, User } from 'lucide-react';
import {
    createServiceProvider,
    updateServiceProvider,
    deleteServiceProvider,
} from '@/lib/service-provider-actions';

interface Provider {
    id: string;
    name: string;
    category: string;
    contractNumber: string | null;
    monthlyCost: number | null;
    yearlyCost: number | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    notes: string | null;
}

interface CostData {
    frequency: string;
    yearlyTotal: number;
}

const CATEGORIES = [
    { value: 'strom', label: 'Strom', icon: '⚡' },
    { value: 'gas', label: 'Gas', icon: '🔥' },
    { value: 'wasser', label: 'Wasser', icon: '💧' },
    { value: 'heizung', label: 'Heizung', icon: '🌡️' },
    { value: 'versicherung', label: 'Versicherung', icon: '🛡️' },
    { value: 'grundbesitzabgaben', label: 'Grundbesitzabgaben', icon: '🏛️' },
    { value: 'verbrauchsdatenerfassung', label: 'Verbrauchsdatenerfassung', icon: '📊' },
    { value: 'hausverwaltung', label: 'Hausverwaltung', icon: '🏢' },
    { value: 'wartung', label: 'Wartung', icon: '🔧' },
    { value: 'sonstige', label: 'Sonstige Dienstleister', icon: '📋' },
];

function catInfo(value: string) {
    return CATEGORIES.find((c) => c.value === value) ?? { value, label: value, icon: '📋' };
}

function fmt(n: number) {
    return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export default function ServiceProviderList({
    propertyId,
    providers: initialProviders,
    costs,
}: {
    propertyId: string;
    providers: Provider[];
    costs: Record<string, CostData>;
}) {
    const [providers, setProviders] = useState(initialProviders);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setSaving(true);
        const fd = new FormData(e.currentTarget);
        fd.set('propertyId', propertyId);
        try {
            if (editingId) {
                fd.set('id', editingId);
                await updateServiceProvider(fd);
            } else {
                await createServiceProvider(fd);
            }
            window.location.reload();
        } catch (err) {
            alert(`Fehler: ${(err as Error).message}`);
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(id: string, name: string) {
        if (!confirm(`„${name}" wirklich löschen?`)) return;
        try {
            await deleteServiceProvider(id);
            setProviders((prev) => prev.filter((p) => p.id !== id));
        } catch (err) {
            alert(`Fehler: ${(err as Error).message}`);
        }
    }

    const editing = editingId ? providers.find((p) => p.id === editingId) : null;
    const currentYear = new Date().getFullYear();

    const renderForm = (defaults?: Provider) => (
        <tr>
            <td colSpan={7} className="p-0">
                <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-muted/30 border-y">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                            <label className="text-xs text-muted-foreground">Name *</label>
                            <input name="name" required defaultValue={defaults?.name}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                                placeholder="z.B. Stadtwerke München" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">Kategorie *</label>
                            <select name="category" required defaultValue={defaults?.category ?? 'strom'}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background">
                                {CATEGORIES.map((c) => (
                                    <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">Vertragsnummer</label>
                            <input name="contractNumber" defaultValue={defaults?.contractNumber ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">Ansprechpartner</label>
                            <input name="contactName" defaultValue={defaults?.contactName ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">Telefon</label>
                            <input name="contactPhone" defaultValue={defaults?.contactPhone ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">E-Mail</label>
                            <input name="contactEmail" type="email" defaultValue={defaults?.contactEmail ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                        <div className="sm:col-span-2 lg:col-span-3">
                            <label className="text-xs text-muted-foreground">Notizen</label>
                            <input name="notes" defaultValue={defaults?.notes ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="ghost" size="sm"
                            onClick={() => { setShowForm(false); setEditingId(null); }}>
                            <X className="h-4 w-4 mr-1" /> Abbrechen
                        </Button>
                        <Button type="submit" size="sm" disabled={saving}>
                            <Check className="h-4 w-4 mr-1" />
                            {saving ? 'Speichern…' : editingId ? 'Aktualisieren' : 'Hinzufügen'}
                        </Button>
                    </div>
                </form>
            </td>
        </tr>
    );

    // Calculate total yearly from costs
    const totalYearly = Object.values(costs).reduce((sum, c) => sum + c.yearlyTotal, 0);

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Dienstleister &amp; Versorger</h2>
                {!showForm && !editingId && (
                    <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
                        <Plus className="h-4 w-4 mr-2" />
                        Hinzufügen
                    </Button>
                )}
            </div>

            {providers.length === 0 && !showForm ? (
                <div className="text-center py-8 text-muted-foreground border rounded-lg bg-muted/10">
                    <p className="text-sm">Noch keine Dienstleister angelegt.</p>
                    <p className="text-xs mt-1">Klicken Sie auf „Hinzufügen" um loszulegen.</p>
                </div>
            ) : (
                <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-muted/50 border-b">
                                <th className="text-left p-3 font-medium">Kategorie</th>
                                <th className="text-left p-3 font-medium">Versorger</th>
                                <th className="text-left p-3 font-medium hidden md:table-cell">Kontakt</th>
                                <th className="text-left p-3 font-medium hidden lg:table-cell">Vertrag</th>
                                <th className="text-right p-3 font-medium">Häufigkeit</th>
                                <th className="text-right p-3 font-medium">{currentYear}</th>
                                <th className="p-3 w-8"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {providers.map((p) => {
                                const cat = catInfo(p.category);
                                const costData = costs[p.category];
                                const isEditing = editingId === p.id;

                                if (isEditing) {
                                    return renderForm(editing ?? undefined);
                                }

                                return (
                                    <tr key={p.id} className="border-b last:border-b-0 hover:bg-muted/20 transition-colors">
                                        <td className="p-3">
                                            <span className="flex items-center gap-2">
                                                <span>{cat.icon}</span>
                                                <span className="font-medium">{cat.label}</span>
                                            </span>
                                        </td>
                                        <td className="p-3">
                                            <span className="block font-medium">{p.name}</span>
                                            {p.notes && (
                                                <span className="block text-xs text-muted-foreground truncate max-w-[200px]">{p.notes}</span>
                                            )}
                                        </td>
                                        <td className="p-3 hidden md:table-cell">
                                            <div className="space-y-0.5">
                                                {p.contactName && (
                                                    <div className="flex items-center gap-1 text-xs">
                                                        <User className="h-3 w-3 text-muted-foreground" />
                                                        {p.contactName}
                                                    </div>
                                                )}
                                                {p.contactPhone && (
                                                    <a href={`tel:${p.contactPhone}`} className="flex items-center gap-1 text-xs hover:text-primary">
                                                        <Phone className="h-3 w-3 text-muted-foreground" />
                                                        {p.contactPhone}
                                                    </a>
                                                )}
                                                {p.contactEmail && (
                                                    <a href={`mailto:${p.contactEmail}`} className="flex items-center gap-1 text-xs hover:text-primary">
                                                        <Mail className="h-3 w-3 text-muted-foreground" />
                                                        {p.contactEmail}
                                                    </a>
                                                )}
                                                {!p.contactName && !p.contactPhone && !p.contactEmail && (
                                                    <span className="text-xs text-muted-foreground">—</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-3 hidden lg:table-cell text-xs text-muted-foreground">
                                            {p.contractNumber || '—'}
                                        </td>
                                        <td className="p-3 text-right whitespace-nowrap text-xs">
                                            {costData?.frequency || (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>
                                        <td className="p-3 text-right whitespace-nowrap">
                                            {costData?.yearlyTotal ? (
                                                <span className="text-red-600 font-medium">{fmt(-costData.yearlyTotal)}</span>
                                            ) : (
                                                <span className="text-muted-foreground">—</span>
                                            )}
                                        </td>
                                        <td className="p-3">
                                            <div className="flex gap-0.5">
                                                <button
                                                    className="p-1 hover:text-primary rounded"
                                                    onClick={() => { setEditingId(p.id); setShowForm(false); }}
                                                    title="Bearbeiten"
                                                >
                                                    <Pencil className="h-3 w-3" />
                                                </button>
                                                <button
                                                    className="p-1 hover:text-red-500 rounded"
                                                    onClick={() => handleDelete(p.id, p.name)}
                                                    title="Löschen"
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}

                            {/* Summary row */}
                            {providers.length > 0 && (
                                <tr className="border-t-2 font-bold bg-muted/30">
                                    <td className="p-3" colSpan={5}>Gesamt {currentYear}</td>
                                    <td className="p-3 text-right whitespace-nowrap">
                                        {totalYearly > 0 ? (
                                            <span className="text-red-600">{fmt(-totalYearly)}</span>
                                        ) : (
                                            <span className="text-muted-foreground">—</span>
                                        )}
                                    </td>
                                    <td></td>
                                </tr>
                            )}

                            {/* Add form */}
                            {showForm && renderForm()}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
