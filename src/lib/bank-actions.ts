'use server';

import { prisma } from '@/lib/db';
import {
    startAuthorization,
    createSession,
    getAccountTransactions,
    getAccountDetails,
    listAspsps,
    type ASPSP,
    type Transaction,
} from './enable-banking';
import { revalidatePath } from 'next/cache';

// ── Constants ──────────────────────────────────────────────

const KAUTION_KEYWORDS = ['kaution', 'mietkaution', 'mietsicherheit', 'kautionszahlung'];

function isKaution(purpose: string | null): boolean {
    if (!purpose) return false;
    const lower = purpose.toLowerCase();
    return KAUTION_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Map service-provider categories → booking NK labels */
const SP_TO_NK: Record<string, string> = {
    strom: 'NK: Strom',
    gas: 'NK: Gas',
    wasser: 'NK: Wasser',
    heizung: 'NK: Gas',
    wohngebaeudeversicherung: 'NK: Wohngebäudeversicherung',
    haftpflichtversicherung: 'NK: Haftpflichtversicherung',
    grundbesitzabgaben: 'NK: Grundbesitzabgaben',
    verbrauchsdatenerfassung: 'NK: Verbrauchsdatenerfassung',
    hausverwaltung: 'NK: Sonstige Dienstleister',
    wartung: 'NK: Sonstige Dienstleister',
    sonstige: 'NK: Sonstige Dienstleister',
};

interface ProviderInput {
    id: string;
    category: string;
    contractNumber: string | null;
}

type SPRecord = { name: string; category: string; contractNumber: string | null; propertyId: string };

// ── Shared helpers ─────────────────────────────────────────

async function getOrgId(): Promise<string> {
    const org = await prisma.organization.findFirst();
    if (!org) throw new Error('No organization found');
    return org.id;
}

/** Match a transaction against service providers. Returns best match or null. */
function matchSP(
    purpose: string | null,
    creditorName: string | null,
    providers: SPRecord[],
): { propertyId: string; category: string } | null {
    const purposeLower = (purpose || '').toLowerCase();
    const creditorLower = (creditorName || '').toLowerCase();

    // Priority 1: contract number in purpose text (definitive)
    for (const sp of providers) {
        if (!sp.contractNumber) continue;
        const ref = sp.contractNumber.trim().toLowerCase();
        if (ref.length < 3) continue;
        if (purposeLower.includes(ref)) {
            const nkCat = SP_TO_NK[sp.category];
            if (nkCat) return { propertyId: sp.propertyId, category: nkCat };
        }
    }

    // Priority 2: provider name in creditor name (fallback)
    if (creditorLower.length > 0) {
        for (const sp of providers) {
            const spName = sp.name.toLowerCase();
            if (spName.length >= 4 && (creditorLower.includes(spName) || spName.includes(creditorLower))) {
                const nkCat = SP_TO_NK[sp.category];
                if (nkCat) return { propertyId: sp.propertyId, category: nkCat };
            }
        }
    }

    return null;
}

function revalidateBanking() {
    revalidatePath('/dashboard/banking');
    revalidatePath('/dashboard/rent-roll');
}

// ── Connection management ──────────────────────────────────

export async function getAvailableBanks(country: string = 'DE'): Promise<ASPSP[]> {
    try {
        return await listAspsps(country);
    } catch (error) {
        console.error('Failed to fetch banks:', error);
        return [];
    }
}

export async function startBankConnection(
    aspspName: string,
    aspspCountry: string = 'DE'
): Promise<{ url: string; error?: string }> {
    try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const redirectUrl = `${appUrl}/api/banking/callback`;

        const connection = await prisma.bankConnection.create({
            data: {
                aspspName,
                aspspCountry,
                status: 'PENDING',
                organizationId: await getOrgId(),
            },
        });

        const authResponse = await startAuthorization(
            aspspName, aspspCountry, redirectUrl, connection.id
        );

        await prisma.bankConnection.update({
            where: { id: connection.id },
            data: { authorizationId: authResponse.authorization_id },
        });

        return { url: authResponse.url };
    } catch (error) {
        console.error('Failed to start bank connection:', error);
        return { url: '', error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function completeBankConnection(
    code: string,
    connectionId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await createSession(code);
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 90);

        await prisma.bankConnection.update({
            where: { id: connectionId },
            data: { sessionId: session.session_id, status: 'ACTIVE', validUntil },
        });

        for (const account of session.accounts) {
            const accountId = account.uid;
            let iban = account.iban || account.account_id?.iban || null;
            let ownerName: string | null = null;

            try {
                const details = await getAccountDetails(accountId);
                iban = iban || details.iban || null;
                ownerName = details.owner_name || details.name || null;
            } catch (e) {
                console.warn('Could not fetch account details:', e);
            }

            await prisma.bankAccount.create({
                data: {
                    externalId: accountId, iban, ownerName,
                    bankConnectionId: connectionId,
                    organizationId: await getOrgId(),
                },
            });
        }

        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to complete bank connection:', error);
        await prisma.bankConnection.update({
            where: { id: connectionId },
            data: { status: 'ERROR' },
        });
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function deleteBankConnection(connectionId: string): Promise<{ success: boolean }> {
    try {
        await prisma.bankConnection.delete({ where: { id: connectionId } });
        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to delete bank connection:', error);
        return { success: false };
    }
}

// ── Sync ───────────────────────────────────────────────────

export async function syncBankTransactions(
    bankAccountId: string
): Promise<{ count: number; error?: string }> {
    try {
        const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
        if (!account) return { count: 0, error: 'Account not found' };

        // Fetch from last sync or max PSD2 history (730 days)
        let dateFrom: string;
        if (account.lastSyncedAt) {
            dateFrom = account.lastSyncedAt.toISOString().split('T')[0];
        } else {
            const maxHistory = new Date();
            maxHistory.setDate(maxHistory.getDate() - 730);
            dateFrom = maxHistory.toISOString().split('T')[0];
        }

        // Paginate through all transactions
        let allTransactions: Transaction[] = [];
        let continuationKey: string | undefined;
        do {
            const response = await getAccountTransactions(account.externalId, dateFrom, continuationKey);
            allTransactions = allTransactions.concat(response.transactions);
            continuationKey = response.continuation_key || undefined;
        } while (continuationKey);

        // Upsert transactions
        let imported = 0;
        for (const tx of allTransactions) {
            const entryRef = tx.entry_reference || tx.transaction_id || null;
            const amount = tx.transaction_amount ? parseFloat(tx.transaction_amount.amount) : 0;
            const signedAmount = tx.credit_debit_indicator === 'DBIT' ? -Math.abs(amount) : Math.abs(amount);
            const bookingDate = tx.booking_date || tx.transaction_date || tx.value_date;
            if (!bookingDate) continue;

            const data = {
                bookingDate: new Date(bookingDate),
                valueDate: tx.value_date ? new Date(tx.value_date) : null,
                amount: signedAmount,
                currency: tx.transaction_amount?.currency || 'EUR',
                creditDebitIndicator: tx.credit_debit_indicator || null,
                debtorName: tx.debtor?.name || null,
                debtorIban: tx.debtor_account?.iban || null,
                creditorName: tx.creditor?.name || null,
                creditorIban: tx.creditor_account?.iban || null,
                purpose: tx.remittance_information?.join(' ') || null,
                transactionCode: tx.bank_transaction_code?.description || null,
                bankAccountId: account.id,
            };

            if (entryRef) {
                await prisma.bankTransaction.upsert({
                    where: { bankAccountId_entryReference: { bankAccountId: account.id, entryReference: entryRef } },
                    create: { ...data, entryReference: entryRef },
                    update: data,
                });
            } else {
                await prisma.bankTransaction.create({ data });
            }
            imported++;
        }

        await prisma.bankAccount.update({
            where: { id: bankAccountId },
            data: { lastSyncedAt: new Date() },
        });

        await autoAssignNewTransactions(bankAccountId);
        revalidatePath('/dashboard/banking');
        return { count: imported };
    } catch (error) {
        console.error('Failed to sync transactions:', error);
        return { count: 0, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function syncAllBankAccounts(): Promise<{ synced: number; errors: string[] }> {
    const accounts = await prisma.bankAccount.findMany({
        where: { bankConnection: { status: 'ACTIVE' } },
    });
    let synced = 0;
    const errors: string[] = [];
    for (const account of accounts) {
        const result = await syncBankTransactions(account.id);
        if (result.error) errors.push(`${account.iban || account.id}: ${result.error}`);
        else synced++;
    }
    return { synced, errors };
}

// ── Transaction assignment ─────────────────────────────────

export async function assignTransaction(
    transactionId: string,
    assignment: { propertyId?: string | null; tenantId?: string | null; category?: string | null }
): Promise<{ updated: number }> {
    const category = assignment.category ?? null;

    const tx = await prisma.bankTransaction.update({
        where: { id: transactionId },
        data: {
            propertyId: assignment.propertyId,
            tenantId: assignment.tenantId,
            category,
        },
    });

    const counterpartIban = tx.amount >= 0 ? tx.debtorIban : tx.creditorIban;
    let propagated = 0;

    // INCOMING: same debtor IBAN = same tenant
    if (counterpartIban && tx.amount >= 0) {
        const candidates = await prisma.bankTransaction.findMany({
            where: { debtorIban: counterpartIban, id: { not: transactionId }, propertyId: null },
            select: { id: true, purpose: true },
        });
        for (const c of candidates) {
            const cat = isKaution(c.purpose) ? 'Kaution' : 'Bruttomieteinnahmen';
            await prisma.bankTransaction.update({
                where: { id: c.id },
                data: { propertyId: assignment.propertyId, tenantId: assignment.tenantId, category: cat },
            });
            propagated++;
        }
    }

    // OUTGOING: SP-aware propagation
    if (counterpartIban && tx.amount < 0 && category && assignment.propertyId) {
        const candidates = await prisma.bankTransaction.findMany({
            where: {
                creditorIban: counterpartIban,
                amount: { lt: 0 },
                propertyId: null,
                id: { not: transactionId },
            },
            select: { id: true, purpose: true, creditorName: true },
        });

        if (candidates.length > 0) {
            const allSPs = await prisma.serviceProvider.findMany({
                where: { contractNumber: { not: null } },
                select: { contractNumber: true, propertyId: true, category: true, name: true },
            });

            for (const c of candidates) {
                const spMatch = matchSP(c.purpose, c.creditorName, allSPs);
                const targetProperty = spMatch?.propertyId ?? assignment.propertyId;
                const targetCategory = spMatch?.category ?? category;
                await prisma.bankTransaction.update({
                    where: { id: c.id },
                    data: { propertyId: targetProperty, category: targetCategory },
                });
                propagated++;
            }
        }

        // Fill category for txs already assigned to THIS property
        const r = await prisma.bankTransaction.updateMany({
            where: {
                creditorIban: counterpartIban,
                propertyId: assignment.propertyId,
                category: null,
                id: { not: transactionId },
            },
            data: { category },
        });
        propagated += r.count;
    }

    revalidateBanking();
    return { updated: 1 + propagated };
}

/** Auto-assign newly synced transactions. Called after sync. */
async function autoAssignNewTransactions(bankAccountId: string) {
    // INCOMING: propagate by debtor IBAN
    const assignedTxs = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { gte: 0 },
            OR: [{ propertyId: { not: null } }, { tenantId: { not: null } }],
        },
        select: { debtorIban: true, propertyId: true, tenantId: true },
    });

    const ibanMap = new Map<string, { propertyId: string | null; tenantId: string | null }>();
    for (const tx of assignedTxs) {
        if (tx.debtorIban && !ibanMap.has(tx.debtorIban)) {
            ibanMap.set(tx.debtorIban, { propertyId: tx.propertyId, tenantId: tx.tenantId });
        }
    }

    for (const [iban, a] of ibanMap) {
        await prisma.bankTransaction.updateMany({
            where: { bankAccountId, debtorIban: iban, propertyId: null, tenantId: null },
            data: { propertyId: a.propertyId, tenantId: a.tenantId },
        });
    }

    // OUTGOING: SP matching
    const allProviders = await prisma.serviceProvider.findMany({
        select: { name: true, category: true, contractNumber: true, propertyId: true },
    });

    if (allProviders.length > 0) {
        const unassigned = await prisma.bankTransaction.findMany({
            where: { bankAccountId, amount: { lt: 0 }, propertyId: null },
            select: { id: true, purpose: true, creditorName: true },
        });

        for (const tx of unassigned) {
            const match = matchSP(tx.purpose, tx.creditorName, allProviders);
            if (match) {
                await prisma.bankTransaction.update({
                    where: { id: tx.id },
                    data: { propertyId: match.propertyId, category: match.category },
                });
            }
        }
    }

    // OUTGOING: IBAN+Property category memory
    const uncategorized = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { lt: 0 },
            propertyId: { not: null },
            category: null,
            creditorIban: { not: null },
        },
        select: { id: true, creditorIban: true, propertyId: true },
    });

    const categorized = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { lt: 0 },
            category: { not: null },
            creditorIban: { not: null },
            propertyId: { not: null },
        },
        select: { creditorIban: true, propertyId: true, category: true },
    });

    const catMap = new Map<string, string>();
    for (const tx of categorized) {
        const key = `${tx.creditorIban}|${tx.propertyId}`;
        if (!catMap.has(key)) catMap.set(key, tx.category!);
    }

    for (const tx of uncategorized) {
        const cat = catMap.get(`${tx.creditorIban}|${tx.propertyId}`);
        if (cat) {
            await prisma.bankTransaction.update({
                where: { id: tx.id },
                data: { category: cat },
            });
        }
    }
}

