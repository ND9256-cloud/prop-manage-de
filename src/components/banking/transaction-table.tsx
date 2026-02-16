'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Search, ArrowUpDown, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Building2, User, Loader2, Tag } from 'lucide-react';

const BOOKING_CATEGORIES = [
    { value: 'Bruttomieteinnahmen', label: 'Bruttomieteinnahmen', group: 'Mieteinnahmen' },
    { value: 'NK: Gas', label: 'Gas', group: 'Umlegbare Nebenkosten' },
    { value: 'NK: Strom', label: 'Strom', group: 'Umlegbare Nebenkosten' },
    { value: 'NK: Versicherung', label: 'Versicherung', group: 'Umlegbare Nebenkosten' },
    { value: 'NK: Grundbesitzabgaben', label: 'Grundbesitzabgaben', group: 'Umlegbare Nebenkosten' },
    { value: 'NK: Verbrauchsdatenerfassung', label: 'Verbrauchsdatenerfassung', group: 'Umlegbare Nebenkosten' },
    { value: 'NK: Sonstige Dienstleister', label: 'Sonstige Dienstleister', group: 'Umlegbare Nebenkosten' },
] as const;

import { assignTransaction } from '@/lib/bank-actions';

export interface BankTransactionRow {
    id: string;
    entryReference: string | null;
    bookingDate: Date | string;
    valueDate: Date | string | null;
    amount: number;
    currency: string;
    creditDebitIndicator: string | null;
    debtorName: string | null;
    debtorIban: string | null;
    creditorName: string | null;
    creditorIban: string | null;
    purpose: string | null;
    transactionCode: string | null;
    bankAccountId: string;
    createdAt: Date | string;
    propertyId?: string | null;
    tenantId?: string | null;
    category?: string | null;
}

export interface AssignmentProperty {
    id: string;
    name: string;
    address: string;
    tenants: { id: string; firstName: string; lastName: string }[];
}

interface TransactionTableProps {
    transactions: BankTransactionRow[];
    total: number;
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    onSearch: (search: string) => void;
    properties?: AssignmentProperty[];
    onAssigned?: () => void;
}

