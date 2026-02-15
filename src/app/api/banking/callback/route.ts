import { NextRequest, NextResponse } from 'next/server';
import { completeBankConnection } from '@/lib/bank-actions';

/**
 * Callback route for Enable Banking.
 * After the user authenticates at their bank, Enable Banking redirects here
 * with `code` and `state` (our connection ID) as query parameters.
 */
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state'); // Our BankConnection ID
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    if (error) {
        console.error('Banking callback error:', error, errorDescription);
        return NextResponse.redirect(
            `${baseUrl}/dashboard/banking?error=${encodeURIComponent(errorDescription || error)}`
        );
    }

    if (!code || !state) {
        return NextResponse.redirect(
            `${baseUrl}/dashboard/banking?error=${encodeURIComponent('Missing code or state parameter')}`
        );
    }

    const result = await completeBankConnection(code, state);

    if (result.success) {
        return NextResponse.redirect(
            `${baseUrl}/dashboard/banking?success=true`
        );
    } else {
        return NextResponse.redirect(
            `${baseUrl}/dashboard/banking?error=${encodeURIComponent(result.error || 'Connection failed')}`
        );
    }
}
