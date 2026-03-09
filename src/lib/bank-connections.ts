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
import { autoAssignNewTransactions } from './bank-assignment';
import { getOrgContext, getOrgContextWritable } from '@/lib/org';

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
        const { orgId } = await getOrgContextWritable();
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const redirectUrl = `${appUrl}/api/banking/callback`;

        const connection = await prisma.bankConnection.create({
            data: {
                aspspName, aspspCountry, status: 'PENDING',
                organizationId: orgId,
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
        const { orgId } = await getOrgContextWritable();

        // Verify connection belongs to this org
        const connection = await prisma.bankConnection.findFirst({
            where: { id: connectionId, organizationId: orgId },
        });
        if (!connection) throw new Error('Not found');

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
                    organizationId: orgId,
                },
            });
        }

        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to complete bank connection:', error);
        if (error instanceof Error && error.message !== 'Not found') {
            await prisma.bankConnection.update({
                where: { id: connectionId },
                data: { status: 'ERROR' },
            }).catch(() => { }); // Swallow if connection doesn't exist
        }
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function deleteBankConnection(connectionId: string): Promise<{ success: boolean }> {
    try {
        const { orgId } = await getOrgContextWritable();
        const { count } = await prisma.bankConnection.deleteMany({
            where: { id: connectionId, organizationId: orgId },
        });
        if (count === 0) throw new Error('Not found');
        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to delete bank connection:', error);
        return { success: false };
    }
}

// ── Sync ───────────────────────────────────────────────────

/**
 * Sync transactions for a single bank account.
 * When called from user context (server action), verifies org ownership.
 * When called internally (cron via syncAllBankAccounts), pass skipOrgCheck=true.
 */
export async function syncBankTransactions(
    bankAccountId: string,
    { skipOrgCheck = false }: { skipOrgCheck?: boolean } = {}
): Promise<{ count: number; error?: string }> {
    try {
        // Org ownership check (skipped only for internal cron calls)
        if (!skipOrgCheck) {
            const { orgId } = await getOrgContextWritable();
            const account = await prisma.bankAccount.findFirst({
                where: { id: bankAccountId, organizationId: orgId },
            });
            if (!account) return { count: 0, error: 'Not found' };
        }

        const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
        if (!account) return { count: 0, error: 'Account not found' };

        let dateFrom: string;
        if (account.lastSyncedAt) {
            dateFrom = account.lastSyncedAt.toISOString().split('T')[0];
        } else {
            const maxHistory = new Date();
            maxHistory.setDate(maxHistory.getDate() - 730);
            dateFrom = maxHistory.toISOString().split('T')[0];
        }

        let allTransactions: Transaction[] = [];
        let continuationKey: string | undefined;
        do {
            const response = await getAccountTransactions(account.externalId, dateFrom, continuationKey);
            allTransactions = allTransactions.concat(response.transactions);
            continuationKey = response.continuation_key || undefined;
        } while (continuationKey);

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

/**
 * Sync all bank accounts. Used by cron job (no user session).
 * Iterates ALL active accounts across ALL orgs.
 * Auth is handled by CRON_SECRET in the route handler.
 */
export async function syncAllBankAccounts(): Promise<{ synced: number; errors: string[] }> {
    const accounts = await prisma.bankAccount.findMany({
        where: { bankConnection: { status: 'ACTIVE' } },
    });
    let synced = 0;
    const errors: string[] = [];
    for (const account of accounts) {
        const result = await syncBankTransactions(account.id, { skipOrgCheck: true });
        if (result.error) errors.push(`${account.iban || account.id}: ${result.error}`);
        else synced++;
    }
    return { synced, errors };
}

// ── Queries ────────────────────────────────────────────────

export async function getBankConnections() {
    const { orgId } = await getOrgContext();
    return prisma.bankConnection.findMany({
        where: { organizationId: orgId },
        include: { accounts: { include: { _count: { select: { transactions: true } } } } },
        orderBy: { createdAt: 'desc' },
    });
}

export async function getBankAccount(accountId: string) {
    const { orgId } = await getOrgContext();
    const account = await prisma.bankAccount.findFirst({
        where: { id: accountId, organizationId: orgId },
        include: { bankConnection: true },
    });
    if (!account) throw new Error('Not found');
    return account;
}

export async function getBankTransactions(
    bankAccountId: string,
    options?: { search?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number }
) {
    const { orgId } = await getOrgContext();

    // Verify account belongs to this org
    const account = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId, organizationId: orgId },
        select: { id: true },
    });
    if (!account) return { transactions: [], total: 0, page: 1, pageSize: 50, totalPages: 0 };

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
    const { orgId } = await getOrgContext();
    const skip = (page - 1) * pageSize;
    const where = {
        tenantId: personId,
        tenant: { organizationId: orgId },
    };
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
    const { orgId } = await getOrgContext();
    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
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
            serviceProviders: {
                select: { category: true },
            },
        },
        orderBy: { name: 'asc' },
    });

    return properties.map((p) => {
        const tenantMap = new Map<string, { id: string; firstName: string; lastName: string }>();
        for (const unit of p.units) {
            for (const lease of unit.leases) tenantMap.set(lease.mainTenant.id, lease.mainTenant);
        }
        const spCategories = [...new Set(p.serviceProviders.map((sp) => sp.category))];
        return { id: p.id, name: p.name, address: p.address, tenants: Array.from(tenantMap.values()), spCategories };
    });
}