export default function TransactionTable({
    transactions,
    total,
    page,
    totalPages,
    onPageChange,
    onSearch,
    properties = [],
    onAssigned,
}: TransactionTableProps) {
    const [search, setSearch] = useState('');
    const [sortField, setSortField] = useState<string>('bookingDate');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [assigningId, setAssigningId] = useState<string | null>(null);

    const handleSearch = () => {
        onSearch(search);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSearch();
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

    const formatIban = (iban: string) => {
        return iban.replace(/(.{4})/g, '$1 ').trim();
    };

    const sorted = [...transactions].sort((a, b) => {
        let cmp = 0;
        if (sortField === 'bookingDate') {
            cmp = new Date(a.bookingDate).getTime() - new Date(b.bookingDate).getTime();
        } else if (sortField === 'amount') {
            cmp = a.amount - b.amount;
        }
        return sortDir === 'asc' ? cmp : -cmp;
    });

    const toggleSort = (field: string) => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const toggleExpand = (id: string) => {
        setExpandedId(expandedId === id ? null : id);
    };

    const handleAssign = async (
        txId: string,
        propertyId: string | null,
        tenantId: string | null,
        category: string | null
    ) => {
        setAssigningId(txId);
        try {
            await assignTransaction(txId, { propertyId, tenantId, category });
            onAssigned?.();
        } finally {
            setAssigningId(null);
        }
    };

    const getPropertyName = (propertyId: string | null | undefined) => {
        if (!propertyId) return null;
        const prop = properties.find((p) => p.id === propertyId);
        return prop ? prop.address : null;
    };

    const getTenantName = (tenantId: string | null | undefined) => {
        if (!tenantId) return null;
        for (const prop of properties) {
            const tenant = prop.tenants.find((t) => t.id === tenantId);
            if (tenant) return `${tenant.firstName} ${tenant.lastName}`;
        }
        return null;
    };

    return (
        <div className="space-y-4">
            {/* Search */}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Suche nach Name, Verwendungszweck..."
                        className="pl-9"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <Button variant="outline" onClick={handleSearch}>
                    Suchen
                </Button>
            </div>

            {/* Table */}
            <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-gray-50 border-b">
                            <th className="w-8 px-2 py-3"></th>
                            <th className="text-left px-4 py-3 font-medium">
                                <button
                                    className="flex items-center gap-1 hover:text-blue-600"
                                    onClick={() => toggleSort('bookingDate')}
                                >
                                    Datum
                                    <ArrowUpDown className="h-3 w-3" />
                                </button>
                            </th>
                            <th className="text-left px-4 py-3 font-medium">Auftraggeber / Empfänger</th>
                            <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Verwendungszweck</th>
                            <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Zuordnung</th>
                            <th className="text-right px-4 py-3 font-medium">
                                <button
                                    className="flex items-center gap-1 ml-auto hover:text-blue-600"
                                    onClick={() => toggleSort('amount')}
                                >
                                    Betrag
                                    <ArrowUpDown className="h-3 w-3" />
                                </button>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="text-center py-12 text-muted-foreground">
                                    Keine Buchungen gefunden
                                </td>
                            </tr>
                        ) : (
                            sorted.map((tx) => {
                                const counterpart =
                                    tx.amount >= 0
                                        ? tx.debtorName || tx.debtorIban || '—'
                                        : tx.creditorName || tx.creditorIban || '—';
                                const isExpanded = expandedId === tx.id;
                                const propName = getPropertyName(tx.propertyId);
                                const tName = getTenantName(tx.tenantId);
                                const hasAssignment = propName || tName;

                                return (
                                    <>
                                        <tr
                                            key={tx.id}
                                            className={`border-b last:border-b-0 hover:bg-gray-50 transition-colors cursor-pointer ${isExpanded ? 'bg-blue-50/50' : ''}`}
                                            onClick={() => toggleExpand(tx.id)}
                                        >
                                            <td className="px-2 py-3 text-muted-foreground">
                                                {isExpanded ? (
                                                    <ChevronUp className="h-4 w-4" />
                                                ) : (
                                                    <ChevronDown className="h-4 w-4" />
                                                )}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                                                {formatDate(tx.bookingDate)}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="font-medium">{counterpart}</span>
                                            </td>
                                            <td className="px-4 py-3 hidden md:table-cell text-muted-foreground max-w-[300px] truncate">
                                                {tx.purpose || '—'}
                                            </td>
                                            <td className="px-4 py-3 hidden lg:table-cell">
                                                {hasAssignment ? (
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        {propName && (
                                                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                                                                <Building2 className="h-3 w-3" />
                                                                {propName}
                                                            </span>
                                                        )}
                                                        {tName && (
                                                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                                                                <User className="h-3 w-3" />
                                                                {tName}
                                                            </span>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="text-xs text-muted-foreground italic">
                                                        nicht zugeordnet
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-right whitespace-nowrap">
                                                <span
                                                    className={`font-mono font-medium ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'
                                                        }`}
                                                >
                                                    {tx.amount >= 0 ? '+' : ''}
                                                    {formatAmount(tx.amount, tx.currency)}
                                                </span>
                                            </td>
                                        </tr>
                                        {/* Expanded detail row */}
                                        {isExpanded && (
                                            <tr key={`${tx.id}-detail`} className="bg-blue-50/30 border-b">
                                                <td colSpan={6} className="px-6 py-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                                                        {/* Column 1: Transaction details */}
                                                        <div className="space-y-2">
                                                            <DetailField label="Buchungsdatum" value={formatDate(tx.bookingDate)} />
                                                            {tx.valueDate && (
                                                                <DetailField label="Wertstellung" value={formatDate(tx.valueDate)} />
                                                            )}
                                                            <DetailField
                                                                label="Betrag"
                                                                value={formatAmount(tx.amount, tx.currency)}
                                                                className={tx.amount >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}
                                                            />
                                                            <DetailField
                                                                label="Art"
                                                                value={tx.creditDebitIndicator === 'CRDT' ? 'Eingang (Gutschrift)' : tx.creditDebitIndicator === 'DBIT' ? 'Ausgang (Lastschrift)' : tx.creditDebitIndicator || '—'}
                                                            />
                                                            {tx.transactionCode && (
                                                                <DetailField label="Buchungstyp" value={tx.transactionCode} />
                                                            )}
                                                        </div>

                                                        {/* Column 2: Counterpart details */}
                                                        <div className="space-y-2">
                                                            {tx.debtorName && (
                                                                <DetailField label="Auftraggeber" value={tx.debtorName} />
                                                            )}
                                                            {tx.debtorIban && (
                                                                <DetailField label="Auftraggeber IBAN" value={formatIban(tx.debtorIban)} className="font-mono text-xs" />
                                                            )}
                                                            {tx.creditorName && (
                                                                <DetailField label="Empfänger" value={tx.creditorName} />
                                                            )}
                                                            {tx.creditorIban && (
                                                                <DetailField label="Empfänger IBAN" value={formatIban(tx.creditorIban)} className="font-mono text-xs" />
                                                            )}
                                                            {tx.purpose && (
                                                                <DetailField label="Verwendungszweck" value={tx.purpose} />
                                                            )}
                                                            {tx.entryReference && (
                                                                <DetailField label="Referenz" value={tx.entryReference} className="font-mono text-xs text-muted-foreground" />
                                                            )}
                                                        </div>

                                                        {/* Column 3: Assignment */}
                                                        {properties.length > 0 && (
                                                            <div className="space-y-3">
                                                                <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Zuordnung</p>
                                                                <AssignmentSelect
                                                                    tx={tx}
                                                                    properties={properties}
                                                                    assigning={assigningId === tx.id}
                                                                    onAssign={handleAssign}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        {total} Buchungen · Seite {page} von {totalPages}
                    </span>
                    <div className="flex gap-1">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page <= 1}
                            onClick={() => onPageChange(page - 1)}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= totalPages}
                            onClick={() => onPageChange(page + 1)}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Reusable detail field component for the expanded transaction view.
 */
function DetailField({ label, value, className }: { label: string; value: string; className?: string }) {
    return (
        <div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
            <p className={className || ''}>{value}</p>
        </div>
    );
}

/**
 * Assignment dropdowns for property and tenant.
 */
function AssignmentSelect({
    tx,
    properties,
    assigning,
    onAssign,
}: {
    tx: BankTransactionRow;
    properties: AssignmentProperty[];
    assigning: boolean;
    onAssign: (txId: string, propertyId: string | null, tenantId: string | null, category: string | null) => void;
}) {
    const [selectedPropertyId, setSelectedPropertyId] = useState<string>(tx.propertyId || '');
    const [selectedTenantId, setSelectedTenantId] = useState<string>(tx.tenantId || '');
    const [selectedCategory, setSelectedCategory] = useState<string>(tx.category || '');

    const selectedProperty = properties.find((p) => p.id === selectedPropertyId);
    const tenants = selectedProperty?.tenants || [];

    const handlePropertyChange = (value: string) => {
        const propId = value === '__none__' ? '' : value;
        setSelectedPropertyId(propId);
        setSelectedTenantId('');
        if (!propId) {
            onAssign(tx.id, null, null, selectedCategory || null);
        }
    };

    const handleTenantChange = (value: string) => {
        const tenId = value === '__none__' ? '' : value;
        setSelectedTenantId(tenId);
        onAssign(
            tx.id,
            selectedPropertyId || null,
            tenId || null,
            selectedCategory || null
        );
    };

    const handleCategoryChange = (value: string) => {
        const cat = value === '__none__' ? '' : value;
        setSelectedCategory(cat);
        onAssign(
            tx.id,
            selectedPropertyId || null,
            selectedTenantId || null,
            cat || null
        );
    };

    return (
        <div className="space-y-2">
            <div>
                <label className="text-xs text-muted-foreground block mb-1">Objekt</label>
                <Select value={selectedPropertyId || '__none__'} onValueChange={handlePropertyChange} disabled={assigning}>
                    <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Objekt wählen..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="__none__">
                            <span className="text-muted-foreground italic">Keine Zuordnung</span>
                        </SelectItem>
                        {properties.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                                {p.address}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {selectedPropertyId && tenants.length > 0 && (
                <div>
                    <label className="text-xs text-muted-foreground block mb-1">Mieter</label>
                    <Select value={selectedTenantId || '__none__'} onValueChange={handleTenantChange} disabled={assigning}>
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Mieter wählen..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">
                                <span className="text-muted-foreground italic">Kein Mieter</span>
                            </SelectItem>
                            {tenants.map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                    {t.firstName} {t.lastName}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
            <div>
                <label className="text-xs text-muted-foreground block mb-1">Kategorie</label>
                <Select value={selectedCategory || '__none__'} onValueChange={handleCategoryChange} disabled={assigning}>
                    <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Kategorie wählen..." />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="__none__">
                            <span className="text-muted-foreground italic">Keine Kategorie</span>
                        </SelectItem>
                        {(() => {
                            let lastGroup = '';
                            return BOOKING_CATEGORIES.map((cat) => {
                                const showGroup = cat.group !== lastGroup;
                                lastGroup = cat.group;
                                return (
                                    <span key={cat.value}>
                                        {showGroup && (
                                            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mt-1">
                                                {cat.group}
                                            </div>
                                        )}
                                        <SelectItem value={cat.value}>
                                            {cat.label}
                                        </SelectItem>
                                    </span>
                                );
                            });
                        })()}
                    </SelectContent>
                </Select>
            </div>
            {assigning && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Wird zugeordnet...
                </div>
            )}
        </div>
    );
}
