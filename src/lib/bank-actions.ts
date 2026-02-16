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

/**
 * Get the default organization ID (single-tenant).
 */
async function getOrgId(): Promise<string> {
    const org = await prisma.organization.findFirst();
    if (!org) throw new Error('No organization found');
    return org.id;
}

/**
 * List available German banks from Enable Banking.
 */
export async function getAvailableBanks(country: string = 'DE'): Promise<ASPSP[]> {
    try {
        const banks = await listAspsps(country);
        return banks;
    } catch (error) {
        console.error('Failed to fetch banks:', error);
        return [];
    }
}

/**
 * Start connecting a bank account.
 * Creates a BankConnection record and returns the redirect URL.
 */
export async function startBankConnection(
    aspspName: string,
    aspspCountry: string = 'DE'
): Promise<{ url: string; error?: string }> {
    try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const redirectUrl = `${appUrl}/api/banking/callback`;

        // Create the connection record first
        const connection = await prisma.bankConnection.create({
            data: {
                aspspName,
                aspspCountry,
                status: 'PENDING',
                organizationId: await getOrgId(),
            },
        });

        // Start authorization with Enable Banking
        const authResponse = await startAuthorization(
            aspspName,
            aspspCountry,
            redirectUrl,
            connection.id // Use connection ID as state for the callback
        );

        // Update the connection with the authorization ID
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

/**
 * Complete the bank connection after the user returns from the bank.
 * Called by the callback API route.
 */
export async function completeBankConnection(
    code: string,
    connectionId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        // Create session with Enable Banking
        const session = await createSession(code);

        // Calculate validity (90 days)
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 90);

        // Update connection with session info
        await prisma.bankConnection.update({
            where: { id: connectionId },
            data: {
                sessionId: session.session_id,
                status: 'ACTIVE',
                validUntil,
            },
        });

        // Fetch and store account details
        for (const account of session.accounts) {
            const accountId = account.uid;
            let iban = account.iban || account.account_id?.iban || null;
            let ownerName: string | null = null;

            // Try to get detailed account info
            try {
                const details = await getAccountDetails(accountId);
                iban = iban || details.iban || null;
                ownerName = details.owner_name || details.name || null;
            } catch (e) {
                console.warn('Could not fetch account details:', e);
            }

            await prisma.bankAccount.create({
                data: {
                    externalId: accountId,
                    iban,
                    ownerName,
                    bankConnectionId: connectionId,
                    organizationId: await getOrgId(),
                },
            });
        }

        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to complete bank connection:', error);

        // Mark connection as errored
        await prisma.bankConnection.update({
            where: { id: connectionId },
            data: { status: 'ERROR' },
        });

        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Sync transactions for a bank account.
 */
export async function syncBankTransactions(
    bankAccountId: string
): Promise<{ count: number; error?: string }> {
    try {
        const account = await prisma.bankAccount.findUnique({
            where: { id: bankAccountId },
        });

        if (!account) {
            return { count: 0, error: 'Account not found' };
        }

        // Fetch from last sync date or max PSD2 history (730 days / ~2 years)
        let dateFrom: string | undefined;
        if (account.lastSyncedAt) {
            dateFrom = account.lastSyncedAt.toISOString().split('T')[0];
        } else {
            const maxHistory = new Date();
            maxHistory.setDate(maxHistory.getDate() - 730);
            dateFrom = maxHistory.toISOString().split('T')[0];
        }

        // Fetch all pages of transactions
        let allTransactions: Transaction[] = [];
        let continuationKey: string | undefined;

        do {
            const response = await getAccountTransactions(
                account.externalId,
                dateFrom,
                continuationKey
            );
            allTransactions = allTransactions.concat(response.transactions);
            continuationKey = response.continuation_key || undefined;
        } while (continuationKey);

        // Upsert transactions
        let imported = 0;
        for (const tx of allTransactions) {
            const entryRef = tx.entry_reference || tx.transaction_id || null;
            const amount = tx.transaction_amount
                ? parseFloat(tx.transaction_amount.amount)
                : 0;
            const signedAmount =
                tx.credit_debit_indicator === 'DBIT' ? -Math.abs(amount) : Math.abs(amount);

            const bookingDate = tx.booking_date || tx.transaction_date || tx.value_date;
            if (!bookingDate) continue; // Skip transactions without a date

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
                    where: {
                        bankAccountId_entryReference: {
                            bankAccountId: account.id,
                            entryReference: entryRef,
                        },
                    },
                    create: { ...data, entryReference: entryRef },
                    update: data,
                });
            } else {
                // No reference ID — just create (risk of duplicates, but rare)
                await prisma.bankTransaction.create({ data });
            }
            imported++;
        }

        // Update last sync timestamp
        await prisma.bankAccount.update({
            where: { id: bankAccountId },
            data: { lastSyncedAt: new Date() },
        });

        // Auto-assign new transactions based on previously assigned IBANs
        await autoAssignNewTransactions(bankAccountId);

        revalidatePath('/dashboard/banking');
        return { count: imported };
    } catch (error) {
        console.error('Failed to sync transactions:', error);
        return { count: 0, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Delete a bank connection and all its accounts/transactions.
 */
export async function deleteBankConnection(
    connectionId: string
): Promise<{ success: boolean }> {
    try {
        await prisma.bankConnection.delete({
            where: { id: connectionId },
        });
        revalidatePath('/dashboard/banking');
        return { success: true };
    } catch (error) {
        console.error('Failed to delete bank connection:', error);
        return { success: false };
    }
}

/**
 * Get all bank connections for the current organization.
 */
export async function getBankConnections() {
    const connections = await prisma.bankConnection.findMany({
        where: { organizationId: await getOrgId() },
        include: {
            accounts: {
                include: {
                    _count: { select: { transactions: true } },
                },
            },
        },
        orderBy: { createdAt: 'desc' },
    });

    return connections;
}

/**
 * Get a single bank account with connection info.
 */
export async function getBankAccount(accountId: string) {
    return prisma.bankAccount.findUnique({
        where: { id: accountId },
        include: {
            bankConnection: true,
        },
    });
}

/**
 * Get transactions for a bank account with optional filtering.
 */
export async function getBankTransactions(
    bankAccountId: string,
    options?: {
        search?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
        pageSize?: number;
    }
) {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 50;
    const skip = (page - 1) * pageSize;

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
            where,
            orderBy: { bookingDate: 'desc' },
            skip,
            take: pageSize,
        }),
        prisma.bankTransaction.count({ where }),
    ]);

    return {
        transactions,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

/**
 * Keywords that identify a Kaution (deposit) transaction.
 */
const KAUTION_KEYWORDS = ['kaution', 'mietkaution', 'mietsicherheit', 'kautionszahlung'];

function isKaution(purpose: string | null): boolean {
    if (!purpose) return false;
    const lower = purpose.toLowerCase();
    return KAUTION_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Assign a transaction to a property and/or tenant.
 * Auto-detects category from purpose text (Kaution vs Bruttomieteinnahmen).
 * Auto-propagates to unassigned transactions from the same IBAN,
 * but EXCLUDES Kaution transactions from propagation.
 */
export async function assignTransaction(
    transactionId: string,
    assignment: { propertyId?: string | null; tenantId?: string | null; category?: string | null }
): Promise<{ updated: number }> {
    // Use user-provided category, or auto-detect from purpose
    let category = assignment.category;
    if (!category) {
        const existing = await prisma.bankTransaction.findUnique({
            where: { id: transactionId },
            select: { purpose: true },
        });
        category = isKaution(existing?.purpose ?? null) ? 'Kaution' : null;
    }

    // Update the target transaction with auto-detected category
    const tx = await prisma.bankTransaction.update({
        where: { id: transactionId },
        data: {
            propertyId: assignment.propertyId,
            tenantId: assignment.tenantId,
            category: category,
        },
    });

    // Determine counterpart IBAN for propagation
    const counterpartIban = tx.amount >= 0 ? tx.debtorIban : tx.creditorIban;

    let propagated = 0;
    if (counterpartIban) {
        const ibanField = tx.amount >= 0 ? 'debtorIban' : 'creditorIban';

        // Find ALL other transactions from the same IBAN (assigned or not)
        const candidates = await prisma.bankTransaction.findMany({
            where: {
                [ibanField]: counterpartIban,
                id: { not: transactionId },
            },
            select: { id: true, purpose: true },
        });

        // Assign each non-Kaution transaction
        for (const c of candidates) {
            const cat = isKaution(c.purpose) ? 'Kaution' : 'Bruttomieteinnahmen';
            if (cat === 'Kaution') continue; // skip Kaution from propagation

            await prisma.bankTransaction.update({
                where: { id: c.id },
                data: {
                    propertyId: assignment.propertyId,
                    tenantId: assignment.tenantId,
                    category: cat,
                },
            });
            propagated++;
        }
    }

    revalidatePath('/dashboard/banking');
    revalidatePath('/dashboard/rent-roll');
    return { updated: 1 + propagated };
}

/**
 * Auto-assign newly synced transactions based on previously assigned IBANs.
 * Called internally after sync completes.
 */
async function autoAssignNewTransactions(bankAccountId: string) {
    // Get all distinct counterpart IBANs that have assignments
    const assignedTxs = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            OR: [
                { propertyId: { not: null } },
                { tenantId: { not: null } },
            ],
        },
        select: {
            debtorIban: true,
            creditorIban: true,
            propertyId: true,
            tenantId: true,
            amount: true,
        },
    });

    // Build a map: counterpart IBAN -> assignment
    const ibanAssignments = new Map<string, { propertyId: string | null; tenantId: string | null }>();
    for (const tx of assignedTxs) {
        const iban = tx.amount >= 0 ? tx.debtorIban : tx.creditorIban;
        if (iban && !ibanAssignments.has(iban)) {
            ibanAssignments.set(iban, {
                propertyId: tx.propertyId,
                tenantId: tx.tenantId,
            });
        }
    }

    // Apply assignments to unassigned transactions
    for (const [iban, assignment] of ibanAssignments) {
        // Update credits (debtorIban match)
        await prisma.bankTransaction.updateMany({
            where: {
                bankAccountId,
                debtorIban: iban,
                propertyId: null,
                tenantId: null,
            },
            data: {
                propertyId: assignment.propertyId,
                tenantId: assignment.tenantId,
            },
        });
        // Update debits (creditorIban match)
        await prisma.bankTransaction.updateMany({
            where: {
                bankAccountId,
                creditorIban: iban,
                propertyId: null,
                tenantId: null,
            },
            data: {
                propertyId: assignment.propertyId,
                tenantId: assignment.tenantId,
            },
        });
    }
}

