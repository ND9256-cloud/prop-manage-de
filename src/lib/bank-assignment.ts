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

// ── Scoring-based Matcher ──────────────────────────────────

type SPRecord = {
    name: string;
    category: string;
    contractNumber: string;
    iban: string;
    propertyId: string;
    monthlyCost: number | null;
};

/** Normalize text for comparison: lowercase, strip umlauts, collapse whitespace */
function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Score-based outgoing transaction matching.
 * For each SP, count how many signals match the transaction:
 *   +1  IBAN matches (exact, ignoring spaces)
 *   +1  Referenznummer found in Verwendungszweck
 *   +1  SP name overlaps with creditor name
 *   -1  SP has a known ref BUT the purpose contains a different ref-like number (same provider, different contract)
 *
 * The SP with the highest score wins.
 * Minimum score of 2 required to auto-assign (avoids false positives from a single weak signal).
 */
function matchByScore(
    creditorName: string | null,
    creditorIban: string | null,
    purpose: string | null,
    providers: SPRecord[],
): { propertyId: string; category: string } | null {

    const normalizedIban = creditorIban?.replace(/\s/g, '') ?? '';
    const normalizedName = creditorName ? normalize(creditorName) : '';
    const normalizedPurpose = purpose ? normalize(purpose) : '';

    // Extract all number sequences from the purpose that could be reference numbers (5+ digits)
    const purposeNumbers = normalizedPurpose ? normalizedPurpose.match(/\d{5,}/g) ?? [] : [];

    let bestMatch: SPRecord | null = null;
    let bestScore = 0;

    for (const sp of providers) {
        let score = 0;

        // Signal 1: IBAN match
        if (normalizedIban && sp.iban !== 'nicht bekannt') {
            if (sp.iban.replace(/\s/g, '') === normalizedIban) {
                score += 1;
            }
        }

        // Signal 2: Reference number in purpose
        const hasKnownRef = sp.contractNumber !== 'nicht bekannt' && sp.contractNumber.trim().length >= 3;
        const spRef = hasKnownRef ? sp.contractNumber.trim().toLowerCase() : '';
        let refMatched = false;

        if (normalizedPurpose && hasKnownRef) {
            if (normalizedPurpose.includes(spRef)) {
                score += 1;
                refMatched = true;
            }
        }

        // Penalty: SP has a known ref, purpose has number-like references, but NONE match the SP's ref
        // This means the transaction likely belongs to a different contract with the same provider
        if (hasKnownRef && !refMatched && purposeNumbers.length > 0) {
            // Check if any of the purpose numbers look like they could be a contract/reference number
            // and none of them match this SP's contract number
            const anyMatch = purposeNumbers.some(n => n === spRef || spRef.includes(n) || n.includes(spRef));
            if (!anyMatch) {
                score -= 1;
            }
        }

        // Signal 3: Name overlap (creditor name contains SP name or vice versa)
        if (normalizedName && sp.name) {
            const spName = normalize(sp.name);
            // Check if the first significant word (>= 4 chars) of the SP name appears in the creditor name
            const spWords = spName.split(' ').filter(w => w.length >= 4);
            const nameHits = spWords.filter(w => normalizedName.includes(w));
            if (nameHits.length >= 1 && spWords.length > 0) {
                score += 1;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = sp;
        }
    }

    // Require at least 2 signals to auto-assign
    if (bestScore >= 2 && bestMatch) {
        return { propertyId: bestMatch.propertyId, category: bestMatch.category };
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

    // OUTGOING: Score-based matching (name + IBAN + reference number)
    const allProviders = await prisma.serviceProvider.findMany({
        select: { id: true, name: true, category: true, contractNumber: true, iban: true, propertyId: true, monthlyCost: true },
    });

    if (allProviders.length > 0) {
        const unassigned = await prisma.bankTransaction.findMany({
            where: { bankAccountId, amount: { lt: 0 }, propertyId: null },
            select: { id: true, creditorName: true, creditorIban: true, purpose: true, amount: true },
        });

        for (const tx of unassigned) {
            const match = matchByScore(tx.creditorName, tx.creditorIban, tx.purpose, allProviders);
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
