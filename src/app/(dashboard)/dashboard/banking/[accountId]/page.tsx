'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw, Loader2, Landmark } from 'lucide-react';
import TransactionTable from '@/components/banking/transaction-table';
import CSVUpload from '@/components/banking/csv-upload';
import type { BankTransactionRow, AssignmentProperty } from '@/components/banking/transaction-table';
import { getBankTransactions, syncBankTransactions, getBankAccount, getAssignmentOptions } from '@/lib/bank-actions';
import Link from 'next/link';

export default function AccountDetailPage() {
    const params = useParams();
    const accountId = params.accountId as string;

    const [account, setAccount] = useState<{
        id: string;
        iban: string | null;
        ownerName: string | null;
        lastSyncedAt: Date | null;
        bankConnection: { aspspName: string; status: string };
    } | null>(null);
    const [transactions, setTransactions] = useState<BankTransactionRow[]>([]);
    const [properties, setProperties] = useState<AssignmentProperty[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [search, setSearch] = useState('');

    const fetchData = useCallback(async (p: number, s: string) => {
        setLoading(true);
        try {
            const [acc, txResult, assignOpts] = await Promise.all([
                getBankAccount(accountId),
                getBankTransactions(accountId, { page: p, search: s }),
                getAssignmentOptions(),
            ]);
            setAccount(acc);
            setTransactions(txResult.transactions);
            setTotal(txResult.total);
            setPage(txResult.page);
            setTotalPages(txResult.totalPages);
            setProperties(assignOpts);
        } finally {
            setLoading(false);
        }
    }, [accountId]);

    useEffect(() => {
        fetchData(1, '');
    }, [fetchData]);

    const handleSync = async () => {
        setSyncing(true);
        try {
            await syncBankTransactions(accountId);
            await fetchData(1, search);
        } finally {
            setSyncing(false);
        }
    };

    const handlePageChange = (p: number) => {
        fetchData(p, search);
    };

    const handleSearch = (s: string) => {
        setSearch(s);
        fetchData(1, s);
    };

    const formatAmount = (amount: number) => {
        return new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency: 'EUR',
        }).format(amount);
    };

    // Calculate totals
    const totalCredit = transactions
        .filter((tx) => tx.amount > 0)
        .reduce((sum, tx) => sum + tx.amount, 0);
    const totalDebit = transactions
        .filter((tx) => tx.amount < 0)
        .reduce((sum, tx) => sum + tx.amount, 0);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Link href="/dashboard/banking">
                    <Button variant="ghost" size="icon">
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                </Link>
                <div className="flex-1">
                    <h1 className="text-2xl font-bold tracking-tight">Buchungsjournal</h1>
                    {account && (
                        <p className="text-muted-foreground">
                            {account.bankConnection.aspspName}
                            {account.iban && (
                                <span className="font-mono ml-2">
                                    {account.iban.replace(/(.{4})/g, '$1 ').trim()}
                                </span>
                            )}
                        </p>
                    )}
                </div>
                <Button
                    variant="outline"
                    onClick={handleSync}
                    disabled={syncing}
                >
                    {syncing ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Jetzt synchronisieren
                </Button>
            </div>

            {/* Summary Cards */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Eingänge (Seite)</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-green-600">
                            +{formatAmount(totalCredit)}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Ausgänge (Seite)</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-red-600">
                            {formatAmount(totalDebit)}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Buchungen gesamt</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{total.toLocaleString('de-DE')}</div>
                    </CardContent>
                </Card>
            </div>

            {/* CSV Import */}
            <CSVUpload
                bankAccountId={accountId}
                onSuccess={() => fetchData(page, search)}
            />

            {/* Transaction Table */}
            {loading ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Laden...</span>
                </div>
            ) : (
                <TransactionTable
                    transactions={transactions}
                    total={total}
                    page={page}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                    onSearch={handleSearch}
                    properties={properties}
                    onAssigned={() => fetchData(page, search)}
                />
            )}
        </div>
    );
}
