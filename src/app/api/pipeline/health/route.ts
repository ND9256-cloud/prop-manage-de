import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET() {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
        return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stuckThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // All queries in parallel
    const [jobsRes, failByStageRes, dlqRes, stuckRes, oldestPendingRes] = await Promise.all([
        // Jobs in last 24h grouped by status
        supabase
            .from('processing_jobs')
            .select('status')
            .gte('created_at', since),

        // Failures by stage in last 24h
        supabase
            .from('processing_jobs')
            .select('last_stage')
            .in('status', ['failed', 'dead_letter'])
            .gte('created_at', since),

        // DLQ depth (all time)
        supabase
            .from('processing_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'dead_letter'),

        // Stuck jobs (processing > 10 min)
        supabase
            .from('processing_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'processing')
            .lt('updated_at', stuckThreshold),

        // Oldest queued job
        supabase
            .from('processing_jobs')
            .select('created_at')
            .eq('status', 'queued')
            .order('created_at', { ascending: true })
            .limit(1),
    ]);

    // Count jobs by status
    const jobs = jobsRes.data ?? [];
    const counts = { queued: 0, processing: 0, done: 0, failed: 0, dead_letter: 0 };
    for (const row of jobs) {
        const s = row.status as keyof typeof counts;
        if (s in counts) counts[s]++;
    }
    const total = jobs.length;
    const failRate = total > 0 ? Math.round(((counts.failed + counts.dead_letter) / total) * 1000) / 10 : 0;

    // Failures by stage
    const failuresByStage: Record<string, number> = {};
    for (const row of failByStageRes.data ?? []) {
        const stage = row.last_stage ?? 'unknown';
        failuresByStage[stage] = (failuresByStage[stage] ?? 0) + 1;
    }

    const dlqDepth = dlqRes.count ?? 0;
    const stuckJobs = stuckRes.count ?? 0;

    // Oldest pending age
    const oldestRow = oldestPendingRes.data?.[0];
    const oldestPendingAgeMinutes = oldestRow
        ? Math.round((Date.now() - new Date(oldestRow.created_at).getTime()) / 60000)
        : null;

    const degraded = failRate > 10 || stuckJobs > 0;

    return NextResponse.json({
        status: degraded ? 'degraded' : 'healthy',
        jobs_24h: {
            total,
            done: counts.done,
            failed: counts.failed,
            dead_letter: counts.dead_letter,
            queued: counts.queued,
            processing: counts.processing,
        },
        fail_rate: failRate,
        failures_by_stage: failuresByStage,
        dlq_depth: dlqDepth,
        stuck_jobs: stuckJobs,
        oldest_pending_age_minutes: oldestPendingAgeMinutes,
    });
}
