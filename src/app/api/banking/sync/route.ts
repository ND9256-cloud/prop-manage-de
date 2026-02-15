import { NextRequest, NextResponse } from 'next/server';
import { syncAllBankAccounts } from '@/lib/bank-actions';

/**
 * Cron endpoint to sync all bank transactions daily.
 * Protected by CRON_SECRET for Vercel Cron.
 */
export async function POST(request: NextRequest) {
    // Verify cron secret in production
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    try {
        const result = await syncAllBankAccounts();
        return NextResponse.json({
            ok: true,
            synced: result.synced,
            errors: result.errors,
        });
    } catch (error) {
        console.error('Sync cron failed:', error);
        return NextResponse.json(
            { error: 'Sync failed', details: error instanceof Error ? error.message : 'Unknown' },
            { status: 500 }
        );
    }
}
