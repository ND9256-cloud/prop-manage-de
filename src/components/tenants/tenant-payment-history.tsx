'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { getTenantPayments } from '@/lib/bank-actions';

interface PaymentRow {
    id: string;
    bookingDate: Date | string;
    amount: number;
    currency: string;
    purpose: string | null;
    debtorName: string | null;
    creditorName: string | null;
    creditDebitIndicator: string | null;
    property: { id: string; name: string; address: string } | null;
}

interface TenantPaymentHistoryProps {
    personId: string;
    initialTransactions: PaymentRow[];
    initialTotal: number;
    initialPage: number;
    initialTotalPages: number;
}

export default function TenantPaymentHistory({
    personId,
    initialTransactions,
    initialTotal,
    initialPage,
    initialTotalPages,
}: TenantPaymentHistoryProps) {
    const [transactions, setTransactions] = useState<PaymentRow[]>(initialTransactions);
    const [total, setTotal] = useState(initialTotal);
    const [page, setPage] = useState(initialPage);
    const [totalPages, setTotalPages] = useState(initialTotalPages);
    const [loading, setLoading] = useState(false);

    const fetchPage = async (p: number) => {
        setLoading(true);
        try {
            const result = await getTenantPayments(personId, p);
            setTransactions(result.transactions as unknown as PaymentRow[]);
            setTotal(result.total);
            setPage(result.page);
            setTotalPages(result.totalPages);
        } finally {
            setLoading(false);
        }
    };

    const formatAmount = (amount: number, currency: string = 'EUR') => {
        return new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency,
        }).format(amount);
    };

    const formatDate = (date: Date | string) => {
        return new Date(date).toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
    };

    if (total === 0) {
        return (
            <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">Noch keine Zahlungen zugeordnet.</p>
                <p className="text-xs mt-1">
                    Ordnen Sie Buchungen im Buchungsjournal diesem Mieter zu.
                </p>
            </div>
        );
    }

    // Calculate summary stats from current page
    const totalPayments = transactions
        .filter((tx) => tx.amount > 0)
        .reduce((sum, tx) => sum + tx.amount, 0);

    return (
        <div className="space-y-3">
            {/* Summary */}
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {total} Buchung{total !== 1 ? 'en' : ''} zugeordnet
                </span>
                {totalPayments > 0 && (
                    <span className="font-medium text-green-600">
                        Seite: +{formatAmount(totalPayments)}
                    </span>
                )}
            </div>

            {/* Table */}
            <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-muted/50 border-b">
                            <th className="text-left p-3 font-medium">Datum</th>
                            <th className="text-left p-3 font-medium">Verwendungszweck</th>
                            <th className="text-left p-3 font-medium hidden sm:table-cell">Objekt</th>
                            <th className="text-right p-3 font-medium">Betrag</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr>
                                <td colSpan={4} className="text-center py-8">
                                    <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                                </td>
                            </tr>
                        ) : (
                            transactions.map((tx) => (
                                <tr key={tx.id} className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
                                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                                        {formatDate(tx.bookingDate)}
                                    </td>
                                    <td className="p-3 max-w-[250px] truncate">
                                        {tx.purpose || '—'}
                                    </td>
                                    <td className="p-3 hidden sm:table-cell text-muted-foreground text-xs">
                                        {tx.property?.address || '—'}
                                    </td>
                                    <td className="p-3 text-right whitespace-nowrap">
                                        <span
                                            className={`font-mono font-medium ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'
                                                }`}
                                        >
                                            {tx.amount >= 0 ? '+' : ''}
                                            {formatAmount(tx.amount, tx.currency)}
                                        </span>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        Seite {page} von {totalPages}
                    </span>
                    <div className="flex gap-1">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page <= 1 || loading}
                            onClick={() => fetchPage(page - 1)}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= totalPages || loading}
                            onClick={() => fetchPage(page + 1)}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