/**
 * Get transactions assigned to a specific tenant, paginated.
 */
export async function getTenantPayments(
    personId: string,
    page: number = 1,
    pageSize: number = 10
) {
    const skip = (page - 1) * pageSize;

    const where = { tenantId: personId };

    const [transactions, total] = await Promise.all([
        prisma.bankTransaction.findMany({
            where,
            orderBy: { bookingDate: 'desc' },
            skip,
            take: pageSize,
            include: {
                property: { select: { id: true, name: true, address: true } },
            },
        }),
        prisma.bankTransaction.count({ where }),
    ]);

    return {
        transactions,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

/**
 * Get properties and their tenants for the assignment dropdowns.
 */
export async function getAssignmentOptions() {
    const orgId = await getOrgId();

    const properties = await prisma.property.findMany({
        where: { organizationId: orgId },
        select: {
            id: true,
            name: true,
            address: true,
            units: {
                select: {
                    leases: {
                        where: { status: 'ACTIVE' },
                        select: {
                            mainTenant: {
                                select: { id: true, firstName: true, lastName: true },
                            },
                        },
                    },
                },
            },
        },
        orderBy: { name: 'asc' },
    });

    // Flatten: each property gets a unique list of tenants
    return properties.map((p) => {
        const tenantMap = new Map<string, { id: string; firstName: string; lastName: string }>();
        for (const unit of p.units) {
            for (const lease of unit.leases) {
                tenantMap.set(lease.mainTenant.id, lease.mainTenant);
            }
        }
        return {
            id: p.id,
            name: p.name,
            address: p.address,
            tenants: Array.from(tenantMap.values()),
        };
    });
}

/**
 * Sync all active bank accounts (for cron job).
 */
export async function syncAllBankAccounts(): Promise<{
    synced: number;
    errors: string[];
}> {
    const accounts = await prisma.bankAccount.findMany({
        where: {
            bankConnection: { status: 'ACTIVE' },
        },
    });

    let synced = 0;
    const errors: string[] = [];

    for (const account of accounts) {
        const result = await syncBankTransactions(account.id);
        if (result.error) {
            errors.push(`${account.iban || account.id}: ${result.error}`);
        } else {
            synced++;
        }
    }

    return { synced, errors };
}

/**
 * Get raw cash flow transactions for a property.
 * Returns individual transactions so the client can aggregate by month/quarter/year.
 */
export async function getPropertyCashFlow(propertyId: string) {
    const transactions = await prisma.bankTransaction.findMany({
        where: { propertyId },
        select: {
            id: true,
            bookingDate: true,
            amount: true,
            category: true,
        },
        orderBy: { bookingDate: 'asc' },
    });

    return transactions.map((tx) => ({
        date: tx.bookingDate.toISOString(),
        amount: tx.amount,
        category: tx.category || '__uncategorized__',
    }));
}
