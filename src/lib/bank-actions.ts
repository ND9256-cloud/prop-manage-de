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

// --- Constants ---

const KAUTION_KEYWORDS = ['kaution', 'mietkaution', 'mietsicherheit', 'kautionszahlung'];

function isKaution(purpose: string | null): boolean {
    if (!purpose) return false;
    const lower = purpose.toLowerCase();
    return KAUTION_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Map service-provider categories → booking NK: labels */
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

// --- Transaction Assignment ---

/**
 * Assign a transaction to a property/tenant with category propagation.
 * Incoming: propagates property + tenant + auto-Bruttomieteinnahmen to same debtor IBAN.
 * Outgoing: propagates property + category to same creditor IBAN.
 */
export async function assignTransaction(
    transactionId: string,
    assignment: { propertyId?: string | null; tenantId?: string | null; category?: string | null }
): Promise<{ updated: number }> {
    let category = assignment.category ?? null;

    // Update the target transaction with auto-detected category
    const tx = await prisma.bankTransaction.update({
        where: { id: transactionId },
        data: {
            propertyId: assignment.propertyId,
            tenantId: assignment.tenantId,
            category: category,
        },
    });

    const counterpartIban = tx.amount >= 0 ? tx.debtorIban : tx.creditorIban;
    let propagated = 0;

    // INCOMING: same debtor IBAN = same tenant → propagate property + tenant + category
    if (counterpartIban && tx.amount >= 0) {
        // Find unassigned incoming transactions from the same debtor IBAN
        const candidates = await prisma.bankTransaction.findMany({
            where: {
                debtorIban: counterpartIban,
                id: { not: transactionId },
                propertyId: null,
            },
            select: { id: true, purpose: true },
        });

        for (const c of candidates) {
            const cat = isKaution(c.purpose) ? 'Kaution' : 'Bruttomieteinnahmen';
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

    // OUTGOING: SP-aware propagation.
    // When categorizing an outgoing payment, propagate to other transactions
    // from the same creditor IBAN — but check SP records first so that
    // different contract numbers route to different properties.
    if (counterpartIban && tx.amount < 0 && category && assignment.propertyId) {
        // Fetch unassigned outgoing txs from the same creditor IBAN
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
            // Load all SPs that have a contract number
            const allSPs = await prisma.serviceProvider.findMany({
                where: { contractNumber: { not: null } },
                select: { contractNumber: true, propertyId: true, category: true, name: true },
            });

            for (const c of candidates) {
                const purposeLower = (c.purpose || '').toLowerCase();
                let matched = false;

                // Check if any SP contract number matches this tx's purpose
                for (const sp of allSPs) {
                    const ref = (sp.contractNumber || '').trim().toLowerCase();
                    if (ref.length < 3) continue;
                    if (purposeLower.includes(ref)) {
                        // SP match → route to this SP's property + category
                        const nkCat = SP_TO_NK[sp.category] || category;
                        await prisma.bankTransaction.update({
                            where: { id: c.id },
                            data: { propertyId: sp.propertyId, category: nkCat },
                        });
                        matched = true;
                        propagated++;
                        break;
                    }
                }

                // No SP match → fall back to same property + category as the manual assignment
                if (!matched) {
                    await prisma.bankTransaction.update({
                        where: { id: c.id },
                        data: { propertyId: assignment.propertyId, category },
                    });
                    propagated++;
                }
            }
        }

        // Pass 2: Assign category only to txs that already have THIS property
        // but are missing a category (e.g., property was assigned manually already).
        const r2 = await prisma.bankTransaction.updateMany({
            where: {
                creditorIban: counterpartIban,
                propertyId: assignment.propertyId,
                category: null,
                id: { not: transactionId },
            },
            data: { category },
        });

        propagated += r2.count;
    }

    revalidatePath('/dashboard/banking');
    revalidatePath('/dashboard/rent-roll');
    return { updated: 1 + propagated };
}

/** Auto-assign newly synced transactions. Called after sync. */
async function autoAssignNewTransactions(bankAccountId: string) {
    // Get all distinct debtor IBANs (incoming payments) that have assignments
    const assignedTxs = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { gte: 0 },  // incoming only
            OR: [
                { propertyId: { not: null } },
                { tenantId: { not: null } },
            ],
        },
        select: {
            debtorIban: true,
            propertyId: true,
            tenantId: true,
        },
    });

    // Build a map: debtor IBAN -> assignment (first match wins)
    const ibanAssignments = new Map<string, { propertyId: string | null; tenantId: string | null }>();
    for (const tx of assignedTxs) {
        if (tx.debtorIban && !ibanAssignments.has(tx.debtorIban)) {
            ibanAssignments.set(tx.debtorIban, {
                propertyId: tx.propertyId,
                tenantId: tx.tenantId,
            });
        }
    }

    // Apply assignments to unassigned incoming transactions only
    for (const [iban, assignment] of ibanAssignments) {
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
    }

    // OUTGOING: Service Provider matching.
    // Load all service providers and match against unassigned outgoing transactions.
    // Priority: (1) Referenznummer in purpose, (2) provider name in creditor name.
    // A match determines both the property (from SP) and the NK: category.
    const allProviders = await prisma.serviceProvider.findMany({
        select: {
            name: true,
            category: true,
            contractNumber: true,
            propertyId: true,
        },
    });

    if (allProviders.length > 0) {
        const unassignedOutgoing = await prisma.bankTransaction.findMany({
            where: {
                bankAccountId,
                amount: { lt: 0 },
                propertyId: null,
            },
            select: {
                id: true,
                purpose: true,
                creditorName: true,
            },
        });

        for (const tx of unassignedOutgoing) {
            const purposeLower = (tx.purpose || '').toLowerCase();
            const creditorLower = (tx.creditorName || '').toLowerCase();

            let bestMatch: { propertyId: string; category: string } | null = null;

            // Pass 1: Match by Referenznummer in purpose (highest confidence)
            for (const sp of allProviders) {
                if (!sp.contractNumber) continue;
                const ref = sp.contractNumber.trim().toLowerCase();
                if (ref.length < 3) continue;
                if (purposeLower.includes(ref)) {
                    const nkCat = SP_TO_NK[sp.category];
                    if (nkCat) {
                        bestMatch = { propertyId: sp.propertyId, category: nkCat };
                        break; // reference number match is definitive
                    }
                }
            }

            // Pass 2: Match by provider name in creditor name (fallback)
            if (!bestMatch && creditorLower.length > 0) {
                for (const sp of allProviders) {
                    const spNameLower = sp.name.toLowerCase();
                    // Check both directions: creditor contains SP name, or SP name contains creditor
                    // Use a minimum of 4 chars to avoid trivial matches
                    if (spNameLower.length >= 4 && (
                        creditorLower.includes(spNameLower) || spNameLower.includes(creditorLower)
                    )) {
                        const nkCat = SP_TO_NK[sp.category];
                        if (nkCat) {
                            bestMatch = { propertyId: sp.propertyId, category: nkCat };
                            break;
                        }
                    }
                }
            }

            if (bestMatch) {
                await prisma.bankTransaction.update({
                    where: { id: tx.id },
                    data: {
                        propertyId: bestMatch.propertyId,
                        category: bestMatch.category,
                    },
                });
            }
        }
    }

    // OUTGOING: IBAN+Property category memory.
    // For outgoing transactions that have a property but no category,
    // look up if we've previously categorized a tx from the same creditorIban + propertyId.
    const uncategorizedOutgoing = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { lt: 0 },
            propertyId: { not: null },
            category: null,
            creditorIban: { not: null },
        },
        select: { id: true, creditorIban: true, propertyId: true },
    });

    // Build lookup: (creditorIban + propertyId) -> category from existing categorized outgoing txs
    const categorizedOutgoing = await prisma.bankTransaction.findMany({
        where: {
            bankAccountId,
            amount: { lt: 0 },
            category: { not: null },
            creditorIban: { not: null },
            propertyId: { not: null },
        },
        select: { creditorIban: true, propertyId: true, category: true },
    });

    const ibanPropertyCategory = new Map<string, string>();
    for (const tx of categorizedOutgoing) {
        const key = `${tx.creditorIban}|${tx.propertyId}`;
        if (!ibanPropertyCategory.has(key)) {
            ibanPropertyCategory.set(key, tx.category!);
        }
    }

    // Apply remembered categories
    for (const tx of uncategorizedOutgoing) {
        const key = `${tx.creditorIban}|${tx.propertyId}`;
        const cat = ibanPropertyCategory.get(key);
        if (cat) {
            await prisma.bankTransaction.update({
                where: { id: tx.id },
                data: { category: cat },
            });
        }
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

function detectFrequency(dates: Date[]): string {
    if (dates.length < 2) return '—';
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
        const diffDays = (dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24);
        gaps.push(diffDays);
    }
    const avgDays = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    if (avgDays <= 45) return 'Monatlich';
    if (avgDays <= 100) return 'Quartalsweise';
    if (avgDays <= 200) return 'Halbjährlich';
    return 'Jährlich';
}

