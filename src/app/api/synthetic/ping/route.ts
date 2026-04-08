import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      checked_at: new Date().toISOString(),
      app_version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
