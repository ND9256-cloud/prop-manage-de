import { Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Landmark, AlertCircle, CheckCircle2 } from 'lucide-react';
import { getBankConnections } from '@/lib/bank-actions';
import ConnectionList from '@/components/banking/connection-list';
import BankingPageClient from './banking-client';

export default async function BankingPage({
    searchParams,
}: {
    searchParams: Promise<{ success?: string; error?: string }>;
}) {
    const params = await searchParams;
    const connections = await getBankConnections();

    // Calculate summary stats
    const totalAccounts = connections.reduce((sum, c) => sum + c.accounts.length, 0);
    const totalTransactions = connections.reduce(
        (sum, c) => sum + c.accounts.reduce((s, a) => s + a._count.transactions, 0),
        0
    );
    const activeConnections = connections.filter((c) => c.status === 'ACTIVE').length;

    return (
        <div className="space-y-6">
            {/* Status messages */}
            {params.success && (
                <div className="flex items-center gap-2 p-4 rounded-md bg-green-50 text-green-700 border border-green-200">
                    <CheckCircle2 className="h-5 w-5" />
                    <span>Bankverbindung erfolgreich hergestellt!</span>
                </div>
            )}
            {params.error && (
                <div className="flex items-center gap-2 p-4 rounded-md bg-red-50 text-red-700 border border-red-200">
                    <AlertCircle className="h-5 w-5" />
                    <span>{params.error}</span>
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Bankkonten</h1>
                    <p className="text-muted-foreground">
                        Verwalten Sie Ihre Bankverbindungen und synchronisieren Sie Transaktionen automatisch.
                    </p>
                </div>
                <BankingPageClient />
            </div>

            {/* Summary Cards */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Verbundene Banken</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{activeConnections}</div>
                        <p className="text-xs text-muted-foreground">
                            {connections.length} Verbindung{connections.length !== 1 ? 'en' : ''} gesamt
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Konten</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{totalAccounts}</div>
                        <p className="text-xs text-muted-foreground">
                            Bankkonten verknüpft
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Buchungen</CardTitle>
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {totalTransactions.toLocaleString('de-DE')}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Transaktionen synchronisiert
                        </p>
                    </CardContent>
                </Card>
            </div>

            {/* Connection List */}
            <Suspense fallback={<div>Laden...</div>}>
                <ConnectionList connections={connections} />
            </Suspense>
        </div>
    );
}
