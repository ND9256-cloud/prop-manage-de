import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const GENESIS_API_BASE = 'https://www-genesis.destatis.de/genesisWS/rest/2020';

const MONTH_MAP: Record<string, number> = {
    'Januar': 1, 'Februar': 2, 'März': 3, 'April': 4,
    'Mai': 5, 'Juni': 6, 'Juli': 7, 'August': 8,
    'September': 9, 'Oktober': 10, 'November': 11, 'Dezember': 12,
};

export async function GET(request: Request) {
    // Verify cron secret to prevent unauthorized calls
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = process.env.DESTATIS_API_TOKEN;
    if (!token) {
        return NextResponse.json({ error: 'Missing DESTATIS_API_TOKEN' }, { status: 500 });
    }

    try {
        const currentYear = new Date().getFullYear();

        // Fetch previous + current year to handle early-year edge cases
        const body = new URLSearchParams({
            name: '61111-0002',
            startyear: String(currentYear - 1),
            endyear: String(currentYear),
            language: 'de',
            area: 'all',
        });

        const res = await fetch(`${GENESIS_API_BASE}/data/table`, {
            method: 'POST',
            body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'username': token,
                'password': token,
            },
        });

        if (!res.ok) {
            throw new Error(`Destatis API: ${res.status} ${res.statusText}`);
        }

        const json = await res.json();
        if (json.Status?.Code !== 0) {
            throw new Error(`Destatis API: ${json.Status?.Content}`);
        }

        const content: string = json.Object?.Content ?? '';
        let upserted = 0;

        for (const line of content.split('\n')) {
            const match = line.match(/^(\d{4});([^;]+);([\d,]+)/);
            if (!match) continue;

            const year = parseInt(match[1]);
            const monthName = match[2].trim();
            const value = parseFloat(match[3].replace(',', '.'));
            const month = MONTH_MAP[monthName];

            if (month && !isNaN(value)) {
                await prisma.vpiIndex.upsert({
                    where: { year_month: { year, month } },
                    update: { value },
                    create: { year, month, value },
                });
                upserted++;
            }
        }

        // Get the latest entry for confirmation
        const latest = await prisma.vpiIndex.findFirst({
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
        });

        return NextResponse.json({
            ok: true,
            upserted,
            latest: latest
                ? { year: latest.year, month: latest.month, value: latest.value }
                : null,
            fetchedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('VPI update failed:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 },
        );
    }
}
