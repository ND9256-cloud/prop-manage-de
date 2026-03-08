import { t } from '@/lib/i18n/warehouse';

const STATUS_CONFIG: Record<string, { bg: string; text: string; dot: string; label: { de: string; en: string } }> = {
    queued: {
        bg: 'bg-gray-100',
        text: 'text-gray-600',
        dot: 'bg-gray-400',
        label: t.queued,
    },
    processing: {
        bg: 'bg-blue-50',
        text: 'text-blue-600',
        dot: 'bg-blue-500',
        label: t.processing,
    },
    needs_review: {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        dot: 'bg-amber-500',
        label: t.needsReview,
    },
    applied: {
        bg: 'bg-green-50',
        text: 'text-green-700',
        dot: 'bg-green-500',
        label: t.applied,
    },
    failed: {
        bg: 'bg-red-50',
        text: 'text-red-600',
        dot: 'bg-red-500',
        label: t.failed,
    },
    quarantined: {
        bg: 'bg-purple-50',
        text: 'text-purple-700',
        dot: 'bg-purple-500',
        label: t.quarantined,
    },
};

interface StatusBadgeProps {
    status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
    const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.queued;

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${config.bg} ${config.text}`}
        >
            <span
                className={`h-1.5 w-1.5 rounded-full ${config.dot} ${status === 'processing' ? 'animate-pulse' : ''}`}
            />
            {config.label.de}
        </span>
    );
}
