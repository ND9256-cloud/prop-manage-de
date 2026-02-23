'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

// ── Constants ──────────────────────────────────────────────

const KAUTION_KEYWORDS = ['kaution', 'mietkaution', 'mietsicherheit', 'kautionszahlung'];

function isKaution(purpose: string | null): boolean {
    if (!purpose) return false;
    const lower = purpose.toLowerCase();
    return KAUTION_KEYWORDS.some((kw) => lower.includes(kw));
}

function revalidateBanking() {
    revalidatePath('/dashboard/banking');
    revalidatePath('/dashboard/rent-roll');
}

// ── Decision Tree Matcher ──────────────────────────────────

type SPRecord = {
    name: string;
    category: string;
    contractNumber: string;
    iban: string;
    propertyId: string;
    monthlyCost: number | null;
};

const AMOUNT_TOLERANCE = 0.05; // 5% tolerance for amount matching

/**
 * Decision tree for outgoing transaction matching:
 * 1. IBAN match → filter SPs by exact IBAN
 * 2. If IBAN matches found → verify by Referenznummer (even for single match!)
 * 3. IBAN tiebreak → monthlyCost (±5%)
 * 4. No IBAN matches → Referenznummer across ALL SPs
 * 5. Fallback → historical learning (past manual assignments with same IBAN + similar amount)
 */
async function matchByDecisionTree(
    creditorIban: string | null,
    purpose: string | null,
    amount: number,
    providers: SPRecord[],
): Promise<{ propertyId: string; category: string } | null> {
    if (!creditorIban) return null;

    const normalizedIban = creditorIban.replace(/\s/g, '');

    // Step 1: Filter by IBAN (only SPs that have a known IBAN)
    const ibanMatches = providers.filter(
        (sp) => sp.iban !== 'nicht bekannt' && sp.iban.replace(/\s/g, '') === normalizedIban
    );

    // Step 2: IBAN match(es) found → try Referenznummer to confirm/disambiguate
    if (ibanMatches.length >= 1 && purpose) {
        const match = matchByRef(ibanMatches, purpose);
        if (match) return match;
    }

    // Step 2b: Exactly 1 IBAN match and the SP has NO known contract number → safe to assign
    //          (If SP has a known ref and we didn't match it above, the tx likely belongs to a different contract)
    if (ibanMatches.length === 1) {
        const sp = ibanMatches[0];
        if (sp.contractNumber === 'nicht bekannt') {
            return { propertyId: sp.propertyId, category: sp.category };
        }
        // SP has a known contract number but it wasn't found in the purpose → don't blindly assign
    }

    // Step 3: Multiple IBAN matches → monthlyCost tiebreak
    if (ibanMatches.length > 1) {
        const absAmount = Math.abs(amount);
        const amountMatches = ibanMatches.filter((sp) => {
            if (!sp.monthlyCost || sp.monthlyCost <= 0) return false;
            const diff = Math.abs(sp.monthlyCost - absAmount) / sp.monthlyCost;
            return diff <= AMOUNT_TOLERANCE;
        });
        if (amountMatches.length === 1) {
            return { propertyId: amountMatches[0].propertyId, category: amountMatches[0].category };
        }
    }

    // Step 4: No IBAN matches (or IBAN unknown on SPs) → try Referenznummer across ALL providers
    if (ibanMatches.length === 0 && purpose) {
        const match = matchByRef(providers, purpose);
        if (match) return match;
    }

    // Step 5: Historical learning — check past manually assigned transactions with same IBAN + similar amount
    const absAmount = Math.abs(amount);
    const pastAssignments = await prisma.bankTransaction.findMany({
        where: {
            creditorIban,
            propertyId: { not: null },
            category: { not: null },
            amount: { gte: -(absAmount * (1 + AMOUNT_TOLERANCE)), lte: -(absAmount * (1 - AMOUNT_TOLERANCE)) },
        },
        select: { propertyId: true, category: true },
        orderBy: { bookingDate: 'desc' },
        take: 1,
    });
    if (pastAssignments.length > 0 && pastAssignments[0].propertyId && pastAssignments[0].category) {
        return { propertyId: pastAssignments[0].propertyId, category: pastAssignments[0].category };
    }

    // Can't disambiguate → no auto-assign
    return null;
}

/** Try to match by Referenznummer in purpose text. Longest contract number first. */
function matchByRef(candidates: SPRecord[], purpose: string): { propertyId: string; category: string } | null {
    const purposeLower = purpose.toLowerCase();
    const sorted = [...candidates]
        .filter(sp => sp.contractNumber !== 'nicht bekannt' && sp.contractNumber.trim().length >= 3)
        .sort((a, b) => b.contractNumber.length - a.contractNumber.length);
    for (const sp of sorted) {
        const ref = sp.contractNumber.trim().toLowerCase();
        if (purposeLower.includes(ref)) {
            return { propertyId: sp.propertyId, category: sp.category };
        }
    }
    return null;
}

