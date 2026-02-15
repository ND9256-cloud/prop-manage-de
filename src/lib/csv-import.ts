'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

/**
 * Parsed CSV transaction row (normalized from various German bank CSV formats).
 */
interface ParsedTransaction {
    bookingDate: Date;
    valueDate: Date | null;
    amount: number;
    currency: string;
    creditDebitIndicator: string;
    debtorName: string | null;
    debtorIban: string | null;
    creditorName: string | null;
    creditorIban: string | null;
    purpose: string | null;
    transactionCode: string | null;
}

/**
 * Parse a date string into a Date object.
 * Supports: "DD.MM.YYYY", "DD.MM.YY", "YYYY-MM-DD"
 */
function parseDate(dateStr: string): Date | null {
    const trimmed = dateStr.trim();

    // ISO format: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
    }

    // German format: DD.MM.YYYY or DD.MM.YY
    const parts = trimmed.split('.');
    if (parts.length !== 3) return null;
    const [day, month, yearPart] = parts.map(Number);
    if (isNaN(day) || isNaN(month) || isNaN(yearPart)) return null;

    // Handle 2-digit years: 00-99 → 2000-2099
    const year = yearPart < 100 ? 2000 + yearPart : yearPart;
    return new Date(year, month - 1, day);
}

/**
 * Parse a German number string "1.234,56" or "-59,90" into a float.
 */
function parseGermanNumber(numStr: string): number {
    const cleaned = numStr
        .trim()
        .replace(/\./g, '')   // remove thousand separators
        .replace(',', '.');    // decimal comma → dot
    return parseFloat(cleaned);
}

/**
 * Split a CSV line respecting quoted fields (handles commas/semicolons inside quotes).
 */
function splitCSVLine(line: string, delimiter: string = ';'): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++; // skip escaped quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current.trim());
    return fields;
}

/**
 * Detect the CSV format based on header columns.
 * Returns a mapping function or null if unrecognized.
 */
function detectFormat(headers: string[]): string {
    const headerStr = headers.join('|').toLowerCase();

    // DKB new format (2020+): "Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)"
    if (headerStr.includes('buchungsdatum') && headerStr.includes('zahlungsempfänger')) {
        return 'dkb_new';
    }

    // DKB old format: "Buchungstag";"Wertstellung";"Buchungstext";"Auftraggeber / Begünstigter";"Verwendungszweck";"Kontonummer";"BLZ";"Betrag (EUR)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"
    if (headerStr.includes('buchungstag') && headerStr.includes('auftraggeber')) {
        return 'dkb_old';
    }

    // Generic: try to find common columns
    if (headerStr.includes('datum') && headerStr.includes('betrag')) {
        return 'generic';
    }

    return 'unknown';
}

/**
 * Parse rows based on the detected format.
 */
function parseRow(fields: string[], headers: string[], format: string): ParsedTransaction | null {
    try {
        switch (format) {
            case 'dkb_new':
                return parseDKBNewRow(fields, headers);
            case 'dkb_old':
                return parseDKBOldRow(fields, headers);
            case 'generic':
                return parseGenericRow(fields, headers);
            default:
                return null;
        }
    } catch {
        return null;
    }
}

function getColumn(fields: string[], headers: string[], ...possibleNames: string[]): string {
    for (const name of possibleNames) {
        const idx = headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
        if (idx !== -1 && idx < fields.length) {
            return fields[idx].replace(/^"|"$/g, '').trim();
        }
    }
    return '';
}

function parseDKBNewRow(fields: string[], headers: string[]): ParsedTransaction | null {
    const bookingDateStr = getColumn(fields, headers, 'Buchungsdatum', 'Buchungstag');
    const valueDateStr = getColumn(fields, headers, 'Wertstellung');
    const payer = getColumn(fields, headers, 'Zahlungspflichtige');
    const payee = getColumn(fields, headers, 'Zahlungsempfänger');
    const purpose = getColumn(fields, headers, 'Verwendungszweck');
    const amountStr = getColumn(fields, headers, 'Betrag');
    const iban = getColumn(fields, headers, 'IBAN');
    const txType = getColumn(fields, headers, 'Umsatztyp');

    const bookingDate = parseDate(bookingDateStr);
    if (!bookingDate) return null;

    const amount = parseGermanNumber(amountStr);
    if (isNaN(amount)) return null;

    const isCredit = amount >= 0;

    return {
        bookingDate,
        valueDate: valueDateStr ? parseDate(valueDateStr) : null,
        amount,
        currency: 'EUR',
        creditDebitIndicator: isCredit ? 'CRDT' : 'DBIT',
        debtorName: isCredit ? payer || null : null,
        debtorIban: isCredit ? iban || null : null,
        creditorName: !isCredit ? payee || null : null,
        creditorIban: !isCredit ? iban || null : null,
        purpose: purpose || null,
        transactionCode: txType || null,
    };
}

function parseDKBOldRow(fields: string[], headers: string[]): ParsedTransaction | null {
    const bookingDateStr = getColumn(fields, headers, 'Buchungstag');
    const valueDateStr = getColumn(fields, headers, 'Wertstellung');
    const counterparty = getColumn(fields, headers, 'Auftraggeber', 'Begünstigter');
    const purpose = getColumn(fields, headers, 'Verwendungszweck');
    const amountStr = getColumn(fields, headers, 'Betrag');
    const txText = getColumn(fields, headers, 'Buchungstext');

    const bookingDate = parseDate(bookingDateStr);
    if (!bookingDate) return null;

    const amount = parseGermanNumber(amountStr);
    if (isNaN(amount)) return null;

    const isCredit = amount >= 0;

    return {
        bookingDate,
        valueDate: valueDateStr ? parseDate(valueDateStr) : null,
        amount,
        currency: 'EUR',
        creditDebitIndicator: isCredit ? 'CRDT' : 'DBIT',
        debtorName: isCredit ? counterparty || null : null,
        debtorIban: null,
        creditorName: !isCredit ? counterparty || null : null,
        creditorIban: null,
        purpose: purpose || null,
        transactionCode: txText || null,
    };
}

