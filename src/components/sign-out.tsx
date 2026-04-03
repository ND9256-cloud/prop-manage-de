
import { signOut } from '@/auth';
import { LogOut } from 'lucide-react';

export function SignOut({ iconOnly = false, variant = 'default' }: { iconOnly?: boolean; variant?: 'default' | 'sidebar' }) {
    if (variant === 'sidebar') {
        return (
            <form
                action={async () => {
                    'use server';
                    await signOut();
                }}
            >
                <button className={`flex items-center gap-3 rounded-md py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 w-full ${iconOnly ? 'justify-center px-0' : 'px-3'}`}>
                    <LogOut className="h-5 w-5 shrink-0 text-red-500" />
                    {!iconOnly && <span className="text-red-500">Abmelden</span>}
                </button>
            </form>
        );
    }

    return (
        <form
            action={async () => {
                'use server';
                await signOut();
            }}
        >
            <button className="text-sm font-medium hover:underline text-red-500">
                Abmelden
            </button>
        </form>
    );
}
