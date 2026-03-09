import { NextRequest, NextResponse } from 'next/server';
import { syncAllBankAccounts } from '@/lib/bank-actions';
import { getSupabaseAdmin } from '@/lib/supabase';

// Stable lock key reserved for: cron_banking_sync_all
// Do not reuse this key for other jobs
const CRON_LOCK_ID = 7829341056;

/**
 * Cron endpoint to sync all bank transactions daily.
 * Protected by CRON_SECRET for Vercel Cron.
 * Uses pg_try_advisory_lock to prevent concurrent runs.
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

    const supabase = getSupabaseAdmin();
    if (!supabase) {
        return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    // Advisory lock — prevents concurrent cron runs
    const { data: lockAcquired } = await supabase.rpc('pg_try_advisory_lock', {
        key: CRON_LOCK_ID,
    });

    if (!lockAcquired) {
        console.log('Cron already running — skipping');
        return NextResponse.json({ status: 'skipped', reason: 'already_running' }, { status: 200 });
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
    } finally {
        // Always release lock
        await supabase.rpc('pg_advisory_unlock', { key: CRON_LOCK_ID });
    }
}
