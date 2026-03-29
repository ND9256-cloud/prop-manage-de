'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { deleteBankConnection, syncBankTransactions } from '@/lib/bank-actions';
import { Building2, RefreshCw, Trash2, AlertTriangle, CheckCircle, Clock, Loader2, ExternalLink } from 'lucide-react';
import Link from 'next/link';

interface BankAccountData {
    id: string;
    externalId: string;
    iban: string | null;
    ownerName: string | null;
    lastSyncedAt: Date | null;
    _count: { transactions: number };
}

interface BankConnectionData {
    id: string;
    aspspName: string;
    aspspCountry: string;
    status: string;
    validUntil: Date | null;
    createdAt: Date;
    accounts: BankAccountData[];
}

interface ConnectionListProps {
    connections: BankConnectionData[];
}

export default function ConnectionList({ connections }: ConnectionListProps) {
    const [syncing, setSyncing] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    const handleSync = async (accountId: string) => {
        setSyncing(accountId);
        try {
            await syncBankTransactions(accountId);
        } finally {
            setSyncing(null);
        }
    };

    const handleDelete = async (connectionId: string) => {
        if (!confirm('Bankverbindung wirklich löschen? Alle Transaktionen werden entfernt.')) return;
        setDeleting(connectionId);
        try {
            await deleteBankConnection(connectionId);
        } finally {
            setDeleting(null);
        }
    };

    const getStatusBadge = (status: string, validUntil: Date | null) => {
        const isExpiring = validUntil && new Date(validUntil).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;

        if (status === 'ACTIVE' && isExpiring) {
            return (
                <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    Läuft bald ab
                </Badge>
            );
        }

        switch (status) {
            case 'ACTIVE':
                return (
                    <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Aktiv
                    </Badge>
                );
            case 'PENDING':
                return (
                    <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50">
                        <Clock className="h-3 w-3 mr-1" />
                        Ausstehend
                    </Badge>
                );
            case 'EXPIRED':
                return (
                    <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        Abgelaufen
                    </Badge>
                );
            default:
                return (
                    <Badge variant="outline" className="text-gray-600 border-gray-200">
                        {status}
                    </Badge>
                );
        }
    };

    if (connections.length === 0) {
        return (
            <Card>
                <CardContent className="py-12 text-center">
                    <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-medium mb-2">Keine Bankverbindungen</h3>
                    <p className="text-sm text-muted-foreground">
                        Verbinden Sie Ihre erste Bank, um Transaktionen automatisch zu synchronisieren.
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            {connections.map((connection) => (
                <Card key={connection.id}>
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                                    <Building2 className="h-5 w-5" />
                                </div>
                                <div>
                                    <CardTitle className="text-base">{connection.aspspName}</CardTitle>
                                    <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                                        Verbunden am {new Date(connection.createdAt).toLocaleDateString('de-DE')}
                                        {connection.validUntil && (
                                            <> · Gültig bis {new Date(connection.validUntil).toLocaleDateString('de-DE')}</>
                                        )}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {getStatusBadge(connection.status, connection.validUntil)}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-red-500 hover:text-red-700"
                                    onClick={() => handleDelete(connection.id)}
                                    disabled={deleting === connection.id}
                                >
                                    {deleting === connection.id ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {connection.accounts.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Keine Konten verfügbar</p>
                        ) : (
                            <div className="space-y-2">
                                {connection.accounts.map((account) => (
                                    <div
                                        key={account.id}
                                        className="flex items-center justify-between p-3 rounded-md bg-gray-50 hover:bg-gray-100 transition-colors"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-medium font-mono">
                                                    {account.iban
                                                        ? account.iban.replace(/(.{4})/g, '$1 ').trim()
                                                        : 'IBAN nicht verfügbar'}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-3 mt-1">
                                                {account.ownerName && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {account.ownerName}
                                                    </span>
                                                )}
                                                <span className="text-xs text-muted-foreground">
                                                    {account._count.transactions} Buchungen
                                                </span>
                                                {account.lastSyncedAt && (
                                                    <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                                                        Zuletzt: {new Date(account.lastSyncedAt).toLocaleString('de-DE')}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleSync(account.id)}
                                                disabled={syncing === account.id || connection.status !== 'ACTIVE'}
                                            >
                                                {syncing === account.id ? (
                                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                                ) : (
                                                    <RefreshCw className="h-4 w-4 mr-1" />
                                                )}
                                                Sync
                                            </Button>
                                            <Link href={`/dashboard/banking/${account.id}`}>
                                                <Button variant="outline" size="sm">
                                                    <ExternalLink className="h-4 w-4 mr-1" />
                                                    Buchungen
                                                </Button>
                                            </Link>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
