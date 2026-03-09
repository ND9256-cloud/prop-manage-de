
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { auth } = NextAuth(authConfig);

// Routes viewers are allowed to access
const VIEWER_ALLOWED_PATHS = [
    '/dashboard/warehouse',   // property list + property pages
    '/invite',                // accept invite
    '/login',                 // auth
    '/privacy',               // legal
    '/terms',                 // legal
];
// TODO: When property_assignments enforcement is added, tighten
// viewer allowlist to specific property routes only.
// Currently /dashboard/warehouse covers /dashboard/warehouse/audit
// which is acceptable since audit data is read-only and org-scoped.

function isViewerAllowed(path: string): boolean {
    return VIEWER_ALLOWED_PATHS.some((allowed) => path.startsWith(allowed));
}

export default auth(function middleware(req: NextRequest) {
    const path = req.nextUrl.pathname;

    // Skip API routes — security enforced in server actions
    if (path.startsWith('/api')) {
        return NextResponse.next();
    }

    // Read role cookie (UX hint only — real enforcement in server actions)
    const roleCookie = req.cookies.get('x-active-role')?.value;

    // Fail open if no cookie — cookie gets set on first dashboard
    // render via getOrgContext() fallback
    if (!roleCookie) {
        return NextResponse.next();
    }

    // Viewer enforcement — redirect to warehouse (their home)
    if (roleCookie === 'viewer' && !isViewerAllowed(path)) {
        return NextResponse.redirect(new URL('/dashboard/warehouse', req.url));
    }

    // Manager enforcement — settings is admin-only (owner + service_operator)
    if (roleCookie === 'manager' && path.startsWith('/dashboard/settings')) {
        return NextResponse.redirect(new URL('/dashboard/warehouse', req.url));
    }

    return NextResponse.next();
});

export const config = {
    matcher: ['/((?!api|_next/static|_next/image|.*\\.png$).*)'],
};
