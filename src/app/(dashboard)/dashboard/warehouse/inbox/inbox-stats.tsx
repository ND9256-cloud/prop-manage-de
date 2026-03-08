import { bilingual, t } from '@/lib/i18n/warehouse';

interface InboxStatsProps {
    total: number;
    needsReview: number;
    appliedThisMonth: number;
    failed: number;
}

export function InboxStats({ total, needsReview, appliedThisMonth, failed }: InboxStatsProps) {
    const cards = [
        {
            label: bilingual('total'),
            value: total,
            accent: false,
        },
        {
            label: bilingual('needsReview'),
            value: needsReview,
            accent: needsReview > 0,
            accentColor: 'text-amber-600',
        },
        {
            label: bilingual('appliedThisMonth'),
            value: appliedThisMonth,
            accent: false,
        },
        {
            label: bilingual('failed'),
            value: failed,
            accent: failed > 0,
            accentColor: 'text-red-600',
        },
    ];

    return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {cards.map((card) => (
                <div
                    key={card.label}
                    className="rounded-lg border border-border bg-card p-4"
                >
                    <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
                    <p
                        className={`mt-1 text-2xl font-semibold ${card.accent ? card.accentColor : 'text-foreground'
                            }`}
                    >
                        {card.value}
                    </p>
                </div>
            ))}
        </div>
    );
}
