'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

interface SavedViewsProps {
    needsReviewCount: number;
    appliedMonthCount: number;
}

export function SavedViews({ needsReviewCount, appliedMonthCount }: SavedViewsProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const currentView = searchParams.get('view') || 'all';

    const setView = useCallback(
        (view: string) => {
            const params = new URLSearchParams();
            if (view !== 'all') {
                params.set('view', view);
            }
            router.push(`?${params.toString()}`);
        },
        [router]
    );

    return (
        <div className="flex items-center gap-2">
            <button
                onClick={() => setView('needs_review')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${currentView === 'needs_review'
                        ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
            >
                Prüfung nötig
                {needsReviewCount > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full px-1 text-xs font-semibold ${currentView === 'needs_review'
                            ? 'bg-amber-800 text-amber-100'
                            : 'bg-muted-foreground/20 text-muted-foreground'
                        }`}>
                        {needsReviewCount}
                    </span>
                )}
            </button>

            <button
                onClick={() => setView('all')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${currentView === 'all'
                        ? 'bg-gray-200 text-gray-900 ring-1 ring-gray-300'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
            >
                Alle Dokumente
            </button>

            <button
                onClick={() => setView('applied_month')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${currentView === 'applied_month'
                        ? 'bg-green-100 text-green-800 ring-1 ring-green-300'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
            >
                Verbucht
                {appliedMonthCount > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full px-1 text-xs font-semibold ${currentView === 'applied_month'
                            ? 'bg-green-800 text-green-100'
                            : 'bg-muted-foreground/20 text-muted-foreground'
                        }`}>
                        {appliedMonthCount}
                    </span>
                )}
            </button>
        </div>
    );
}
