'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const CATEGORIES = [
    { value: 'strom', label: 'Strom', icon: '⚡' },
    { value: 'gas', label: 'Gas', icon: '🔥' },
    { value: 'wasser', label: 'Wasser', icon: '💧' },
    { value: 'heizung', label: 'Heizung', icon: '🌡️' },
    { value: 'versicherung', label: 'Versicherung', icon: '🛡️' },
    { value: 'grundbesitzabgaben', label: 'Grundbesitzabgaben', icon: '🏛️' },
    { value: 'hausverwaltung', label: 'Hausverwaltung', icon: '🏢' },
    { value: 'sonstige', label: 'Sonstige', icon: '📋' },
];

function catInfo(value: string) {
    return CATEGORIES.find((c) => c.value === value) ?? { value, label: value, icon: '📋' };
}

function fmt(n: number | null) {
    if (n == null) return '—';
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

    const renderForm = (defaults?: Provider) => (
        <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-muted/30">
            <div className="grid gap-3 sm:grid-cols-2">
                <div>
                    <label className="text-xs text-muted-foreground">Name *</label>
                    <input
                        name="name"
                        required
                        defaultValue={defaults?.name}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                        placeholder="z.B. Stadtwerke München"
                    />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Kategorie *</label>
                    <select
                        name="category"
                        required
                        defaultValue={defaults?.category ?? 'strom'}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    >
                        {CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>
                                {c.icon} {c.label}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Vertragsnummer</label>
                    <input
                        name="contractNumber"
                        defaultValue={defaults?.contractNumber ?? ''}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    />
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="text-xs text-muted-foreground">€ / Monat</label>
                        <input
                            name="monthlyCost"
                            type="number"
                            step="0.01"
                            defaultValue={defaults?.monthlyCost ?? ''}
                            className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-muted-foreground">€ / Jahr</label>
                        <input
                            name="yearlyCost"
                            type="number"
                            step="0.01"
                            defaultValue={defaults?.yearlyCost ?? ''}
                            className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                        />
                    </div>
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Ansprechpartner</label>
                    <input
                        name="contactName"
                        defaultValue={defaults?.contactName ?? ''}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Telefon</label>
                    <input
                        name="contactPhone"
                        defaultValue={defaults?.contactPhone ?? ''}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">E-Mail</label>
                    <input
                        name="contactEmail"
                        type="email"
                        defaultValue={defaults?.contactEmail ?? ''}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Notizen</label>
                    <input
                        name="notes"
                        defaultValue={defaults?.notes ?? ''}
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                    />
                </div>
            </div>
            <div className="flex gap-2 justify-end">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { setShowForm(false); setEditingId(null); }}
                >
                    <X className="h-4 w-4 mr-1" /> Abbrechen
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                    <Check className="h-4 w-4 mr-1" />
                    {saving ? 'Speichern…' : editingId ? 'Aktualisieren' : 'Hinzufügen'}
                </Button>
            </div>
        </form>
    );

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Dienstleister & Versorger</CardTitle>
                {!showForm && !editingId && (
                    <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
                        <Plus className="h-4 w-4 mr-2" />
                        Hinzufügen
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-3">
                {showForm && !editingId && renderForm()}
                {editingId && editing && renderForm(editing)}

                {providers.length === 0 && !showForm ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                        Noch keine Dienstleister hinterlegt.
                    </p>
                ) : (
                    providers.map((p) => {
                        if (p.id === editingId) return null;
                        const cat = catInfo(p.category);
                        return (
                            <div
                                key={p.id}
                                className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors group"
                            >
                                <span className="text-xl mt-0.5">{cat.icon}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium">{p.name}</p>
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                                            {cat.label}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
                                        {p.contractNumber && <span>Vertrag: {p.contractNumber}</span>}
                                        {p.monthlyCost != null && <span>{fmt(p.monthlyCost)}/Monat</span>}
                                        {p.yearlyCost != null && <span>{fmt(p.yearlyCost)}/Jahr</span>}
                                    </div>
                                    {(p.contactName || p.contactPhone || p.contactEmail) && (
                                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                                            {p.contactName && (
                                                <span className="flex items-center gap-1">
                                                    <User className="h-3 w-3" /> {p.contactName}
                                                </span>
                                            )}
                                            {p.contactPhone && (
                                                <a href={`tel:${p.contactPhone}`} className="flex items-center gap-1 hover:text-foreground">
                                                    <Phone className="h-3 w-3" /> {p.contactPhone}
                                                </a>
                                            )}
                                            {p.contactEmail && (
                                                <a href={`mailto:${p.contactEmail}`} className="flex items-center gap-1 hover:text-foreground">
                                                    <Mail className="h-3 w-3" /> {p.contactEmail}
                                                </a>
                                            )}
                                        </div>
                                    )}
                                    {p.notes && <p className="text-xs text-muted-foreground mt-1 italic">{p.notes}</p>}
                                </div>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => { setEditingId(p.id); setShowForm(false); }}
                                    >
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-red-500 hover:text-red-600"
                                        onClick={() => handleDelete(p.id, p.name)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        );
                    })
                )}
            </CardContent>
        </Card>
    );
}