/** Compute yearly spend and payment frequency per service provider. */
export async function getServiceProviderCosts(
    propertyId: string,
    providers: ProviderInput[]
) {
    const currentYear = new Date().getFullYear();

    // Fetch all property transactions (we need purpose for reference matching)
    const transactions = await prisma.bankTransaction.findMany({
        where: { propertyId },
        select: {
            bookingDate: true,
            amount: true,
            category: true,
            purpose: true,
        },
        orderBy: { bookingDate: 'asc' },
    });

    const result: Record<string, { frequency: string; yearlyTotal: number }> = {};

    // Track which tx IDs are already claimed by reference matching
    const claimedIndices = new Set<number>();

    // Pass 1: Match by Referenznummer in purpose text
    for (const prov of providers) {
        if (!prov.contractNumber) continue;
        const ref = prov.contractNumber.trim().toLowerCase();
        if (ref.length < 3) continue; // avoid matching trivially short strings

        const matched: { date: Date; amount: number }[] = [];
        transactions.forEach((tx, idx) => {
            const purpose = (tx.purpose || '').toLowerCase();
            if (purpose.includes(ref)) {
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

    // Pass 2: For providers without reference match, fall back to NK: category
    // Group unclaimed NK: transactions by category
    const byCat: Record<string, { dates: Date[]; yearlyTotal: number }> = {};
    transactions.forEach((tx, idx) => {
        if (claimedIndices.has(idx)) return;
        const cat = tx.category;
        if (!cat || !cat.startsWith('NK: ')) return;
        if (!byCat[cat]) byCat[cat] = { dates: [], yearlyTotal: 0 };
        byCat[cat].dates.push(tx.bookingDate);
        if (tx.bookingDate.getFullYear() === currentYear) {
            byCat[cat].yearlyTotal += tx.amount;
        }
    });

    for (const prov of providers) {
        if (result[prov.id]) continue; // already matched by reference
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

