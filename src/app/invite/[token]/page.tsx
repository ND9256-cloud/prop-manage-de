'use client';

import { useEffect, useState, useTransition } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { validateInviteToken, acceptInviteAndSetPassword } from '@/lib/invitation-actions';

export default function InvitePage() {
    const params = useParams();
    const router = useRouter();
    const token = params.token as string;

    const [isPending, startTransition] = useTransition();
    const [status, setStatus] = useState<'loading' | 'valid' | 'error' | 'success'>('loading');
    const [email, setEmail] = useState('');
    const [orgName, setOrgName] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    // Form state
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [formError, setFormError] = useState('');

    useEffect(() => {
        validateInviteToken(token).then((result) => {
            if (result.valid) {
                setStatus('valid');
                setEmail(result.email ?? '');
                setOrgName(result.orgName ?? '');
            } else {
                setStatus('error');
                setErrorMessage(result.error ?? 'Invalid invitation');
            }
        });
    }, [token]);

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setFormError('');

        if (password.length < 8) {
            setFormError('Passwort muss mindestens 8 Zeichen lang sein.');
            return;
        }
        if (password !== confirmPassword) {
            setFormError('Passwörter stimmen nicht überein.');
            return;
        }

        startTransition(async () => {
            const result = await acceptInviteAndSetPassword(token, name, password);
            if (result.success) {
                setStatus('success');
                setTimeout(() => router.push('/login'), 2000);
            } else {
                setFormError(result.error ?? 'Fehler beim Erstellen des Kontos.');
            }
        });
    }

    if (status === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="text-gray-500 text-lg">Einladung wird geprüft…</div>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full text-center">
                    <div className="text-5xl mb-4">❌</div>
                    <h1 className="text-xl font-bold text-gray-900 mb-2">Ungültige Einladung</h1>
                    <p className="text-gray-600">{errorMessage}</p>
                    <a href="/login" className="mt-6 inline-block text-blue-600 hover:underline text-sm">
                        Zum Login →
                    </a>
                </div>
            </div>
        );
    }

    if (status === 'success') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full text-center">
                    <div className="text-5xl mb-4">✅</div>
                    <h1 className="text-xl font-bold text-gray-900 mb-2">Konto erstellt</h1>
                    <p className="text-gray-600">
                        Sie werden zum Login weitergeleitet…
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full">
                <div className="text-center mb-6">
                    <h1 className="text-2xl font-bold text-gray-900">Einladung annehmen</h1>
                    <p className="text-gray-600 mt-2">
                        Sie wurden zu <strong>{orgName}</strong> eingeladen.
                    </p>
                    <p className="text-sm text-gray-500 mt-1">{email}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                            Name
                        </label>
                        <input
                            id="name"
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            placeholder="Ihr vollständiger Name"
                        />
                    </div>

                    <div>
                        <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                            Passwort
                        </label>
                        <input
                            id="password"
                            type="password"
                            required
                            minLength={8}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            placeholder="Mindestens 8 Zeichen"
                        />
                    </div>

                    <div>
                        <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                            Passwort bestätigen
                        </label>
                        <input
                            id="confirmPassword"
                            type="password"
                            required
                            minLength={8}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                    </div>

                    {formError && (
                        <div className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">
                            {formError}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isPending}
                        className="w-full py-2.5 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {isPending ? 'Konto wird erstellt…' : 'Konto erstellen & beitreten'}
                    </button>
                </form>
            </div>
        </div>
    );
}
