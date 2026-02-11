
import NextAuth from 'next-auth';
import { UserRole } from '@prisma/client';

declare module 'next-auth' {
    interface User {
        role?: UserRole;
        organizationId?: string | null;
    }

    interface Session {
        user: User & {
            role?: UserRole;
            organizationId?: string | null;
        }
    }
}
