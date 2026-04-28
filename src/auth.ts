
import NextAuth from 'next-auth';
import { authConfig } from '../auth.config';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';

async function getUser(email: string) {
    try {
        // @tenant-isolation-disable-next-line -- reason: NextAuth credentials login requires user lookup by email before org context is known, cross-tenant by authentication design
        const user = await prisma.user.findUnique({ where: { email } });
        return user;
    } catch (error) {
        console.error('Failed to fetch user:', error);
        throw new Error('Failed to fetch user.');
    }
}

export const { auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            async authorize(credentials) {
                const parsedCredentials = z
                    .object({ email: z.string().email(), password: z.string().min(6) })
                    .safeParse(credentials);

                if (parsedCredentials.success) {
                    const { email, password } = parsedCredentials.data;
                    const user = await getUser(email);
                    if (!user) return null;

                    // Todo: In real app, we need to handle password hashing.
                    // For the seed user, check if password matches simply or is hashed.
                    // Since our seed user didn't have a hashed password set, we might need to reset it.
                    // But 'hashedPassword' is the field. 

                    if (!user.hashedPassword) return null;

                    const passwordsMatch = await bcrypt.compare(password, user.hashedPassword);

                    if (passwordsMatch) return user;
                }

                console.log('Invalid credentials');
                return null;
            },
        }),
    ],
});
