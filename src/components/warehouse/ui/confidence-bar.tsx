import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { bilingual, t } from '@/lib/i18n/warehouse';

interface ConfidenceBarProps {
    score: number; // 0-100
}

function getLevel(score: number) {
    if (score >= 95) return { color: 'bg-green-500', label: t.high };
    if (score >= 65) return { color: 'bg-amber-500', label: t.medium };
    return { color: 'bg-red-500', label: t.low };
}

function getLabelColor(score: number) {
    if (score >= 95) return 'text-green-700';
    if (score >= 65) return 'text-amber-700';
    return 'text-red-600';
}

export function ConfidenceBar({ score }: ConfidenceBarProps) {
    const { color, label } = getLevel(score);
    const labelColor = getLabelColor(score);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex w-full min-w-[100px] flex-col gap-1">
                    {/* Progress bar */}
                    <div className="h-1.5 w-full rounded-full bg-muted">
                        <div
                            className={`h-1.5 rounded-full transition-all ${color}`}
                            style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
                        />
                    </div>
                    {/* Percentage + text label */}
                    <div className="flex items-center justify-between">
                        <span className={`text-xs font-medium ${labelColor}`}>
                            {label.de}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {Math.round(score)}%
                        </span>
                    </div>
                </div>
            </TooltipTrigger>
            <TooltipContent>
                <p>{bilingual('confidence')}</p>
            </TooltipContent>
        </Tooltip>
    );
}
