'use client';

import { useState, Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Trash2, X, Check, Phone, Mail, User, ChevronDown, ChevronRight } from 'lucide-react';
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

const CATEGORIES = [
    { value: 'strom', label: 'Strom', icon: '⚡', recurring: true },
    { value: 'gas', label: 'Gas', icon: '🔥', recurring: true },
    { value: 'wasser', label: 'Wasser', icon: '💧', recurring: true },
    { value: 'heizung', label: 'Heizung', icon: '🌡️', recurring: true },
    { value: 'versicherung', label: 'Versicherung', icon: '🛡️', recurring: true },
    { value: 'grundbesitzabgaben', label: 'Grundbesitzabgaben', icon: '🏛️', recurring: true },
    { value: 'verbrauchsdatenerfassung', label: 'Verbrauchsdatenerfassung', icon: '📊', recurring: true },
    { value: 'hausverwaltung', label: 'Hausverwaltung', icon: '🏢', recurring: true },
    { value: 'wartung', label: 'Wartung', icon: '🔧', recurring: false },
    { value: 'sonstige', label: 'Sonstige Dienstleister', icon: '📋', recurring: false },
];

function catInfo(value: string) {
    return CATEGORIES.find((c) => c.value === value) ?? { value, label: value, icon: '📋', recurring: false };
}

function fmt(n: number) {
    return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export default function ServiceProviderList({
    propertyId,
    providers: initialProviders,
}: {
    propertyId: string;
    providers: Provider[];
}) {
    const [providers, setProviders] = useState(initialProviders);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
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

    // --- Summary ---
    const monthlyRecurring = providers
        .filter((p) => catInfo(p.category).recurring && p.monthlyCost)
        .reduce((sum, p) => sum + (p.monthlyCost ?? 0), 0);
    const yearlySum = providers
        .filter((p) => p.yearlyCost)
        .reduce((sum, p) => sum + (p.yearlyCost ?? 0), 0);

    const renderForm = (defaults?: Provider) => (
        <tr>
            <td colSpan={5} className="p-0">
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
                            <label className="text-xs text-muted-foreground">€ / Monat</label>
                            <input name="monthlyCost" type="number" step="0.01"
                                defaultValue={defaults?.monthlyCost ?? ''}
                                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background" />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground">€ / Jahr</label>
                            <input name="yearlyCost" type="number" step="0.01"
                                defaultValue={defaults?.yearlyCost ?? ''}
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
                        <div>
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
                                <th className="text-left p-3 font-medium w-8"></th>
                                <th className="text-left p-3 font-medium">Kategorie</th>
                                <th className="text-left p-3 font-medium">Versorger</th>
                                <th className="text-right p-3 font-medium">€ / Monat</th>
                                <th className="text-right p-3 font-medium">€ / Jahr</th>
                            </tr>
                        </thead>
                        <tbody>
                            {providers.map((p) => {
                                const cat = catInfo(p.category);
                                const isExpanded = expandedId === p.id;
                                const isEditing = editingId === p.id;

                                if (isEditing) {
                                    return <Fragment key={p.id}>{renderForm(editing ?? undefined)}</Fragment>;
                                }

                                return (
                                    <Fragment key={p.id}>
                                        <tr
                                            className="border-b last:border-b-0 hover:bg-muted/20 cursor-pointer transition-colors"
                                            onClick={() => setExpandedId(isExpanded ? null : p.id)}
                                        >
                                            <td className="p-3 text-muted-foreground">
                                                {isExpanded
                                                    ? <ChevronDown className="h-4 w-4" />
                                                    : <ChevronRight className="h-4 w-4" />}
                                            </td>
                                            <td className="p-3">
                                                <span className="flex items-center gap-2">
                                                    <span>{cat.icon}</span>
                                                    <span className="font-medium">{cat.label}</span>
                                                </span>
                                            </td>
                                            <td className="p-3 text-muted-foreground">{p.name}</td>
                                            <td className="p-3 text-right whitespace-nowrap">
                                                {p.monthlyCost ? fmt(p.monthlyCost) : <span className="text-muted-foreground">—</span>}
                                            </td>
                                            <td className="p-3 text-right whitespace-nowrap">
                                                {p.yearlyCost ? fmt(p.yearlyCost) : <span className="text-muted-foreground">—</span>}
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr className="bg-muted/10 border-b">
                                                <td></td>
                                                <td colSpan={4} className="p-4">
                                                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                                                        {p.contractNumber && (
                                                            <div>
                                                                <span className="text-xs text-muted-foreground block">Vertragsnummer</span>
                                                                <span>{p.contractNumber}</span>
                                                            </div>
                                                        )}
                                                        {p.contactName && (
                                                            <div>
                                                                <span className="text-xs text-muted-foreground block">Ansprechpartner</span>
                                                                <span className="flex items-center gap-1">
                                                                    <User className="h-3 w-3 text-muted-foreground" />
                                                                    {p.contactName}
                                                                </span>
                                                            </div>
                                                        )}
                                                        {p.contactPhone && (
                                                            <div>
                                                                <span className="text-xs text-muted-foreground block">Telefon</span>
                                                                <a href={`tel:${p.contactPhone}`}
                                                                    className="flex items-center gap-1 hover:text-primary"
                                                                    onClick={(e) => e.stopPropagation()}>
                                                                    <Phone className="h-3 w-3 text-muted-foreground" />
                                                                    {p.contactPhone}
                                                                </a>
                                                            </div>
                                                        )}
                                                        {p.contactEmail && (
                                                            <div>
                                                                <span className="text-xs text-muted-foreground block">E-Mail</span>
                                                                <a href={`mailto:${p.contactEmail}`}
                                                                    className="flex items-center gap-1 hover:text-primary"
                                                                    onClick={(e) => e.stopPropagation()}>
                                                                    <Mail className="h-3 w-3 text-muted-foreground" />
                                                                    {p.contactEmail}
                                                                </a>
                                                            </div>
                                                        )}
                                                        {p.notes && (
                                                            <div className="sm:col-span-2 lg:col-span-3">
                                                                <span className="text-xs text-muted-foreground block">Notizen</span>
                                                                <span>{p.notes}</span>
                                                            </div>
                                                        )}
                                                        {!p.contractNumber && !p.contactName && !p.contactPhone && !p.contactEmail && !p.notes && (
                                                            <div className="text-muted-foreground italic">
                                                                Keine weiteren Details hinterlegt.
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex gap-2 mt-3 pt-3 border-t">
                                                        <Button variant="outline" size="sm"
                                                            onClick={(e) => { e.stopPropagation(); setEditingId(p.id); setShowForm(false); setExpandedId(null); }}>
                                                            <Pencil className="h-3 w-3 mr-1" /> Bearbeiten
                                                        </Button>
                                                        <Button variant="outline" size="sm"
                                                            className="text-red-500 hover:text-red-600 hover:bg-red-50"
                                                            onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }}>
                                                            <Trash2 className="h-3 w-3 mr-1" /> Löschen
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}

                            {/* Summary row */}
                            <tr className="border-t-2 font-bold bg-muted/30">
                                <td className="p-3"></td>
                                <td className="p-3" colSpan={2}>Gesamt</td>
                                <td className="p-3 text-right whitespace-nowrap">{fmt(monthlyRecurring)}</td>
                                <td className="p-3 text-right whitespace-nowrap">{fmt(yearlySum)}</td>
                            </tr>

                            {/* Add new form */}
                            {showForm && renderForm()}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
