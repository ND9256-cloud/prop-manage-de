import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TrendingUp } from 'lucide-react';

interface CashFlowData {
    years: number[];
    categories: string[];
    yearlyData: Record<number, Record<string, number>>;
    yearTotals?: Record<number, number>;
    totals: Record<string, number>;
    grandTotal?: number;
    transactionCount?: number;
}

const CATEGORY_LABELS: Record<string, string> = {
    Bruttomieteinnahmen: 'Bruttomieteinnahmen',
    __uncategorized__: 'Nicht kategorisiert',
};

function fmt(n: number) {
    return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export default function PropertyCashFlow({ data }: { data: CashFlowData }) {
    const { years, categories, yearlyData, yearTotals, totals, grandTotal, transactionCount } = data;

    if (years.length === 0) {
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
                <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    Cash Flow seit Beginn
                </CardTitle>
                <CardDescription>
                    {transactionCount} Buchung{transactionCount !== 1 ? 'en' : ''} zugeordnet
                </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b bg-muted/50">
                                <th className="text-left p-3 font-medium sticky left-0 bg-muted/50 min-w-[200px]">
                                    Position
                                </th>
                                {years.map((year) => (
                                    <th key={year} className="text-right p-3 font-medium min-w-[130px]">
                                        {year}
                                    </th>
                                ))}
                                <th className="text-right p-3 font-bold min-w-[130px] bg-muted/30">
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
                                        className={`border-b last:border-b-0 hover:bg-muted/20 transition-colors ${isUncategorized ? 'text-muted-foreground italic' : ''
                                            }`}
                                    >
                                        <td className="p-3 font-medium sticky left-0 bg-background">
                                            {label}
                                        </td>
                                        {years.map((year) => {
                                            const value = yearlyData[year]?.[cat] || 0;
                                            return (
                                                <td key={year} className="p-3 text-right whitespace-nowrap">
                                                    <span
                                                        className={
                                                            value > 0
                                                                ? 'text-green-600'
                                                                : value < 0
                                                                    ? 'text-red-600'
                                                                    : 'text-muted-foreground'
                                                        }
                                                    >
                                                        {fmt(value)}
                                                    </span>
                                                </td>
                                            );
                                        })}
                                        <td className="p-3 text-right whitespace-nowrap font-medium bg-muted/10">
                                            <span
                                                className={
                                                    totals[cat] > 0
                                                        ? 'text-green-600'
                                                        : totals[cat] < 0
                                                            ? 'text-red-600'
                                                            : ''
                                                }
                                            >
                                                {fmt(totals[cat])}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                            {/* Total row */}
                            <tr className="border-t-2 font-bold bg-muted/30">
                                <td className="p-3 sticky left-0 bg-muted/30">
                                    Netto Cash Flow
                                </td>
                                {years.map((year) => {
                                    const value = yearTotals?.[year] || 0;
                                    return (
                                        <td key={year} className="p-3 text-right whitespace-nowrap">
                                            <span
                                                className={
                                                    value > 0
                                                        ? 'text-green-600'
                                                        : value < 0
                                                            ? 'text-red-600'
                                                            : ''
                                                }
                                            >
                                                {fmt(value)}
                                            </span>
                                        </td>
                                    );
                                })}
                                <td className="p-3 text-right whitespace-nowrap bg-muted/20">
                                    <span
                                        className={
                                            (grandTotal || 0) > 0
                                                ? 'text-green-600'
                                                : (grandTotal || 0) < 0
                                                    ? 'text-red-600'
                                                    : ''
                                        }
                                    >
                                        {fmt(grandTotal || 0)}
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
