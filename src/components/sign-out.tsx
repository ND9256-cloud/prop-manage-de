
import { signOut } from '@/auth';

export function SignOut() {
    return (
        <form
            action={async () => {
                'use server';
                await signOut();
            }}
        >
            <button className="text-sm font-medium hover:underline text-red-500">
                Sign Out
            </button>
        </form>
    );
}