// ── Transaction assignment ─────────────────────────────────

export async function assignTransaction(
    transactionId: string,
    assignment: { propertyId?: string | null; tenantId?: string | null; category?: string | null }
): Promise<{ updated: number }> {
    const category = assignment.category ?? null;

    const tx = await prisma.bankTransaction.update({
        where: { id: transactionId },
        data: { propertyId: assignment.propertyId, tenantId: assignment.tenantId, category },
    });

    let propagated = 0;

    // INCOMING only: same debtor IBAN = same tenant
    const counterpartIban = tx.amount >= 0 ? tx.debtorIban : tx.creditorIban;

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

    // OUTGOING: Auto-fill SP IBAN if "nicht bekannt"
    if (tx.amount < 0 && tx.creditorIban && category && assignment.propertyId) {
        const unknownIbanSPs = await prisma.serviceProvider.findMany({
            where: { propertyId: assignment.propertyId, category, iban: 'nicht bekannt' },
            select: { id: true, contractNumber: true },
        });

        // If there's exactly one SP with this category and unknown IBAN, auto-fill it
        if (unknownIbanSPs.length === 1) {
            await prisma.serviceProvider.update({
                where: { id: unknownIbanSPs[0].id },
                data: { iban: tx.creditorIban },
            });
        }
    }

    revalidateBanking();
    return { updated: 1 + propagated };
}

/** Auto-assign newly synced transactions. Called after sync and SP create/update. */
export async function autoAssignNewTransactions(bankAccountId: string) {
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

    // OUTGOING: Decision tree matching (IBAN → ref → amount → history)
    const allProviders = await prisma.serviceProvider.findMany({
        select: { id: true, name: true, category: true, contractNumber: true, iban: true, propertyId: true, monthlyCost: true },
    });

    if (allProviders.length > 0) {
        const unassigned = await prisma.bankTransaction.findMany({
            where: { bankAccountId, amount: { lt: 0 }, propertyId: null },
            select: { id: true, creditorIban: true, purpose: true, amount: true },
        });

        for (const tx of unassigned) {
            const match = await matchByDecisionTree(tx.creditorIban, tx.purpose, tx.amount, allProviders);
            if (match) {
                await prisma.bankTransaction.update({
                    where: { id: tx.id },
                    data: { propertyId: match.propertyId, category: match.category },
                });

                // Auto-fill SP IBAN if it was "nicht bekannt" and we now know it from the transaction
                if (tx.creditorIban) {
                    const unknownIbanSPs = allProviders.filter(
                        sp => sp.propertyId === match.propertyId && sp.category === match.category && sp.iban === 'nicht bekannt'
                    );
                    if (unknownIbanSPs.length === 1) {
                        await prisma.serviceProvider.update({
                            where: { id: unknownIbanSPs[0].id },
                            data: { iban: tx.creditorIban },
                        });
                        // Update local cache so subsequent iterations see the filled IBAN
                        unknownIbanSPs[0].iban = tx.creditorIban;
                    }
                }
            }
        }
    }
}

// ── Queries ────────────────────────────────────────────────

/** Get available NK categories for a property based on registered SPs. */
export async function getPropertySPCategories(propertyId: string): Promise<string[]> {
    const sps = await prisma.serviceProvider.findMany({
        where: { propertyId },
        select: { category: true },
    });
    return [...new Set(sps.map((sp) => sp.category))];
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

export async function getServiceProviderCosts(propertyId: string, providers: { id: string; category: string; contractNumber: string }[]) {
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
        if (prov.contractNumber === 'nicht bekannt') continue;
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

    // Pass 2: Fall back to category for unmatched providers
    const byCat: Record<string, { dates: Date[]; yearlyTotal: number }> = {};
    transactions.forEach((tx, idx) => {
        if (claimedIndices.has(idx)) return;
        const cat = tx.category;
        if (!cat) return;
        if (!byCat[cat]) byCat[cat] = { dates: [], yearlyTotal: 0 };
        byCat[cat].dates.push(tx.bookingDate);
        if (tx.bookingDate.getFullYear() === currentYear) byCat[cat].yearlyTotal += tx.amount;
    });

    for (const prov of providers) {
        if (result[prov.id]) continue;
        const data = byCat[prov.category];
        if (data) {
            result[prov.id] = {
                frequency: detectFrequency(data.dates),
                yearlyTotal: Math.abs(data.yearlyTotal),
            };
        }
    }

    return result;
}
