
import { UserRole } from '@prisma/client';

declare module 'next-auth' {
    interface User {
        role?: UserRole;
        organizationId?: string | null;
    }

    interface Session {
        user: {
            id: string;
            email: string;
            name?: string | null;
            role?: UserRole;
            organizationId?: string | null;
        }
    }
}