// ── Queries ────────────────────────────────────────────────

export async function getBankConnections() {
    return prisma.bankConnection.findMany({
        where: { organizationId: await getOrgId() },
        include: { accounts: { include: { _count: { select: { transactions: true } } } } },
        orderBy: { createdAt: 'desc' },
    });
}

export async function getBankAccount(accountId: string) {
    return prisma.bankAccount.findUnique({
        where: { id: accountId },
        include: { bankConnection: true },
    });
}

export async function getBankTransactions(
    bankAccountId: string,
    options?: { search?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number }
) {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 50;
    const where: Record<string, unknown> = { bankAccountId };

    if (options?.dateFrom || options?.dateTo) {
        where.bookingDate = {
            ...(options.dateFrom ? { gte: new Date(options.dateFrom) } : {}),
            ...(options.dateTo ? { lte: new Date(options.dateTo) } : {}),
        };
    }
    if (options?.search) {
        where.OR = [
            { purpose: { contains: options.search, mode: 'insensitive' } },
            { debtorName: { contains: options.search, mode: 'insensitive' } },
            { creditorName: { contains: options.search, mode: 'insensitive' } },
        ];
    }

    const [transactions, total] = await Promise.all([
        prisma.bankTransaction.findMany({
            where, orderBy: { bookingDate: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        }),
        prisma.bankTransaction.count({ where }),
    ]);

    return { transactions, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function getTenantPayments(personId: string, page: number = 1, pageSize: number = 10) {
    const skip = (page - 1) * pageSize;
    const where = { tenantId: personId };
    const [transactions, total] = await Promise.all([
        prisma.bankTransaction.findMany({
            where, orderBy: { bookingDate: 'desc' }, skip, take: pageSize,
            include: { property: { select: { id: true, name: true, address: true } } },
        }),
        prisma.bankTransaction.count({ where }),
    ]);
    return { transactions, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function getAssignmentOptions() {
    const properties = await prisma.property.findMany({
        where: { organizationId: await getOrgId() },
        select: {
            id: true, name: true, address: true,
            units: {
                select: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        select: { mainTenant: { select: { id: true, firstName: true, lastName: true } } },
                    },
                },
            },
        },
        orderBy: { name: 'asc' },
    });

    return properties.map((p) => {
        const tenantMap = new Map<string, { id: string; firstName: string; lastName: string }>();
        for (const unit of p.units) {
            for (const lease of unit.leases) tenantMap.set(lease.mainTenant.id, lease.mainTenant);
        }
        return { id: p.id, name: p.name, address: p.address, tenants: Array.from(tenantMap.values()) };
    });
}

// ── Analytics ──────────────────────────────────────────────

export async function getPropertyCashFlow(propertyId: string) {
    const transactions = await prisma.bankTransaction.findMany({
        where: { propertyId },
        select: { id: true, bookingDate: true, amount: true, category: true },
        orderBy: { bookingDate: 'asc' },
    });
    return transactions.map((tx) => ({
        date: tx.bookingDate.toISOString(),
        amount: tx.amount,
        category: tx.category || '__uncategorized__',
    }));
}

function detectFrequency(dates: Date[]): string {
    if (dates.length < 2) return '—';
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
        gaps.push((dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24));
    }
    const avg = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    if (avg <= 45) return 'Monatlich';
    if (avg <= 100) return 'Quartalsweise';
    if (avg <= 200) return 'Halbjährlich';
    return 'Jährlich';
}

export async function getServiceProviderCosts(propertyId: string, providers: ProviderInput[]) {
    const currentYear = new Date().getFullYear();

    const transactions = await prisma.bankTransaction.findMany({
        where: { propertyId },
        select: { bookingDate: true, amount: true, category: true, purpose: true },
        orderBy: { bookingDate: 'asc' },
    });

    const result: Record<string, { frequency: string; yearlyTotal: number }> = {};
    const claimedIndices = new Set<number>();

    // Pass 1: Match by contract number in purpose
    for (const prov of providers) {
        if (!prov.contractNumber) continue;
        const ref = prov.contractNumber.trim().toLowerCase();
        if (ref.length < 3) continue;

        const matched: { date: Date; amount: number }[] = [];
        transactions.forEach((tx, idx) => {
            if ((tx.purpose || '').toLowerCase().includes(ref)) {
                matched.push({ date: tx.bookingDate, amount: tx.amount });
                claimedIndices.add(idx);
            }
        });

        if (matched.length > 0) {
            const yearlyTotal = matched
                .filter((m) => m.date.getFullYear() === currentYear)
                .reduce((s, m) => s + m.amount, 0);
            result[prov.id] = {
                frequency: detectFrequency(matched.map((m) => m.date)),
                yearlyTotal: Math.abs(yearlyTotal),
            };
        }
    }

    // Pass 2: Fall back to NK category for unmatched providers
    const byCat: Record<string, { dates: Date[]; yearlyTotal: number }> = {};
    transactions.forEach((tx, idx) => {
        if (claimedIndices.has(idx)) return;
        const cat = tx.category;
        if (!cat?.startsWith('NK: ')) return;
        if (!byCat[cat]) byCat[cat] = { dates: [], yearlyTotal: 0 };
        byCat[cat].dates.push(tx.bookingDate);
        if (tx.bookingDate.getFullYear() === currentYear) byCat[cat].yearlyTotal += tx.amount;
    });

    for (const prov of providers) {
        if (result[prov.id]) continue;
        const nkLabel = SP_TO_NK[prov.category];
        if (!nkLabel) continue;
        const data = byCat[nkLabel];
        if (data) {
            result[prov.id] = {
                frequency: detectFrequency(data.dates),
                yearlyTotal: Math.abs(data.yearlyTotal),
            };
        }
    }

    return result;
}
