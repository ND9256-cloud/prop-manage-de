/**
 * CSV Import — Operator-only script
 * Run: npx tsx -r dotenv/config scripts/csv-import.ts --org <orgId> --bankAccount <id> --file <path> [--dry-run]
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

// ── Safety limits ──────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROWS = 10_000;

// ── Types ──────────────────────────────────────────────────

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

// ── Parsing helpers ────────────────────────────────────────

function parseDate(dateStr: string): Date | null {
    const trimmed = dateStr.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
    }

    const parts = trimmed.split('.');
    if (parts.length !== 3) return null;
    const [day, month, yearPart] = parts.map(Number);
    if (isNaN(day) || isNaN(month) || isNaN(yearPart)) return null;

    const year = yearPart < 100 ? 2000 + yearPart : yearPart;
    return new Date(year, month - 1, day);
}

function parseGermanNumber(numStr: string): number {
    const cleaned = numStr
        .trim()
        .replace(/\./g, '')
        .replace(',', '.');
    return parseFloat(cleaned);
}

function splitCSVLine(line: string, delimiter: string = ';'): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++;
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

function detectFormat(headers: string[]): string {
    const headerStr = headers.join('|').toLowerCase();

    if (headerStr.includes('buchungsdatum') && headerStr.includes('zahlungsempfänger')) {
        return 'dkb_new';
    }
    if (headerStr.includes('buchungstag') && headerStr.includes('auftraggeber')) {
        return 'dkb_old';
    }
    if (headerStr.includes('datum') && headerStr.includes('betrag')) {
        return 'generic';
    }
    return 'unknown';
}

function parseRow(fields: string[], headers: string[], format: string): ParsedTransaction | null {
    try {
        switch (format) {
            case 'dkb_new': return parseDKBNewRow(fields, headers);
            case 'dkb_old': return parseDKBOldRow(fields, headers);
            case 'generic': return parseGenericRow(fields, headers);
            default: return null;
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

async function isDuplicate(tx: ParsedTransaction, bankAccountId: string): Promise<boolean> {
    const counterpartyName = tx.debtorName || tx.creditorName || null;

    const existing = await prisma.bankTransaction.findFirst({
        where: {
            bankAccountId,
            bookingDate: tx.bookingDate,
            amount: tx.amount,
            ...(counterpartyName
                ? { OR: [{ debtorName: counterpartyName }, { creditorName: counterpartyName }] }
                : {}),
        },
    });

    return !!existing;
}

// ── Audit logging ──────────────────────────────────────────

async function logAudit(orgId: string, eventType: string, metadata: Record<string, unknown>) {
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO shared.audit_log (org_id, action, actor_user_id, actor_email, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            orgId,
            eventType,
            'system',
            'script/csv-import',
            JSON.stringify(metadata),
        );
    } catch (err) {
        console.warn('⚠️  Audit log write failed:', err instanceof Error ? err.message : err);
    }
}

// ── Main import function ───────────────────────────────────

async function importCSVTransactions(
    orgId: string,
    bankAccountId: string,
    csvContent: string,
    dryRun = false,
): Promise<{
    imported: number;
    duplicates: number;
    failed: number;
    total: number;
    format: string;
    errors: string[];
}> {
    const startTime = Date.now();
    const errors: string[] = [];

    // ── Org ownership check ────────────────────────────────
    const account = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId, organizationId: orgId },
        select: { id: true },
    });
    if (!account) throw new Error('Bank account not found for org');

    // ── Parse CSV ──────────────────────────────────────────
    const lines = csvContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter(line => line.trim().length > 0);

    if (lines.length < 2) {
        return { imported: 0, duplicates: 0, failed: 0, total: 0, format: 'unknown', errors: ['CSV file is empty or has no data rows'] };
    }

    // Find header row
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
            errors: [`Unrecognized CSV format. Headers: ${headers.join(', ')}`],
        };
    }

    const dataLines = lines.slice(headerIndex + 1);

    // ── Safety limit: max rows ─────────────────────────────
    if (dataLines.length > MAX_ROWS) {
        return {
            imported: 0, duplicates: 0, failed: 0, total: dataLines.length, format,
            errors: [`Too many rows (${dataLines.length}). Max: ${MAX_ROWS}`],
        };
    }

    // ── Audit: start ───────────────────────────────────────
    await logAudit(orgId, 'csv_import_started', {
        file_name: 'cli-upload',
        row_count_estimate: dataLines.length,
        dry_run: dryRun,
    });

    console.log(`📄 Format: ${format}, ${dataLines.length} data rows, dry_run=${dryRun}`);

    let imported = 0;
    let duplicates = 0;
    let failed = 0;

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

        if (dryRun) {
            console.log(`  [DRY] Row ${i + 1}: ${tx.bookingDate.toISOString().split('T')[0]} | ${tx.amount.toFixed(2)} EUR | ${tx.creditorName || tx.debtorName || '—'}`);
            imported++;
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

    const durationMs = Date.now() - startTime;

    // ── Audit: finish ──────────────────────────────────────
    await logAudit(orgId, 'csv_import_finished', {
        file_name: 'cli-upload',
        rows_imported: imported,
        rows_skipped: duplicates,
        rows_failed: failed,
        duration_ms: durationMs,
        dry_run: dryRun,
    });

    return { imported, duplicates, failed, total: dataLines.length, format, errors };
}

// ── CLI entry ──────────────────────────────────────────────

const args = process.argv.slice(2);
const orgIdx = args.indexOf('--org');
const fileIdx = args.indexOf('--file');
const acctIdx = args.indexOf('--bankAccount');
const dryRun = args.includes('--dry-run');

const orgId = orgIdx > -1 ? args[orgIdx + 1]?.trim() : null;
const filePath = fileIdx > -1 ? args[fileIdx + 1]?.trim() : null;
const bankAccountId = acctIdx > -1 ? args[acctIdx + 1]?.trim() : null;

if (!orgId || !filePath || !bankAccountId) {
    console.error(
        'Usage: npx tsx -r dotenv/config scripts/csv-import.ts'
        + ' --org <orgId>'
        + ' --bankAccount <bankAccountId>'
        + ' --file <path>'
        + ' [--dry-run]',
    );
    process.exit(1);
}

// UUID format validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!UUID_REGEX.test(orgId)) {
    console.error('❌ Invalid --org: must be a valid UUID');
    process.exit(1);
}

if (!UUID_REGEX.test(bankAccountId)) {
    console.error('❌ Invalid --bankAccount: must be a valid UUID');
    process.exit(1);
}

// Secret check
if (!process.env.IMPORT_SECRET) {
    console.error('❌ IMPORT_SECRET env var not set. Aborting.');
    process.exit(1);
}

// Read file
const fs = await import('fs');
const content = fs.readFileSync(filePath, 'utf-8');

// File size check
if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
    console.error(`❌ File too large (${(Buffer.byteLength(content) / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    process.exit(1);
}

if (dryRun) {
    console.log('🔍 DRY RUN — no DB writes will be made\n');
}

console.log(`🏢 Org: ${orgId}`);
console.log(`🏦 Bank Account: ${bankAccountId}`);
console.log(`📁 File: ${filePath}\n`);

importCSVTransactions(orgId, bankAccountId, content, dryRun)
    .then(result => {
        console.log('\n✅ Import complete:');
        console.log(`   Imported:   ${result.imported}`);
        console.log(`   Duplicates: ${result.duplicates}`);
        console.log(`   Failed:     ${result.failed}`);
        console.log(`   Total:      ${result.total}`);
        console.log(`   Format:     ${result.format}`);
        if (result.errors.length > 0) {
            console.log('   Errors:');
            result.errors.forEach(e => console.log(`     - ${e}`));
        }
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Import failed:', err.message);
        process.exit(1);
    })
    .finally(async () => {
        await pool.end();
    });
