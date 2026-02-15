'use client';

import { useState, useEffect } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getAvailableBanks, startBankConnection } from '@/lib/bank-actions';
import { Search, Building2, Loader2, ExternalLink } from 'lucide-react';
import type { ASPSP } from '@/lib/enable-banking';

interface BankSelectorProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export default function BankSelector({ open, onOpenChange }: BankSelectorProps) {
    const [banks, setBanks] = useState<ASPSP[]>([]);
    const [filtered, setFiltered] = useState<ASPSP[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open && banks.length === 0) {
            setLoading(true);
            setError(null);
            getAvailableBanks('DE')
                .then((data) => {
                    setBanks(data);
                    setFiltered(data);
                })
                .catch(() => setError('Banken konnten nicht geladen werden'))
                .finally(() => setLoading(false));
        }
    }, [open, banks.length]);

    useEffect(() => {
        if (!search) {
            setFiltered(banks);
        } else {
            const q = search.toLowerCase();
            setFiltered(banks.filter((b) => b.name.toLowerCase().includes(q)));
        }
    }, [search, banks]);

    const handleConnect = async (bank: ASPSP) => {
        setConnecting(bank.name);
        setError(null);
        try {
            const result = await startBankConnection(bank.name, bank.country);
            if (result.error) {
                setError(result.error);
                setConnecting(null);
            } else if (result.url) {
                // Redirect to bank auth page
                window.location.href = result.url;
            }
        } catch {
            setError('Verbindung konnte nicht hergestellt werden');
            setConnecting(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg max-h-[80vh]">
                <DialogHeader>
                    <DialogTitle>Bank verbinden</DialogTitle>
                    <DialogDescription>
                        Wählen Sie Ihre Bank aus, um Ihr Konto automatisch zu verbinden.
                    </DialogDescription>
                </DialogHeader>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Bank suchen..."
                        className="pl-9"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>

                {error && (
                    <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">
                        {error}
                    </div>
                )}

                <div className="overflow-y-auto max-h-[400px] space-y-1 pr-1">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-sm text-muted-foreground">Banken werden geladen...</span>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-12 text-sm text-muted-foreground">
                            {search ? 'Keine Bank gefunden' : 'Keine Banken verfügbar'}
                        </div>
                    ) : (
                        filtered.map((bank) => (
                            <button
                                key={bank.name}
                                className="w-full flex items-center gap-3 p-3 rounded-md hover:bg-gray-50 transition-colors text-left group disabled:opacity-50"
                                onClick={() => handleConnect(bank)}
                                disabled={connecting !== null}
                            >
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                                    {bank.logo ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={bank.logo} alt="" className="h-6 w-6 object-contain" />
                                    ) : (
                                        <Building2 className="h-5 w-5" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{bank.name}</p>
                                    {bank.bic && (
                                        <p className="text-xs text-muted-foreground">{bank.bic}</p>
                                    )}
                                </div>
                                {connecting === bank.name ? (
                                    <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                                ) : (
                                    <ExternalLink className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                )}
                            </button>
                        ))
                    )}
                </div>

                <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                    Sichere Verbindung über Enable Banking (PSD2)
                </div>
            </DialogContent>
        </Dialog>
    );
}
