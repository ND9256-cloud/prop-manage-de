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
    { value: 'strom', label: 'Strom', icon: '⚡', recurring: true },
    { value: 'gas', label: 'Gas', icon: '🔥', recurring: true },
    { value: 'wasser', label: 'Wasser', icon: '💧', recurring: true },
    { value: 'heizung', label: 'Heizung', icon: '🌡️', recurring: true },
    { value: 'versicherung', label: 'Versicherung', icon: '🛡️', recurring: true },
    { value: 'grundbesitzabgaben', label: 'Grundbesitzabgaben', icon: '🏛️', recurring: true },
    { value: 'hausverwaltung', label: 'Hausverwaltung', icon: '🏢', recurring: true },
    { value: 'wartung', label: 'Wartung', icon: '🔧', recurring: false },
    { value: 'sonstige', label: 'Sonstige', icon: '📋', recurring: false },
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

    // --- Calculations ---
    const currentMonth = new Date().getMonth() + 1; // 1-12

    // Recurring monthly total (gas, electricity, water, etc. — not maintenance/one-offs)
    const monthlyRecurring = providers
        .filter((p) => catInfo(p.category).recurring && p.monthlyCost)
        .reduce((sum, p) => sum + (p.monthlyCost ?? 0), 0);

    // Yearly costs to date: recurring × months elapsed + yearly one-offs
    const yearlyToDate =
        monthlyRecurring * currentMonth +
        providers
            .filter((p) => p.yearlyCost)
            .reduce((sum, p) => sum + (p.yearlyCost ?? 0), 0);

    const renderForm = (defaults?: Provider) => (
        <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-muted/30 col-span-full">
            <div className="grid gap-3 sm:grid-cols-2">
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
                <div className="grid grid-cols-2 gap-2">
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
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-semibold">Dienstleister & Versorger</h2>
                    <p className="text-xs text-muted-foreground">
                        Werden automatisch aus hochgeladenen Dokumenten erkannt
                    </p>
                </div>
            </div>

            {/* 4 Summary Cards */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
                {/* Card 1: Cost Types */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Kostenarten</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {providers.length === 0 ? (
                            <p className="text-sm text-muted-foreground italic">Keine</p>
                        ) : (
                            <div className="space-y-1.5">
                                {providers.map((p) => {
                                    const cat = catInfo(p.category);
                                    return (
                                        <div key={p.id} className="flex items-center justify-between text-sm group">
                                            <span className="flex items-center gap-2">
                                                <span>{cat.icon}</span>
                                                <span>{cat.label}</span>
                                            </span>
                                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    className="p-0.5 hover:text-primary"
                                                    onClick={() => { setEditingId(p.id); setShowForm(false); }}
                                                >
                                                    <Pencil className="h-3 w-3" />
                                                </button>
                                                <button
                                                    className="p-0.5 hover:text-red-500"
                                                    onClick={() => handleDelete(p.id, p.name)}
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Card 2: Operators */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Versorger</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {providers.length === 0 ? (
                            <p className="text-sm text-muted-foreground italic">Keine</p>
                        ) : (
                            <div className="space-y-1.5">
                                {providers.map((p) => (
                                    <div key={p.id} className="text-sm">
                                        <p className="font-medium truncate">{p.name}</p>
                                        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                                            {p.contactName && (
                                                <span className="flex items-center gap-0.5">
                                                    <User className="h-3 w-3" /> {p.contactName}
                                                </span>
                                            )}
                                            {p.contactPhone && (
                                                <a href={`tel:${p.contactPhone}`} className="flex items-center gap-0.5 hover:text-foreground">
                                                    <Phone className="h-3 w-3" /> {p.contactPhone}
                                                </a>
                                            )}
                                            {p.contactEmail && (
                                                <a href={`mailto:${p.contactEmail}`} className="flex items-center gap-0.5 hover:text-foreground">
                                                    <Mail className="h-3 w-3" /> {p.contactEmail}
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Card 3: Monthly Recurring Costs */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Mtl. Kosten (laufend)</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{fmt(monthlyRecurring)}</p>
                        <div className="mt-2 space-y-1">
                            {providers
                                .filter((p) => catInfo(p.category).recurring && p.monthlyCost)
                                .map((p) => (
                                    <div key={p.id} className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>{catInfo(p.category).icon} {catInfo(p.category).label}</span>
                                        <span>{fmt(p.monthlyCost!)}</span>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>

                {/* Card 4: Yearly Costs to Date */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                            Jährl. Kosten (bis {new Date().toLocaleDateString('de-DE', { month: 'long' })})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{fmt(yearlyToDate)}</p>
                        <div className="mt-2 space-y-1">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>Laufend ({currentMonth} Mon.)</span>
                                <span>{fmt(monthlyRecurring * currentMonth)}</span>
                            </div>
                            {providers
                                .filter((p) => p.yearlyCost)
                                .map((p) => (
                                    <div key={p.id} className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>{catInfo(p.category).icon} {catInfo(p.category).label} (jährl.)</span>
                                        <span>{fmt(p.yearlyCost!)}</span>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Add / Edit Form */}
            {(showForm || editingId) && (
                <div>{editingId && editing ? renderForm(editing) : renderForm()}</div>
            )}
        </div>
    );
}
