'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { TrendingUp } from 'lucide-react';

type ViewMode = 'monthly' | 'quarterly' | 'yearly';

interface RawTransaction {
    date: string;
    amount: number;
    category: string;
}

const VIEW_LABELS: Record<ViewMode, string> = {
    monthly: 'Monatlich',
    quarterly: 'Quartalsweise',
    yearly: 'Jährlich',
};

const CATEGORY_LABELS: Record<string, string> = {
    Bruttomieteinnahmen: 'Bruttomieteinnahmen',
    'Umlegbare Nebenkosten': 'Umlegbare Nebenkosten',
    Kaution: 'Kaution',
    __uncategorized__: 'Nicht kategorisiert',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function fmt(n: number) {
    return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function getPeriodKey(date: Date, mode: ViewMode): string {
    const year = date.getFullYear();
    if (mode === 'yearly') return `${year}`;
    if (mode === 'quarterly') {
        const q = Math.ceil((date.getMonth() + 1) / 3);
        return `${year}-Q${q}`;
    }
    // monthly
    const month = date.getMonth();
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function getPeriodLabel(key: string, mode: ViewMode): string {
    if (mode === 'yearly') return key;
    if (mode === 'quarterly') {
        const [year, q] = key.split('-');
        return `${q} ${year}`;
    }
    // monthly
    const [year, monthStr] = key.split('-');
    const monthIdx = parseInt(monthStr, 10) - 1;
    return `${MONTH_NAMES[monthIdx]} ${year}`;
}

function aggregate(transactions: RawTransaction[], mode: ViewMode) {
    if (transactions.length === 0) {
        return { periods: [], categories: [], periodData: {} as Record<string, Record<string, number>>, periodTotals: {} as Record<string, number>, totals: {} as Record<string, number>, grandTotal: 0 };
    }

    // Map raw categories to display categories (group all NK: into one row)
    const displayCategory = (cat: string) => cat.startsWith('NK: ') ? 'Umlegbare Nebenkosten' : cat;

    const periodsSet = new Set<string>();
    const categoriesSet = new Set<string>();

    for (const tx of transactions) {
        const d = new Date(tx.date);
        periodsSet.add(getPeriodKey(d, mode));
        categoriesSet.add(displayCategory(tx.category));
    }

    const periods = Array.from(periodsSet).sort();

    // Fixed display order
    const CATEGORY_ORDER = ['Bruttomieteinnahmen', 'Umlegbare Nebenkosten', 'Kaution', '__uncategorized__'];
    const categories = Array.from(categoriesSet).sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a);
        const bi = CATEGORY_ORDER.indexOf(b);
        const aIdx = ai >= 0 ? ai : CATEGORY_ORDER.length;
        const bIdx = bi >= 0 ? bi : CATEGORY_ORDER.length;
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.localeCompare(b, 'de');
    });

    const periodData: Record<string, Record<string, number>> = {};
    const totals: Record<string, number> = {};

    for (const p of periods) {
        periodData[p] = {};
        for (const cat of categories) periodData[p][cat] = 0;
    }
    for (const cat of categories) totals[cat] = 0;

    for (const tx of transactions) {
        const d = new Date(tx.date);
        const p = getPeriodKey(d, mode);
        const cat = displayCategory(tx.category);
        periodData[p][cat] += tx.amount;
        totals[cat] += tx.amount;
    }

    const periodTotals: Record<string, number> = {};
    let grandTotal = 0;
    for (const p of periods) {
        periodTotals[p] = Object.values(periodData[p]).reduce((s, v) => s + v, 0);
        grandTotal += periodTotals[p];
    }

    return { periods, categories, periodData, periodTotals, totals, grandTotal };
}

function AmountCell({ value, bold, bg }: { value: number; bold?: boolean; bg?: string }) {
    return (
        <td className={`p-3 text-right whitespace-nowrap ${bold ? 'font-medium' : ''} ${bg || ''}`}>
            <span className={value > 0 ? 'text-green-600' : value < 0 ? 'text-red-600' : 'text-muted-foreground'}>
                {fmt(value)}
            </span>
        </td>
    );
}

export default function PropertyCashFlow({ data }: { data: RawTransaction[] }) {
    const [viewMode, setViewMode] = useState<ViewMode>('yearly');

    const { periods, categories, periodData, periodTotals, totals, grandTotal } = useMemo(
        () => aggregate(data, viewMode),
        [data, viewMode]
    );

    if (data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                        Cash Flow seit Beginn
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-center py-6 text-muted-foreground">
                        <p className="text-sm">Noch keine Buchungen zugeordnet.</p>
                        <p className="text-xs mt-1">
                            Ordnen Sie Buchungen im Buchungsjournal diesem Objekt zu.
                        </p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle className="text-base flex items-center gap-2">
                            <TrendingUp className="h-4 w-4 text-muted-foreground" />
                            Cash Flow seit Beginn
                        </CardTitle>
                        <CardDescription className="mt-1">
                            {data.length} Buchung{data.length !== 1 ? 'en' : ''} zugeordnet
                        </CardDescription>
                    </div>
                    <Select value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
                        <SelectTrigger className="w-[160px] h-8 text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="monthly">Monatlich</SelectItem>
                            <SelectItem value="quarterly">Quartalsweise</SelectItem>
                            <SelectItem value="yearly">Jährlich</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </CardHeader>
            <CardContent className="p-0">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b bg-muted/50">
                                <th className="text-left p-3 font-medium sticky left-0 bg-muted/50 min-w-[200px]">
                                    Position
                                </th>
                                {periods.map((p) => (
                                    <th key={p} className="text-right p-3 font-medium min-w-[110px]">
                                        {getPeriodLabel(p, viewMode)}
                                    </th>
                                ))}
                                <th className="text-right p-3 font-bold min-w-[120px] bg-muted/30">
                                    Gesamt
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {categories.map((cat) => {
                                const label = CATEGORY_LABELS[cat] || cat;
                                const isUncategorized = cat === '__uncategorized__';
                                return (
                                    <tr
                                        key={cat}
                                        className={`border-b last:border-b-0 hover:bg-muted/20 transition-colors ${isUncategorized ? 'text-muted-foreground italic' : ''}`}
                                    >
                                        <td className="p-3 font-medium sticky left-0 bg-background">
                                            {label}
                                        </td>
                                        {periods.map((p) => (
                                            <AmountCell key={p} value={periodData[p]?.[cat] || 0} />
                                        ))}
                                        <AmountCell value={totals[cat]} bold bg="bg-muted/10" />
                                    </tr>
                                );
                            })}
                            {/* Total row */}
                            <tr className="border-t-2 font-bold bg-muted/30">
                                <td className="p-3 sticky left-0 bg-muted/30">Netto Cash Flow</td>
                                {periods.map((p) => (
                                    <AmountCell key={p} value={periodTotals[p] || 0} bold />
                                ))}
                                <td className="p-3 text-right whitespace-nowrap bg-muted/20">
                                    <span className={grandTotal > 0 ? 'text-green-600' : grandTotal < 0 ? 'text-red-600' : ''}>
                                        {fmt(grandTotal)}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
