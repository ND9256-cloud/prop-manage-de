/**
 * Fetches VPI (Verbraucherpreisindex) data from Destatis GENESIS API
 * and stores it in the VpiIndex table in Supabase.
 *
 * Usage:
 *   npx tsx scripts/fetch-vpi.ts              # Fetch current year
 *   npx tsx scripts/fetch-vpi.ts 1991 2025    # Fetch specific range
 *   npx tsx scripts/fetch-vpi.ts --all        # Fetch all (1991-current)
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const GENESIS_API_BASE = 'https://www-genesis.destatis.de/genesisWS/rest/2020';
const GENESIS_TOKEN = process.env.DESTATIS_API_TOKEN;

if (!GENESIS_TOKEN) {
    console.error('Missing DESTATIS_API_TOKEN in .env');
    process.exit(1);
}

// German month names to numbers
const MONTH_MAP: Record<string, number> = {
    'Januar': 1, 'Februar': 2, 'März': 3, 'April': 4,
    'Mai': 5, 'Juni': 6, 'Juli': 7, 'August': 8,
    'September': 9, 'Oktober': 10, 'November': 11, 'Dezember': 12,
};

interface VpiEntry {
    year: number;
    month: number;
    value: number;
}

async function fetchVpiFromDestatis(startYear: number, endYear: number): Promise<VpiEntry[]> {
    console.log(`  Fetching VPI ${startYear}-${endYear} from Destatis...`);

    const body = new URLSearchParams({
        name: '61111-0002',
        startyear: String(startYear),
        endyear: String(endYear),
        language: 'de',
        area: 'all',
    });

    const res = await fetch(`${GENESIS_API_BASE}/data/table`, {
        method: 'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'username': GENESIS_TOKEN,
            'password': GENESIS_TOKEN,
        },
    });

    if (!res.ok) {
        throw new Error(`Destatis API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();

    if (json.Status?.Code !== 0) {
        throw new Error(`Destatis API error: ${json.Status?.Content}`);
    }

    const content: string = json.Object?.Content ?? '';
    const entries: VpiEntry[] = [];

    // Parse CSV lines: "2025;Januar;120,3;+2,3;-0,2"
    for (const line of content.split('\n')) {
        const match = line.match(/^(\d{4});([^;]+);([\d,]+)/);
        if (!match) continue;

        const year = parseInt(match[1]);
        const monthName = match[2];
        const value = parseFloat(match[3].replace(',', '.'));
        const month = MONTH_MAP[monthName];

        if (month && !isNaN(value)) {
            entries.push({ year, month, value });
        }
    }

    return entries;
}

async function upsertVpiEntries(entries: VpiEntry[]): Promise<number> {
    let count = 0;
    for (const entry of entries) {
        await prisma.vpiIndex.upsert({
            where: { year_month: { year: entry.year, month: entry.month } },
            update: { value: entry.value },
            create: { year: entry.year, month: entry.month, value: entry.value },
        });
        count++;
    }
    return count;
}

async function main() {
    const args = process.argv.slice(2);
    const currentYear = new Date().getFullYear();

    let startYear: number;
    let endYear: number;

    if (args.includes('--all')) {
        startYear = 1991;
        endYear = currentYear;
    } else if (args.length === 2) {
        startYear = parseInt(args[0]);
        endYear = parseInt(args[1]);
    } else {
        // Default: fetch current year only
        startYear = currentYear;
        endYear = currentYear;
    }

    console.log(`Fetching VPI data from ${startYear} to ${endYear}...`);

    // Fetch in 10-year chunks to avoid API limits
    const allEntries: VpiEntry[] = [];
    for (let y = startYear; y <= endYear; y += 10) {
        const chunkEnd = Math.min(y + 9, endYear);
        const entries = await fetchVpiFromDestatis(y, chunkEnd);
        allEntries.push(...entries);
    }

    console.log(`Fetched ${allEntries.length} VPI entries. Saving to database...`);

    const saved = await upsertVpiEntries(allEntries);
    console.log(`Saved ${saved} VPI entries to database.`);

    // Show latest value
    const latest = await prisma.vpiIndex.findFirst({
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    if (latest) {
        console.log(`\nLatest VPI: ${latest.year}-${String(latest.month).padStart(2, '0')} = ${latest.value}`);
    }

    await prisma.$disconnect();
    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