function parseGenericRow(fields: string[], headers: string[]): ParsedTransaction | null {
    const dateStr = getColumn(fields, headers, 'Datum', 'Buchungsdatum', 'Buchungstag');
    const amountStr = getColumn(fields, headers, 'Betrag', 'Amount');
    const purpose = getColumn(fields, headers, 'Verwendungszweck', 'Purpose', 'Beschreibung');
    const counterparty = getColumn(fields, headers, 'Empfänger', 'Auftraggeber', 'Name', 'Begünstigter');

    const bookingDate = parseDate(dateStr);
    if (!bookingDate) return null;

    const amount = parseGermanNumber(amountStr);
    if (isNaN(amount)) return null;

    const isCredit = amount >= 0;

    return {
        bookingDate,
        valueDate: null,
        amount,
        currency: 'EUR',
        creditDebitIndicator: isCredit ? 'CRDT' : 'DBIT',
        debtorName: isCredit ? counterparty || null : null,
        debtorIban: null,
        creditorName: !isCredit ? counterparty || null : null,
        creditorIban: null,
        purpose: purpose || null,
        transactionCode: null,
    };
}

/**
 * Check if a transaction is a duplicate by matching on
 * bookingDate + amount + counterparty name + purpose substring.
 */
async function isDuplicate(
    tx: ParsedTransaction,
    bankAccountId: string
): Promise<boolean> {
    const counterpartyName = tx.debtorName || tx.creditorName || null;

    // Find transactions with same date, amount, and counterparty
    const existing = await prisma.bankTransaction.findFirst({
        where: {
            bankAccountId,
            bookingDate: tx.bookingDate,
            amount: tx.amount,
            ...(counterpartyName
                ? {
                    OR: [
                        { debtorName: counterpartyName },
                        { creditorName: counterpartyName },
                    ],
                }
                : {}),
        },
    });

    return !!existing;
}

/**
 * Import transactions from a CSV string into a bank account.
 * Returns counts of imported, skipped (duplicate), and failed rows.
 */
export async function importCSVTransactions(
    bankAccountId: string,
    csvContent: string
): Promise<{
    imported: number;
    duplicates: number;
    failed: number;
    total: number;
    format: string;
    errors: string[];
}> {
    const errors: string[] = [];

    // Normalize line endings and split
    const lines = csvContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter(line => line.trim().length > 0);

    if (lines.length < 2) {
        return { imported: 0, duplicates: 0, failed: 0, total: 0, format: 'unknown', errors: ['CSV file is empty or has no data rows'] };
    }

    // DKB CSVs often have metadata rows before the actual header.
    // Skip lines until we find a line that looks like a header (contains "Buchung" or "Datum").
    let headerIndex = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const lower = lines[i].toLowerCase();
        if (lower.includes('buchung') || (lower.includes('datum') && lower.includes('betrag'))) {
            headerIndex = i;
            break;
        }
    }

    const headers = splitCSVLine(lines[headerIndex]).map(h => h.replace(/^"|"$/g, '').trim());
    const format = detectFormat(headers);

    if (format === 'unknown') {
        return {
            imported: 0, duplicates: 0, failed: 0, total: 0, format,
            errors: [`Unrecognized CSV format. Headers: ${headers.join(', ')}`]
        };
    }

    // Verify the bank account exists
    const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
    if (!account) {
        return { imported: 0, duplicates: 0, failed: 0, total: 0, format, errors: ['Bank account not found'] };
    }

    let imported = 0;
    let duplicates = 0;
    let failed = 0;
    const dataLines = lines.slice(headerIndex + 1);

    for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i];
        if (!line.trim()) continue;

        const fields = splitCSVLine(line);
        const tx = parseRow(fields, headers, format);

        if (!tx) {
            failed++;
            if (failed <= 5) {
                errors.push(`Row ${i + 1}: Could not parse`);
            }
            continue;
        }

        // Check for duplicate
        const dup = await isDuplicate(tx, bankAccountId);
        if (dup) {
            duplicates++;
            continue;
        }

        // Insert the transaction
        try {
            await prisma.bankTransaction.create({
                data: {
                    bookingDate: tx.bookingDate,
                    valueDate: tx.valueDate,
                    amount: tx.amount,
                    currency: tx.currency,
                    creditDebitIndicator: tx.creditDebitIndicator,
                    debtorName: tx.debtorName,
                    debtorIban: tx.debtorIban,
                    creditorName: tx.creditorName,
                    creditorIban: tx.creditorIban,
                    purpose: tx.purpose,
                    transactionCode: tx.transactionCode,
                    entryReference: `csv-${tx.bookingDate.toISOString().split('T')[0]}-${tx.amount.toFixed(2)}-${i}`,
                    bankAccountId,
                },
            });
            imported++;
        } catch (err) {
            failed++;
            if (failed <= 5) {
                errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'DB error'}`);
            }
        }
    }

    revalidatePath('/dashboard/banking');
    return {
        imported,
        duplicates,
        failed,
        total: dataLines.length,
        format,
        errors,
    };
}
