import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getOrgContext } from '@/lib/org';
import { getSupabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/db';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const ctx = await getOrgContext();
        const { id: propertyId } = await params;

        const body = await request.json();
        const question = body?.question;
        if (!question || typeof question !== 'string') {
            return NextResponse.json(
                { error: 'question is required' },
                { status: 400 },
            );
        }

        // Verify property belongs to org (public schema → Prisma)
        const property = await prisma.property.findFirst({
            where: { id: propertyId, organizationId: ctx.orgId },
            select: { id: true },
        });

        if (!property) {
            return NextResponse.json(
                { error: 'Property not found' },
                { status: 404 },
            );
        }

        const supabase = getSupabaseAdmin();
        if (!supabase) {
            return NextResponse.json(
                { error: 'Supabase not configured' },
                { status: 500 },
            );
        }

        // Load brain from warehouse.property_intelligence
        const { data: brain } = await supabase
            .from('property_intelligence')
            .select('analysis, is_stale')
            .eq('property_id', propertyId)
            .eq('is_current', true)
            .single();

        if (!brain || brain.is_stale || !brain.analysis) {
            return NextResponse.json({
                answer:
                    'Die Analyse wird gerade aktualisiert. Bitte versuchen Sie es in wenigen Minuten erneut.',
                stale: true,
            });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return NextResponse.json(
                { error: 'ANTHROPIC_API_KEY not configured' },
                { status: 500 },
            );
        }

        const anthropic = new Anthropic({ apiKey });

        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system:
                'Du bist ein Immobilienassistent. Beantworte Fragen basierend auf der Immobilienanalyse. Antworte immer auf Deutsch. Wenn du Dokumente referenzierst, nenne den Dateinamen.',
            messages: [
                {
                    role: 'user',
                    content: `Frage: ${question}\n\nImmobilienanalyse:\n${JSON.stringify(brain.analysis, null, 2)}`,
                },
            ],
        });

        const answer =
            message.content[0].type === 'text' ? message.content[0].text : '';

        return NextResponse.json({ answer, stale: false });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Property chat error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 },
        );
    }
}
